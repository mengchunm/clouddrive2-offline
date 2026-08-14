import Artplayer from "artplayer";
import SubtitlesOctopus from "libass-wasm";

interface LibassOptions {
	workerUrl: string;
	wasmUrl?: string;
	fallbackFont: string;
	fonts?: string[];
	availableFonts?: Record<string, string>;
	[key: string]: unknown;
}

interface SubtitlesOctopusInstance {
	canvasParent: HTMLElement;
	worker: Worker;
	timeOffset: number;
	freeTrack(): void;
	setTrack(content: string): void;
	setTrackByUrl(url: string): void;
	resize(): void;
	dispose(): void;
}

type SubtitlesOctopusConstructor = new (
	options: Record<string, unknown>,
) => SubtitlesOctopusInstance;

const Octopus = SubtitlesOctopus as unknown as SubtitlesOctopusConstructor;
const DEFAULT_ASS = "[Script Info]\nScriptType: v4.00+";
const workerBlobUrls = new Map<string, Promise<string>>();

function absoluteUrl(url: string): string {
	return new URL(url, document.baseURI).toString();
}

/**
 * A content script has the web page's origin for Worker entry checks. Fetch the
 * packaged worker and give it a same-origin blob entry while keeping WASM/font
 * URLs pointed at the extension package.
 */
function contentScriptWorkerUrl(
	url: string,
	wasmUrl?: string,
): Promise<string> {
	const absolute = absoluteUrl(url);
	if (new URL(absolute).origin === window.location.origin) {
		return Promise.resolve(absolute);
	}
	const absoluteWasm = wasmUrl ? absoluteUrl(wasmUrl) : undefined;
	const cacheKey = `${absolute}\n${absoluteWasm ?? ""}`;
	let pending = workerBlobUrls.get(cacheKey);
	if (!pending) {
		pending = Promise.all([
			fetch(absolute).then((response) => {
				if (!response.ok) {
					throw new Error(`无法读取内置 libass Worker (${response.status})`);
				}
				return response.text();
			}),
			absoluteWasm
				? fetch(absoluteWasm).then((response) => {
						if (!response.ok) {
							throw new Error(`无法读取内置 libass WASM (${response.status})`);
						}
						return response.arrayBuffer();
					})
				: Promise.resolve<ArrayBuffer | null>(null),
		])
			.then(([source, wasm]) => {
				const wasmBlobUrl = wasm
					? URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }))
					: undefined;
				// Emscripten resolves a relative WASM path against the web page when
				// its Worker entry is a blob URL. Pin it to the packaged WASM blob.
				const bootstrap = wasmBlobUrl
					? `var Module={locateFile:function(path){return path.endsWith(".wasm")?${JSON.stringify(wasmBlobUrl)}:path;}};\n`
					: "";
				return URL.createObjectURL(
					new Blob([bootstrap, source], { type: "application/javascript" }),
				);
			})
			.catch((error) => {
				workerBlobUrls.delete(cacheKey);
				throw error;
			});
		workerBlobUrls.set(cacheKey, pending);
	}
	return pending;
}

