import type { Rotation, VideoSample } from "mediabunny";
import {
	Input,
	MATROSKA,
	MP4,
	MPEG_TS,
	QTFF,
	UrlSource,
	VideoSampleSink,
	WEBM,
} from "mediabunny";
import { gmFetchAdapter } from "../../../artplayer/src/danmu-api";
import { fetchBinaryRange } from "./media-range";

type VideoDecoderMode = "native" | "software" | "hardware";
type VideoAcceleration =
	| "no-preference"
	| "prefer-hardware"
	| "prefer-software";

interface VideoRendererOpenDetail {
	video: HTMLVideoElement;
	container: HTMLElement;
	videoUrl: string;
	fileSize?: number;
	mode: VideoDecoderMode;
	sessionNonce: number;
}

interface VideoRendererSetDetail {
	mode: VideoDecoderMode;
	sessionNonce: number;
}

interface VideoRendererCloseDetail {
	sessionNonce: number;
}

interface RenderedVideoFrame {
	canvas: HTMLCanvasElement;
	timestamp: number;
	duration: number;
}

const VIDEO_RENDERER_STATUS_EVENT = "cd2-video-renderer-status";
const VIDEO_CACHE_SIZE = 64 * 1024 * 1024;
const VIDEO_RANGE_SIZE = 1024 * 1024;
const VIDEO_FETCH_PARALLELISM = 4;
const VIDEO_RANGE_TIMEOUT_MS = 60_000;
const VIDEO_FIRST_FRAME_TIMEOUT_MS = 15_000;
const VIDEO_FRAME_WATCHDOG_INTERVAL_MS = 500;
const VIDEO_FRAME_STALL_THRESHOLD_SECONDS = 1.25;
const VIDEO_FRAME_LATE_THRESHOLD_SECONDS = 0.25;
const VIDEO_CLOCK_POLL_INTERVAL_MS = 16;
const VIDEO_INPUT_FORMATS = [MATROSKA, MP4, MPEG_TS, QTFF, WEBM];

type VideoRendererState = "starting" | "ready" | "error" | "closed";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dispatchStatus(
	detail: VideoRendererOpenDetail,
	state: VideoRendererState,
	error?: unknown,
	effectiveAcceleration?: VideoAcceleration,
): void {
	window.dispatchEvent(
		new CustomEvent(VIDEO_RENDERER_STATUS_EVENT, {
			detail: {
				mode: detail.mode,
				sessionNonce: detail.sessionNonce,
				state,
				error: error === undefined ? undefined : errorMessage(error),
				effectiveAcceleration,
			},
		}),
	);
}

function getRequestUrl(input: RequestInfo | URL): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return input;
}

function getRequestHeader(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	name: string,
): string | null {
	const requestHeaders = input instanceof Request ? input.headers : undefined;
	const headers = new Headers(requestHeaders);
	if (init?.headers) {
		new Headers(init.headers).forEach((value, key) => {
			headers.set(key, value);
		});
	}
	return headers.get(name);
}

function parseByteRange(
	value: string | null,
): { start: number; end: number | null } | null {
	const match = value?.trim().match(/^bytes=(\d+)-(\d*)$/i);
	if (!match) return null;
	const start = Number(match[1]);
	const end = match[2] ? Number(match[2]) : null;
	if (
		!Number.isSafeInteger(start) ||
		(end !== null && !Number.isSafeInteger(end))
	) {
		return null;
	}
	if (end !== null && end < start) return null;
	return { start, end };
}

function headersFromText(value: string): Headers {
	const headers = new Headers();
	for (const line of value.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		try {
			headers.append(
				line.slice(0, separator).trim(),
				line.slice(separator + 1).trim(),
			);
		} catch {
			// Ignore malformed optional headers. Content-Range is supplied by the
			// range host and is parsed by Mediabunny from the remaining headers.
		}
	}
	return headers;
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted", "AbortError");
}

