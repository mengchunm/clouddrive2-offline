import { fetchBinaryRange, parseRangeFileSize } from "./media-range";

interface ExtractEventDetail {
	requestId: string;
	videoUrl: string;
	subtitleIndex: number;
	startTime: number;
	endTime: number;
}

interface CancelExtractEventDetail {
	requestId: string;
}

interface WorkerRangeRequest {
	type: "range-request";
	requestId: string;
	videoUrl: string;
	position: number;
	length: number;
}

interface WorkerExtractResult {
	type: "extract-result";
	requestId: string;
	content?: string;
	codec?: string;
	format?: "ass" | "vtt";
	startTime?: number;
	endTime?: number;
	error?: string;
}

const fileSizeCache = new Map<string, number>();
const canceledExtractions = new Set<string>();
let hostPortPromise: Promise<MessagePort> | null = null;

function throwIfCanceled(requestId: string): void {
	if (canceledExtractions.has(requestId)) {
		throw new Error("Operation canceled");
	}
}

function dispatchExtractResult(detail: Record<string, unknown>): void {
	window.dispatchEvent(
		new CustomEvent("cd2-libav-subtitle-resolved", { detail }),
	);
}

async function getFileSize(videoUrl: string): Promise<number> {
	const cached = fileSizeCache.get(videoUrl);
	if (cached) return cached;
	const response = await fetchBinaryRange(videoUrl, 0, 0, 30_000, "subtitle");
	const size = parseRangeFileSize(response);
	fileSizeCache.set(videoUrl, size);
	return size;
}

function attachRangeHandler(port: MessagePort): void {
	port.addEventListener(
		"message",
		(event: MessageEvent<WorkerRangeRequest>) => {
			const message = event.data;
			if (message.type !== "range-request") return;
			void fetchBinaryRange(
				message.videoUrl,
				message.position,
				message.position + message.length - 1,
				30_000,
				"subtitle",
			)
				.then((response) => {
					const data = response.data;
					port.postMessage(
						{
							type: "range-response",
							requestId: message.requestId,
							position: message.position,
							data,
						},
						[data],
					);
				})
				.catch((error: unknown) =>
					port.postMessage({
						type: "range-response",
						requestId: message.requestId,
						position: message.position,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
		},
	);
	port.start();
}

function getHostPort(): Promise<MessagePort> {
	if (hostPortPromise) return hostPortPromise;
	const promise = new Promise<MessagePort>((resolve, reject) => {
		const iframe = document.createElement("iframe");
		const hostUrl = chrome.runtime.getURL("libav-host.html");
		iframe.src = hostUrl;
		iframe.style.cssText =
			"position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
		iframe.setAttribute("aria-hidden", "true");
		const timeoutId = window.setTimeout(
			() => reject(new Error("libav 扩展运行环境启动超时")),
			15000,
		);
		iframe.onerror = () => {
			window.clearTimeout(timeoutId);
			reject(new Error("无法加载 libav 扩展运行环境"));
		};
		iframe.onload = () => {
			const channel = new MessageChannel();
			const onReady = (event: MessageEvent) => {
				if (event.data?.type === "host-error") {
					window.clearTimeout(timeoutId);
					channel.port1.removeEventListener("message", onReady);
					reject(new Error(event.data.error));
					return;
				}
				if (event.data?.type !== "host-ready") return;
				window.clearTimeout(timeoutId);
				channel.port1.removeEventListener("message", onReady);
				attachRangeHandler(channel.port1);
				resolve(channel.port1);
			};
			channel.port1.addEventListener("message", onReady);
			channel.port1.start();
			iframe.contentWindow?.postMessage(
				{ type: "cd2-libav-host-init" },
				new URL(hostUrl).origin,
				[channel.port2],
			);
		};
		(document.documentElement || document.body).appendChild(iframe);
	}).catch((error) => {
		hostPortPromise = null;
		throw error;
	});
	hostPortPromise = promise;
	return promise;
}

async function extractSubtitle(detail: ExtractEventDetail): Promise<void> {
	const activePort = await getHostPort();
	throwIfCanceled(detail.requestId);
	const fileSize = await getFileSize(detail.videoUrl);
	throwIfCanceled(detail.requestId);
	const result = await new Promise<WorkerExtractResult>((resolve, reject) => {
		const timeoutId = window.setTimeout(
			() => reject(new Error("libav 字幕读取超时")),
			120000,
		);
		const listener = (event: MessageEvent<WorkerExtractResult>) => {
			if (
				event.data.type !== "extract-result" ||
				event.data.requestId !== detail.requestId
			) {
				return;
			}
			window.clearTimeout(timeoutId);
			activePort.removeEventListener("message", listener);
			resolve(event.data);
		};
		activePort.addEventListener("message", listener);
		activePort.postMessage({
			type: "extract",
			...detail,
			fileSize,
		});
	});
	throwIfCanceled(detail.requestId);
	if (result.error || !result.content) {
		throw new Error(result.error || "libav 没有返回字幕内容");
	}
	dispatchExtractResult({
		requestId: detail.requestId,
		content: result.content,
		codec: result.codec,
		format: result.format,
		startTime: result.startTime,
		endTime: result.endTime,
	});
}

export function registerLibavSubtitleBridge(): void {
	window.addEventListener("cd2-libav-cancel-subtitle", (event) => {
		const { requestId } = (event as CustomEvent<CancelExtractEventDetail>)
			.detail;
		if (!requestId) return;
		canceledExtractions.add(requestId);
		void hostPortPromise
			?.then((port) => port.postMessage({ type: "cancel-extract", requestId }))
			.catch(() => undefined);
		// Settle the page-side promise immediately. The worker response may arrive
		// later, but its request-scoped listener will already have been removed.
		dispatchExtractResult({ requestId, error: "Operation canceled" });
	});
	window.addEventListener("cd2-libav-extract-subtitle", (event) => {
		const detail = (event as CustomEvent<ExtractEventDetail>).detail;
		void extractSubtitle(detail)
			.catch((error: unknown) =>
				dispatchExtractResult({
					requestId: detail.requestId,
					error: error instanceof Error ? error.message : String(error),
				}),
			)
			.finally(() => canceledExtractions.delete(detail.requestId));
	});
}