/** MV3 版本直接启动扩展内 worker，避免第三方插件创建 CSP 不允许的 Blob Worker。 */
export default function extensionLibassPlugin(options: LibassOptions) {
	return (art: Artplayer) => {
		let libass: SubtitlesOctopusInstance | null = null;
		let initPromise: Promise<void> | null = null;
		let destroyed = false;
		let listenersAdded = false;
		let currentType: "ass" | "webvtt" = "webvtt";
		let assRendererOperational = false;
		let workerRenderListener: ((event: MessageEvent) => void) | null = null;
		const webvtt = art.template.$subtitle;

		const setVttVisible = (visible: boolean) => {
			if (visible) {
				webvtt.style.removeProperty("display");
				webvtt.style.removeProperty("visibility");
				webvtt.style.visibility = "visible";
				return;
			}
			// ArtPlayer updates the native cue element on every subtitle line and can
			// overwrite ordinary visibility. Keep the fallback layer hard-disabled
			// after libass proves it is rendering to avoid per-cue flashes.
			webvtt.style.setProperty("display", "none", "important");
			webvtt.style.setProperty("visibility", "hidden", "important");
		};
		const setVisible = (visible: boolean) => {
			setVttVisible(
				visible && (currentType !== "ass" || !assRendererOperational),
			);
			if (!libass?.canvasParent) return;
			libass.canvasParent.style.display = visible ? "block" : "none";
			if (visible) libass.resize();
		};
		const hide = () => setVisible(false);
		const show = () => setVisible(true);
		const switchSubtitle = async (url: string, content?: string) => {
			await init();
			if (!libass) throw new Error("ASS 字幕渲染器初始化失败");
			if (
				url &&
				(content !== undefined ||
					["ass", "ssa"].includes(Artplayer.utils.getExt(url)))
			) {
				currentType = "ass";
				libass.freeTrack();
				if (content !== undefined) libass.setTrack(content);
				else libass.setTrackByUrl(absoluteUrl(url));
				setVisible(art.subtitle.show);
				return;
			}
			currentType = "webvtt";
			setVisible(false);
			libass.freeTrack();
		};
		const setOffset = (offset: number) => {
			if (libass) libass.timeOffset = offset;
		};
		const destroy = () => {
			destroyed = true;
			if (listenersAdded) {
				art.off("subtitle", setVisible);
				art.off("subtitleOffset", setOffset);
			}
			if (libass?.worker && workerRenderListener) {
				libass.worker.removeEventListener("message", workerRenderListener);
			}
			libass?.dispose();
			libass = null;
			initPromise = null;
		};
		const init = (): Promise<void> => {
			if (libass) return Promise.resolve();
			if (initPromise) return initPromise;
			if (destroyed) return Promise.reject(new Error("播放器已经销毁"));
			initPromise = contentScriptWorkerUrl(options.workerUrl, options.wasmUrl)
				.then(
					(workerUrl) =>
						new Promise<void>((resolve, reject) => {
							try {
								if (destroyed) throw new Error("播放器已经销毁");
								const availableFonts = options.availableFonts
									? Object.fromEntries(
											Object.entries(options.availableFonts).map(
												([name, url]) => [name, absoluteUrl(url)],
											),
										)
									: undefined;
								libass = new Octopus({
									...options,
									subContent: DEFAULT_ASS,
									video: art.template.$video,
									workerUrl,
									fallbackFont: absoluteUrl(options.fallbackFont),
									fonts: options.fonts?.map(absoluteUrl),
									availableFonts,
									onReady: resolve,
									onError: (error: unknown) =>
										reject(
											error instanceof Error
												? error
												: new Error(`libass Worker 错误: ${String(error)}`),
										),
								});
								if (!libass.canvasParent) {
									throw new Error("libass 未创建字幕画布");
								}
								libass.canvasParent.className = "artplayer-plugin-libass";
								libass.canvasParent.style.cssText =
									"position:absolute;inset:0;width:100%;height:100%;user-select:none;pointer-events:none;z-index:20";
								workerRenderListener = (event: MessageEvent) => {
									const data = event.data as {
										target?: string;
										op?: string;
										canvases?: unknown[];
										bitmaps?: unknown[];
									};
									if (
										currentType === "ass" &&
										data.target === "canvas" &&
										(data.op === "renderCanvas" ||
											data.op === "renderFastCanvas") &&
										((data.canvases?.length ?? 0) > 0 ||
											(data.bitmaps?.length ?? 0) > 0)
									) {
										assRendererOperational = true;
										setVttVisible(false);
									}
								};
								libass.worker.addEventListener("message", workerRenderListener);
								if (!listenersAdded) {
									art.on("subtitle", setVisible);
									art.on("subtitleOffset", setOffset);
									art.once("destroy", destroy);
									listenersAdded = true;
								}
							} catch (error) {
								reject(error);
							}
						}),
				)
				.catch((error) => {
					libass?.dispose();
					libass = null;
					initPromise = null;
					throw error;
				});
			return initPromise;
		};

		void init().catch((error) =>
			console.error("[cd2-artplayer] ASS 字幕渲染器初始化失败:", error),
		);
		return {
			name: "artplayerPluginLibass" as const,
			get libass() {
				return libass;
			},
			get visible() {
				return libass?.canvasParent.style.display !== "none";
			},
			get rendered() {
				return assRendererOperational;
			},
			init,
			ready: init,
			switch: switchSubtitle,
			show,
			hide,
			destroy,
		};
	};
}