/**
 * Makes a promise observe the AbortSignal used by Mediabunny. The range host
 * may finish the underlying request and populate its cache after a seek; the
 * consumer must nevertheless stop waiting as soon as Input.dispose() aborts.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

/**
 * Mediabunny's UrlSource normally asks for `bytes=start-`. Translating that
 * request to the extension Range Host gives the video decoder the same 1 MiB
 * aligned cache as audio and subtitles, while retaining Mediabunny's 64 MiB
 * read-ahead/cache policy. The direct and GM paths are kept for pages where
 * the extension host cannot be created.
 */
async function fetchWithExtensionFallback(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	if (init?.signal?.aborted) throw abortError();
	const sourceUrl = getRequestUrl(input);
	const byteRange = parseByteRange(getRequestHeader(input, init, "Range"));
	if (byteRange && /^https?:\/\//i.test(sourceUrl)) {
		const end =
			byteRange.end ??
			Math.min(Number.MAX_SAFE_INTEGER, byteRange.start + VIDEO_RANGE_SIZE - 1);
		try {
			const range = await abortable(
				fetchBinaryRange(
					sourceUrl,
					byteRange.start,
					end,
					VIDEO_RANGE_TIMEOUT_MS,
					"normal",
				),
				init?.signal ?? undefined,
			);
			return new Response(range.data, {
				status: range.status || 206,
				headers: headersFromText(range.headers),
			});
		} catch (rangeError) {
			if (init?.signal?.aborted) throw abortError();
			console.warn(
				"[cd2-video-renderer] 扩展 Range 主机不可用，回退直连请求:",
				rangeError,
			);
		}
	}

	try {
		const response = await fetch(input, init);
		if (response.status === 401 || response.status === 403) {
			return await gmFetchAdapter(input, init);
		}
		return response;
	} catch (directError) {
		if (init?.signal?.aborted) throw abortError();
		try {
			return await gmFetchAdapter(input, init);
		} catch (proxyError) {
			throw new Error(
				`视频 Range 请求失败: ${errorMessage(directError)}; ${errorMessage(proxyError)}`,
			);
		}
	}
}

class PipelineCanceledError extends Error {
	constructor() {
		super("视频解码流水线已取消");
		this.name = "PipelineCanceledError";
	}
}

function isPipelineCanceled(error: unknown): boolean {
	return error instanceof PipelineCanceledError;
}

class WebCodecsVideoRenderer {
	private readonly detail: VideoRendererOpenDetail;
	private input: Input | null = null;
	private displayCanvases = new Set<HTMLCanvasElement>();
	private presentationCanvas: HTMLCanvasElement | null = null;
	private presentation2dContext: CanvasRenderingContext2D | null = null;
	private bitmapContext: ImageBitmapRenderingContext | null = null;
	private renderCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;
	private renderContext:
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null = null;
	private disposed = false;
	private ready = false;
	private customVideoVisible = false;
	private lastPresentedPlaybackTime = -1;
	private lastPresentedWallClock = 0;
	private frameWatchdogTimer = 0;
	private originalVideoOpacity: string;
	private originalVideoVisibility: string;
	private effectiveAcceleration: VideoAcceleration | undefined;
	private pipelineGeneration = 0;
	private cancelPipelineWait: (() => void) | null = null;
	private clockWaiters = new Set<() => void>();
	private seekRestartTimer = 0;
	private restartPromise: Promise<void> | null = null;
	private seekPending = false;
	private eventsBound = false;

	private readonly onSeeking = () => {
		if (this.disposed) return;
		this.seekPending = true;
		this.showNativeVideo();
		this.stopPipeline();
	};

	private readonly onSeeked = () => {
		if (this.disposed || !this.ready) return;
		this.scheduleSeekRestart();
	};

	constructor(detail: VideoRendererOpenDetail) {
		this.detail = detail;
		this.originalVideoOpacity = detail.video.style.opacity;
		this.originalVideoVisibility = detail.video.style.visibility;
	}

