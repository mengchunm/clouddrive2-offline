import { fetchBinaryRange, parseRangeFileSize } from "./media-range";

interface AudioOpenDetail {
	requestId: string;
	videoUrl: string;
	fileSize?: number;
}

interface AudioDecodeDetail {
	requestId: string;
	startTime: number;
	duration: number;
}

interface AudioHostResult {
	type: "open-result" | "decode-result" | "decode-chunk";
	requestId: string;
	supported?: boolean;
	codec?: string | null;
	channels?: number;
	sampleRate?: number;
	name?: string | null;
	language?: string;
	startTime?: number;
	duration?: number;
	left?: ArrayBuffer;
	right?: ArrayBuffer;
	error?: string;
}

interface AudioRangeRequest {
	type: "range-request";
	requestId: string;
	videoUrl: string;
	position: number;
	length: number;
}

let hostPortPromise: Promise<MessagePort> | null = null;
const fileSizeCache = new Map<string, number>();

async function getFileSize(videoUrl: string): Promise<number> {
	const cached = fileSizeCache.get(videoUrl);
	if (cached) return cached;
	const response = await fetchBinaryRange(videoUrl, 0, 0, 60_000, "audio");
	const size = parseRangeFileSize(response);
	fileSizeCache.set(videoUrl, size);
	return size;
}

function attachRangeHandler(port: MessagePort): void {
	port.addEventListener("message", (event: MessageEvent<AudioRangeRequest>) => {
		const message = event.data;
		if (message.type !== "range-request") return;
		void fetchBinaryRange(
			message.videoUrl,
			message.position,
			message.position + message.length - 1,
			60_000,
			"audio",
		)
			.then((response) => {
				const data = response.data;
				port.postMessage(
					{
						type: "range-response",
						requestId: message.requestId,
						data,
					},
					[data],
				);
			})
			.catch((error: unknown) =>
				port.postMessage({
					type: "range-response",
					requestId: message.requestId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	});
}

function getHostPort(): Promise<MessagePort> {
	if (hostPortPromise) return hostPortPromise;
	const promise = new Promise<MessagePort>((resolve, reject) => {
		const iframe = document.createElement("iframe");
		let settled = false;
		let iframeLoaded = false;
		let channel: MessageChannel | undefined;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			channel?.port1.close();
			channel?.port2.close();
			iframe.remove();
			reject(error);
		};
		const hostUrl = chrome.runtime.getURL("audio-host.html");
		iframe.src = hostUrl;
		iframe.style.cssText =
			"position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
		iframe.setAttribute("aria-hidden", "true");
		const timeoutId = window.setTimeout(
			() =>
				fail(
					new Error(
						iframeLoaded
							? "浏览器音频兼容宿主脚本未响应"
							: "浏览器音频兼容宿主页加载超时",
					),
				),
			15000,
		);
		iframe.onerror = () => {
			window.clearTimeout(timeoutId);
			fail(new Error("无法加载浏览器音频兼容环境"));
		};
		iframe.onload = () => {
			iframeLoaded = true;
			channel = new MessageChannel();
			const onReady = (event: MessageEvent) => {
				if (event.data?.type !== "host-ready") return;
				if (settled) return;
				settled = true;
				window.clearTimeout(timeoutId);
				channel?.port1.removeEventListener("message", onReady);
				if (channel) resolve(channel.port1);
			};
			channel.port1.addEventListener("message", onReady);
			attachRangeHandler(channel.port1);
			channel.port1.start();
			iframe.contentWindow?.postMessage({ type: "cd2-audio-host-init" }, "*", [
				channel.port2,
			]);
		};
		(document.documentElement || document.body).appendChild(iframe);
	}).catch((error) => {
		hostPortPromise = null;
		throw error;
	});
	hostPortPromise = promise;
	return promise;
}

async function getHostPortWithRetry(): Promise<MessagePort> {
	let firstError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			return await getHostPort();
		} catch (error) {
			firstError ??= error;
			if (attempt === 0) {
				await new Promise((resolve) => window.setTimeout(resolve, 50));
			}
		}
	}
	throw firstError;
}

async function requestHost(
	request: AudioOpenDetail | AudioDecodeDetail,
	type: "open" | "decode",
): Promise<void> {
	const port = await getHostPortWithRetry();
	const openRequest = request as AudioOpenDetail;
	const knownFileSize = openRequest.fileSize;
	const payload =
		type === "open"
			? {
					...request,
					fileSize:
						Number.isFinite(knownFileSize) && Number(knownFileSize) > 0
							? Math.trunc(Number(knownFileSize))
							: await getFileSize(openRequest.videoUrl),
				}
			: request;
	const result = await new Promise<AudioHostResult>((resolve, reject) => {
		const timeoutId = window.setTimeout(
			() =>
				reject(new Error(type === "open" ? "读取音轨超时" : "解码音频超时")),
			type === "open" ? 90000 : 120000,
		);
		const listener = (event: MessageEvent<AudioHostResult>) => {
			if (event.data.requestId !== request.requestId) return;
			if (type === "decode" && event.data.type === "decode-chunk") {
				window.dispatchEvent(
					new CustomEvent("cd2-audio-fallback-decode-chunk", {
						detail: event.data,
					}),
				);
				return;
			}
			if (event.data.type !== `${type}-result`) return;
			window.clearTimeout(timeoutId);
			port.removeEventListener("message", listener);
			resolve(event.data);
		};
		port.addEventListener("message", listener);
		port.postMessage({ type, ...payload });
	});
	if (result.error) throw new Error(result.error);
	window.dispatchEvent(
		new CustomEvent(`cd2-audio-fallback-${type}-resolved`, {
			detail: result,
		}),
	);
}

function dispatchError(
	type: "open" | "decode",
	requestId: string,
	error: unknown,
): void {
	window.dispatchEvent(
		new CustomEvent(`cd2-audio-fallback-${type}-resolved`, {
			detail: {
				requestId,
				error: error instanceof Error ? error.message : String(error),
			},
		}),
	);
}

export function registerAudioFallbackBridge(): void {
	window.addEventListener("cd2-audio-fallback-warmup", () => {
		void getHostPortWithRetry().catch((error) =>
			console.warn("[cd2-artplayer] 音频解码器后台预热失败:", error),
		);
	});
	window.addEventListener("cd2-audio-fallback-open", (event) => {
		const detail = (event as CustomEvent<AudioOpenDetail>).detail;
		void requestHost(detail, "open").catch((error) =>
			dispatchError("open", detail.requestId, error),
		);
	});
	window.addEventListener("cd2-audio-fallback-decode", (event) => {
		const detail = (event as CustomEvent<AudioDecodeDetail>).detail;
		void requestHost(detail, "decode").catch((error) =>
			dispatchError("decode", detail.requestId, error),
		);
	});
	window.addEventListener("cd2-audio-fallback-cancel", () => {
		void getHostPort()
			.then((port) => port.postMessage({ type: "cancel-decode" }))
			.catch(() => undefined);
	});
	window.addEventListener("cd2-audio-fallback-close", () => {
		void getHostPort()
			.then((port) => port.postMessage({ type: "close" }))
			.catch(() => undefined);
	});
}
