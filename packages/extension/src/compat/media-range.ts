import type { FetchProxyMessage, FetchProxyResponse } from "../protocol";
import { base64ToArrayBuffer } from "./base64";

export interface BinaryRangeResponse {
	status: number;
	headers: string;
	data: ArrayBuffer;
}

export type MediaRangePriority = "audio" | "subtitle" | "normal";

interface RangeHostResponse {
	type: "host-ready" | "range-response";
	requestId?: string;
	data?: ArrayBuffer;
	totalSize?: number;
	error?: string;
}

let rangeHostPortPromise: Promise<MessagePort> | null = null;
let rangeRequestSequence = 0;

function hasExtensionContext(): boolean {
	try {
		return Boolean(chrome.runtime?.id);
	} catch {
		return false;
	}
}

function getRangeHostPort(): Promise<MessagePort> {
	if (rangeHostPortPromise) return rangeHostPortPromise;
	const promise = new Promise<MessagePort>((resolve, reject) => {
		if (!hasExtensionContext()) {
			reject(new Error("扩展上下文已失效，请刷新网页"));
			return;
		}
		const iframe = document.createElement("iframe");
		const hostUrl = chrome.runtime.getURL("range-host.html");
		iframe.src = hostUrl;
		iframe.style.cssText =
			"position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
		iframe.setAttribute("aria-hidden", "true");
		const timeoutId = window.setTimeout(
			() => reject(new Error("媒体 Range 主机启动超时")),
			15_000,
		);
		iframe.onerror = () => {
			window.clearTimeout(timeoutId);
			reject(new Error("无法加载媒体 Range 主机"));
		};
		iframe.onload = () => {
			const channel = new MessageChannel();
			const onReady = (event: MessageEvent<RangeHostResponse>) => {
				if (event.data?.type !== "host-ready") return;
				window.clearTimeout(timeoutId);
				channel.port1.removeEventListener("message", onReady);
				resolve(channel.port1);
			};
			channel.port1.addEventListener("message", onReady);
			channel.port1.start();
			iframe.contentWindow?.postMessage(
				{ type: "cd2-range-host-init" },
				new URL(hostUrl).origin,
				[channel.port2],
			);
		};
		(document.documentElement || document.body).appendChild(iframe);
	}).catch((error) => {
		rangeHostPortPromise = null;
		throw error;
	});
	rangeHostPortPromise = promise;
	return promise;
}

async function fetchHostRange(
	url: string,
	start: number,
	end: number,
	timeout: number,
	priority: MediaRangePriority,
): Promise<BinaryRangeResponse> {
	const port = await getRangeHostPort();
	const requestId = `media-range-${Date.now()}-${++rangeRequestSequence}`;
	const result = await new Promise<
		Required<Pick<RangeHostResponse, "data" | "totalSize">>
	>((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			port.removeEventListener("message", listener);
			reject(new Error("媒体 Range 请求超时"));
		}, timeout);
		const listener = (event: MessageEvent<RangeHostResponse>) => {
			if (
				event.data.type !== "range-response" ||
				event.data.requestId !== requestId
			) {
				return;
			}
			window.clearTimeout(timeoutId);
			port.removeEventListener("message", listener);
			if (event.data.error) reject(new Error(event.data.error));
			else if (event.data.data && event.data.totalSize) {
				resolve({ data: event.data.data, totalSize: event.data.totalSize });
			} else reject(new Error("媒体 Range 主机返回不完整"));
		};
		port.addEventListener("message", listener);
		port.postMessage({
			type: "range-request",
			requestId,
			url,
			start,
			end,
			timeout,
			priority,
		});
	});
	return {
		status: 206,
		headers:
			result.data.byteLength > 0
				? `content-range: bytes ${start}-${start + result.data.byteLength - 1}/${result.totalSize}\r\ncontent-length: ${result.data.byteLength}`
				: `content-range: bytes */${result.totalSize}\r\ncontent-length: 0`,
		data: result.data,
	};
}

async function fetchProxyRange(
	url: string,
	start: number,
	end: number,
	timeout: number,
): Promise<BinaryRangeResponse> {
	if (!hasExtensionContext()) {
		throw new Error("扩展上下文已失效，请刷新网页");
	}
	const message: FetchProxyMessage = {
		type: "cd2-fetch",
		request: {
			url,
			method: "GET",
			headers: { Range: `bytes=${start}-${end}` },
			timeout,
		},
	};
	let response: FetchProxyResponse | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			response = await chrome.runtime.sendMessage<
				FetchProxyMessage,
				FetchProxyResponse
			>(message);
			break;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			if (
				attempt === 0 &&
				hasExtensionContext() &&
				/message channel closed|asynchronous response|receiving end does not exist/i.test(
					errorMessage,
				)
			) {
				continue;
			}
			throw error;
		}
	}
	if (!response?.ok) {
		throw new Error(response?.error || "CloudDrive2 Range 请求失败");
	}
	return {
		status: response.status ?? 0,
		headers: response.headers ?? "",
		data: response.bodyBase64
			? base64ToArrayBuffer(response.bodyBase64)
			: new ArrayBuffer(0),
	};
}

/**
 * Reads cached extension media as transferable binary. Original CloudDrive2
 * URLs retain the runtime proxy fallback because arbitrary pages may block
 * their CORS response. Once media registration succeeds, video, audio and
 * subtitles all converge on the extension URL and the same 4 MiB chunk store.
 */
export async function fetchBinaryRange(
	url: string,
	start: number,
	end: number,
	timeout = 60_000,
	priority: MediaRangePriority = "normal",
): Promise<BinaryRangeResponse> {
	if (/^https?:\/\//i.test(url)) {
		try {
			return await fetchHostRange(url, start, end, timeout, priority);
		} catch (error) {
			console.warn(
				"[cd2-media-range] 二进制 Range 主机失败，回退后台代理:",
				error,
			);
		}
	}
	return fetchProxyRange(url, start, end, timeout);
}

export function parseRangeFileSize(response: BinaryRangeResponse): number {
	const contentRange = response.headers.match(
		/^content-range:\s*bytes\s+\d+-\d+\/(\d+)/im,
	)?.[1];
	if (contentRange) return Number(contentRange);
	const contentLength = response.headers.match(
		/^content-length:\s*(\d+)/im,
	)?.[1];
	if (response.status === 206 && contentLength) return Number(contentLength);
	throw new Error("CloudDrive2 响应中缺少文件总长度或不支持 Range");
}