	async start(): Promise<boolean> {
		if (this.disposed) return false;
		this.bindVideoEvents();
		dispatchStatus(this.detail, "starting");
		try {
			// A restore-time seek can happen while the first frame is still being
			// decoded. Cancel that attempt and start at the final seek position
			// instead of waiting for a stale keyframe decode to finish.
			while (!this.disposed) {
				try {
					await this.startPipeline();
					return true;
				} catch (error) {
					if (!isPipelineCanceled(error) || !this.seekPending) throw error;
					await this.waitForSeeked();
					this.seekPending = false;
				}
			}
			return false;
		} catch (error) {
			if (!this.disposed) {
				dispatchStatus(this.detail, "error", error);
				console.warn(
					"[cd2-video-renderer] 自定义视频解码器不可用，保留原生播放器:",
					error,
				);
			}
			this.dispose();
			return false;
		}
	}

	private bindVideoEvents(): void {
		if (this.eventsBound) return;
		this.eventsBound = true;
		this.detail.video.addEventListener("seeking", this.onSeeking);
		this.detail.video.addEventListener("seeked", this.onSeeked);
	}

	private unbindVideoEvents(): void {
		if (!this.eventsBound) return;
		this.eventsBound = false;
		this.detail.video.removeEventListener("seeking", this.onSeeking);
		this.detail.video.removeEventListener("seeked", this.onSeeked);
	}

	private accelerationCandidates(): VideoAcceleration[] {
		if (this.detail.mode === "hardware") {
			return ["prefer-hardware", "no-preference", "prefer-software"];
		}
		return ["prefer-software", "no-preference", "prefer-hardware"];
	}

	private async startPipeline(): Promise<void> {
		this.stopPipeline();
		let lastError: unknown = new Error("没有可用的视频解码器");
		for (const acceleration of this.accelerationCandidates()) {
			if (this.disposed) throw new PipelineCanceledError();
			const generation = this.pipelineGeneration;
			try {
				await this.startCandidate(acceleration, generation);
				this.effectiveAcceleration = acceleration;
				if (acceleration !== this.accelerationCandidates()[0]) {
					console.info(
						`[cd2-video-renderer] ${this.detail.mode} 解码偏好不可用，改用 ${acceleration}`,
					);
				}
				return;
			} catch (error) {
				lastError = error;
				if (isPipelineCanceled(error)) throw error;
				this.stopPipeline();
			}
		}
		throw lastError;
	}

	private async startCandidate(
		acceleration: VideoAcceleration,
		generation: number,
	): Promise<void> {
		if (typeof VideoDecoder === "undefined") {
			throw new Error("当前浏览器不支持 WebCodecs VideoDecoder");
		}
		const source = new UrlSource(this.detail.videoUrl, {
			maxCacheSize: VIDEO_CACHE_SIZE,
			parallelism: VIDEO_FETCH_PARALLELISM,
			requestInit: {
				cache: "no-store",
				credentials: "omit",
			},
			fetchFn: fetchWithExtensionFallback,
		});
		const input = new Input({ source, formats: VIDEO_INPUT_FORMATS });
		this.input = input;
		try {
			if (!(await input.canRead())) {
				throw new Error("WebCodecs 无法识别该视频容器");
			}
			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) throw new Error("媒体中没有视频轨道");
			if (!(await videoTrack.canDecode())) {
				throw new Error("WebCodecs 无法解码该视频轨道");
			}
			const decoderConfig = await videoTrack.getDecoderConfig();
			if (!decoderConfig) throw new Error("视频轨道缺少 WebCodecs 配置");
			if (typeof VideoDecoder.isConfigSupported === "function") {
				const support = await VideoDecoder.isConfigSupported({
					...decoderConfig,
					hardwareAcceleration: acceleration,
				});
				if (!support.supported) {
					throw new Error(`浏览器不支持 ${acceleration} 视频解码配置`);
				}
			}

			if (this.disposed || generation !== this.pipelineGeneration) {
				throw new PipelineCanceledError();
			}
			const rotation = await videoTrack.getRotation();
			const squarePixelWidth = await videoTrack.getSquarePixelWidth();
			const squarePixelHeight = await videoTrack.getSquarePixelHeight();
			const [canvasWidth, canvasHeight] =
				rotation % 180 === 0
					? [squarePixelWidth, squarePixelHeight]
					: [squarePixelHeight, squarePixelWidth];
			const sink = new VideoSampleSink(videoTrack, {
				hardwareAcceleration: acceleration,
			});
			let firstFrameSettled = false;
			let resolveFirstFrame!: () => void;
			let rejectFirstFrame!: (error: unknown) => void;
			const firstFrame = new Promise<void>((resolve, reject) => {
				resolveFirstFrame = () => {
					if (firstFrameSettled) return;
					firstFrameSettled = true;
					resolve();
				};
				rejectFirstFrame = (error: unknown) => {
					if (firstFrameSettled) return;
					firstFrameSettled = true;
					reject(error);
				};
			});
			this.cancelPipelineWait = () =>
				rejectFirstFrame(new PipelineCanceledError());
			void this.consumeFrames(
				sink,
				generation,
				resolveFirstFrame,
				rejectFirstFrame,
				acceleration,
				rotation,
				canvasWidth,
				canvasHeight,
			);

			let firstFrameTimeout = 0;
			try {
				await Promise.race([
					firstFrame,
					new Promise<never>((_, reject) => {
						firstFrameTimeout = window.setTimeout(
							() => reject(new Error("视频解码首帧超时")),
							VIDEO_FIRST_FRAME_TIMEOUT_MS,
						);
					}),
				]);
			} finally {
				window.clearTimeout(firstFrameTimeout);
			}
			if (this.cancelPipelineWait) this.cancelPipelineWait = null;
		} finally {
			if (this.cancelPipelineWait && this.input === input) {
				this.cancelPipelineWait = null;
			}
			if (this.input === input && generation !== this.pipelineGeneration) {
				this.input = null;
				try {
					input.dispose();
				} catch {
					// Disposing an already aborted input is best-effort.
				}
			}
		}
	}

	private async consumeFrames(
		sink: VideoSampleSink,
		generation: number,
		resolveFirstFrame: () => void,
		rejectFirstFrame: (error: unknown) => void,
		acceleration: VideoAcceleration,
		rotation: Rotation,
		canvasWidth: number,
		canvasHeight: number,
	): Promise<void> {
		let gotFrame = false;
		const startTimestamp = Number.isFinite(this.detail.video.currentTime)
			? Math.max(0, this.detail.video.currentTime)
			: 0;
		try {
			// Use the sequential sample sink instead of requesting one sparse sample
			// for every animation frame. It lets Mediabunny keep a small decode queue
			// and, more importantly, gives us an explicit close() boundary for every
			// VideoSample before waiting for the native clock.
			for await (const sample of sink.samples(startTimestamp)) {
				if (this.disposed || generation !== this.pipelineGeneration) {
					sample.close();
					return;
				}
				let frame: RenderedVideoFrame | null = null;
				try {
					const sampleTimestamp = sample.timestamp;
					if (gotFrame) {
						const currentTime = this.detail.video.currentTime;
						if (
							Number.isFinite(currentTime) &&
							sampleTimestamp + VIDEO_FRAME_LATE_THRESHOLD_SECONDS < currentTime
						) {
							continue;
						}
						if (
							!(await this.waitForFrameTimestamp(sampleTimestamp, generation))
						) {
							return;
						}
						const timeAfterWait = this.detail.video.currentTime;
						if (
							Number.isFinite(timeAfterWait) &&
							sampleTimestamp + VIDEO_FRAME_LATE_THRESHOLD_SECONDS <
								timeAfterWait
						) {
							continue;
						}
					}
					frame = this.renderSample(
						sample,
						rotation,
						canvasWidth,
						canvasHeight,
					);
				} finally {
					if (!frame) sample.close();
				}
				if (!frame || this.disposed || generation !== this.pipelineGeneration) {
					return;
				}
				this.attachCanvas(frame.canvas);
				this.lastPresentedPlaybackTime = frame.timestamp;
				this.lastPresentedWallClock = performance.now();
				if (!gotFrame) {
					gotFrame = true;
					this.presentCustomVideo(acceleration);
					resolveFirstFrame();
				}
			}
			if (
				!gotFrame &&
				!this.disposed &&
				generation === this.pipelineGeneration
			) {
				rejectFirstFrame(new Error("视频解码器未返回视频帧"));
			}
		} catch (error) {
			if (this.disposed || generation !== this.pipelineGeneration) return;
			if (!gotFrame) {
				rejectFirstFrame(error);
				return;
			}
			this.handleRuntimeFailure(error);
		}
	}

	private renderSample(
		sample: VideoSample,
		rotation: Rotation,
		canvasWidth: number,
		canvasHeight: number,
	): RenderedVideoFrame {
		const timestamp = sample.timestamp;
		const duration = sample.duration;
		const width = Math.max(1, Math.round(canvasWidth));
		const height = Math.max(1, Math.round(canvasHeight));
		try {
			this.ensureRenderSurface(width, height);
			const context = this.renderContext;
			if (!context) throw new Error("无法创建视频 Canvas 2D 上下文");
			context.resetTransform();
			context.clearRect(0, 0, width, height);
			sample.drawWithFit(context, { fit: "contain", rotation });
			this.presentRenderSurface();
		} finally {
			// VideoSample owns the decoded VideoFrame. Closing it after the draw is
			// mandatory; leaving it to FinalizationRegistry causes decoder stalls.
			sample.close();
		}
		if (!this.presentationCanvas) {
			throw new Error("视频画面 Canvas 尚未创建");
		}
		return {
			canvas: this.presentationCanvas,
			timestamp,
			duration,
		};
	}

	private ensureRenderSurface(width: number, height: number): void {
		if (
			this.presentationCanvas &&
			this.presentationCanvas.width === width &&
			this.presentationCanvas.height === height &&
			this.renderCanvas &&
			this.renderContext
		) {
			return;
		}
		const presentationCanvas = document.createElement("canvas");
		presentationCanvas.width = width;
		presentationCanvas.height = height;
		let bitmapContext: ImageBitmapRenderingContext | null = null;
		let renderCanvas: OffscreenCanvas | HTMLCanvasElement;
		if (typeof OffscreenCanvas !== "undefined") {
			renderCanvas = new OffscreenCanvas(width, height);
			bitmapContext = presentationCanvas.getContext("bitmaprenderer");
		} else {
			renderCanvas = document.createElement("canvas");
			renderCanvas.width = width;
			renderCanvas.height = height;
		}
		const renderContext = renderCanvas.getContext("2d", {
			alpha: false,
			desynchronized: true,
		});
		if (!renderContext) throw new Error("无法创建视频渲染 Canvas 2D 上下文");
		const presentation2dContext = bitmapContext
			? null
			: presentationCanvas.getContext("2d", {
					alpha: false,
					desynchronized: true,
				});
		if (!bitmapContext && !presentation2dContext) {
			throw new Error("无法创建视频显示 Canvas 上下文");
		}
		this.presentationCanvas = presentationCanvas;
		this.presentation2dContext = presentation2dContext;
		this.bitmapContext = bitmapContext;
		this.renderCanvas = renderCanvas;
		this.renderContext = renderContext;
	}

	private presentRenderSurface(): void {
		if (
			this.bitmapContext &&
			typeof OffscreenCanvas !== "undefined" &&
			this.renderCanvas instanceof OffscreenCanvas
		) {
			const bitmap = this.renderCanvas.transferToImageBitmap();
			this.bitmapContext.transferFromImageBitmap(bitmap);
			return;
		}
		if (!this.presentation2dContext || !this.renderCanvas) {
			throw new Error("视频显示 Canvas 尚未准备好");
		}
		this.presentation2dContext.resetTransform();
		this.presentation2dContext.clearRect(
			0,
			0,
			this.presentation2dContext.canvas.width,
			this.presentation2dContext.canvas.height,
		);
		this.presentation2dContext.drawImage(this.renderCanvas, 0, 0);
	}

	private async waitForFrameTimestamp(
		timestamp: number,
		generation: number,
	): Promise<boolean> {
		while (!this.disposed && generation === this.pipelineGeneration) {
			const currentTime = this.detail.video.currentTime;
			if (!Number.isFinite(currentTime) || timestamp <= currentTime + 0.02) {
				return true;
			}
			await this.waitForClockTick();
		}
		return false;
	}

	private attachCanvas(canvas: HTMLCanvasElement): void {
		if (this.displayCanvases.has(canvas)) return;
		canvas.setAttribute("aria-hidden", "true");
		canvas.dataset.cd2VideoRenderer = this.detail.mode;
		canvas.style.cssText =
			"position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:12;opacity:0;pointer-events:none;background:#000";
		const subtitle = this.detail.container.querySelector(".art-subtitle");
		this.detail.container.insertBefore(canvas, subtitle);
		this.displayCanvases.add(canvas);
	}

	private presentCustomVideo(acceleration: VideoAcceleration): void {
		if (!this.ready) {
			this.ready = true;
			dispatchStatus(this.detail, "ready", undefined, acceleration);
		}
		this.customVideoVisible = true;
		if (this.presentationCanvas) this.presentationCanvas.style.opacity = "1";
		this.detail.video.style.opacity = "0";
		this.detail.video.style.visibility = "visible";
		if (this.frameWatchdogTimer === 0) {
			this.frameWatchdogTimer = window.setInterval(
				() => this.checkFrameWatchdog(),
				VIDEO_FRAME_WATCHDOG_INTERVAL_MS,
			);
		}
	}

	private showNativeVideo(): void {
		this.customVideoVisible = false;
		this.detail.video.style.opacity = this.originalVideoOpacity;
		this.detail.video.style.visibility = this.originalVideoVisibility;
	}

	private checkFrameWatchdog(): void {
		if (
			!this.customVideoVisible ||
			this.disposed ||
			this.detail.video.paused ||
			this.detail.video.seeking ||
			this.lastPresentedPlaybackTime < 0 ||
			this.lastPresentedWallClock <= 0
		)
			return;
		const currentTime = this.detail.video.currentTime;
		const playbackRate = Math.max(0.5, this.detail.video.playbackRate || 1);
		const threshold = Math.max(
			VIDEO_FRAME_STALL_THRESHOLD_SECONDS,
			VIDEO_FRAME_STALL_THRESHOLD_SECONDS * playbackRate,
		);
		if (
			Number.isFinite(currentTime) &&
			currentTime - this.lastPresentedPlaybackTime > threshold &&
			performance.now() - this.lastPresentedWallClock > threshold * 1000
		) {
			this.handleRuntimeFailure(
				new Error("自定义视频解码帧停滞，已回退浏览器原生解码"),
			);
		}
	}

	private waitForClockTick(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		const video = this.detail.video;
		if (video.paused && !video.seeking) {
			return new Promise((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					video.removeEventListener("play", finish);
					video.removeEventListener("seeking", finish);
					this.clockWaiters.delete(finish);
					resolve();
				};
				video.addEventListener("play", finish, { once: true });
				video.addEventListener("seeking", finish, { once: true });
				this.clockWaiters.add(finish);
			});
		}

		// Do not use requestVideoFrameCallback or requestAnimationFrame here. The
		// native element is only the clock/audio carrier in custom mode; tying the
		// decoder to the native compositor would reproduce the GPU stalls this path
		// is meant to avoid. A short timer also keeps playback progressing in a
		// background tab where rAF is heavily throttled.
		return new Promise((resolve) => {
			let done = false;
			let timer = 0;
			const finish = () => {
				if (done) return;
				done = true;
				window.clearTimeout(timer);
				this.clockWaiters.delete(finish);
				resolve();
			};
			this.clockWaiters.add(finish);
			timer = window.setTimeout(finish, VIDEO_CLOCK_POLL_INTERVAL_MS);
		});
	}

	private stopPipeline(): void {
		this.pipelineGeneration += 1;
		this.customVideoVisible = false;
		if (this.frameWatchdogTimer !== 0) {
			window.clearInterval(this.frameWatchdogTimer);
			this.frameWatchdogTimer = 0;
		}
		this.lastPresentedPlaybackTime = -1;
		this.lastPresentedWallClock = 0;
		this.cancelPipelineWait?.();
		this.cancelPipelineWait = null;
		for (const wake of this.clockWaiters) wake();
		this.clockWaiters.clear();
		try {
			this.input?.dispose();
		} catch {
			// Input.dispose() is best-effort during player teardown or a seek.
		}
		this.input = null;
		this.removeDisplayCanvases();
	}

	private removeDisplayCanvases(): void {
		for (const canvas of this.displayCanvases) canvas.remove();
		this.displayCanvases.clear();
		this.presentationCanvas = null;
		this.presentation2dContext = null;
		this.bitmapContext = null;
		this.renderCanvas = null;
		this.renderContext = null;
	}

	private waitForSeeked(): Promise<void> {
		if (!this.detail.video.seeking) return Promise.resolve();
		return new Promise((resolve) => {
			this.detail.video.addEventListener("seeked", () => resolve(), {
				once: true,
			});
		});
	}

	private scheduleSeekRestart(): void {
		window.clearTimeout(this.seekRestartTimer);
		this.seekRestartTimer = window.setTimeout(() => {
			this.seekRestartTimer = 0;
			void this.restartAfterSeek();
		}, 0);
	}

	private async restartAfterSeek(): Promise<void> {
		if (this.disposed || !this.ready || this.restartPromise) return;
		this.restartPromise = (async () => {
			this.seekPending = false;
			try {
				await this.startPipeline();
			} catch (error) {
				if (this.disposed || this.seekPending || isPipelineCanceled(error))
					return;
				this.handleRuntimeFailure(error);
			}
		})().finally(() => {
			this.restartPromise = null;
			if (this.seekPending && !this.disposed && !this.detail.video.seeking) {
				this.scheduleSeekRestart();
			}
		});
		await this.restartPromise;
	}

	private handleRuntimeFailure(error: unknown): void {
		if (this.disposed) return;
		console.warn("[cd2-video-renderer] 视频解码失败，回退原生播放器:", error);
		this.stopPipeline();
		this.showNativeVideo();
		dispatchStatus(this.detail, "error", error, this.effectiveAcceleration);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		window.clearTimeout(this.seekRestartTimer);
		this.unbindVideoEvents();
		this.stopPipeline();
		this.showNativeVideo();
		dispatchStatus(this.detail, "closed");
	}
}

let activeRenderer: WebCodecsVideoRenderer | null = null;
let activeDetail: VideoRendererOpenDetail | null = null;
let registered = false;

function isCurrentSession(sessionNonce: number): boolean {
	return activeDetail?.sessionNonce === sessionNonce;
}

async function activateRenderer(
	detail: VideoRendererOpenDetail,
): Promise<void> {
	activeRenderer?.dispose();
	activeRenderer = null;
	activeDetail = detail;
	if (detail.mode === "native") return;

	const renderer = new WebCodecsVideoRenderer(detail);
	activeRenderer = renderer;
	const started = await renderer.start();
	if (activeRenderer !== renderer || activeDetail !== detail) {
		renderer.dispose();
	} else if (!started) {
		activeRenderer = null;
	}
}

export function registerVideoRendererBridge(): void {
	if (registered) return;
	registered = true;

	window.addEventListener("cd2-video-renderer-open", (event) => {
		const detail = (event as CustomEvent<VideoRendererOpenDetail>).detail;
		if (
			!detail?.video ||
			!detail.container ||
			!detail.videoUrl ||
			!Number.isSafeInteger(detail.sessionNonce)
		)
			return;
		void activateRenderer(detail);
	});

	window.addEventListener("cd2-video-renderer-set", (event) => {
		const request = (event as CustomEvent<VideoRendererSetDetail>).detail;
		if (!request || !isCurrentSession(request.sessionNonce) || !activeDetail)
			return;
		void activateRenderer({ ...activeDetail, mode: request.mode });
	});

	window.addEventListener("cd2-video-renderer-close", (event) => {
		const detail = (event as CustomEvent<VideoRendererCloseDetail>).detail;
		if (!detail || !isCurrentSession(detail.sessionNonce)) return;
		activeRenderer?.dispose();
		activeRenderer = null;
		activeDetail = null;
	});
}
