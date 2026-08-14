import type {
	FetchProxyMessage,
	FetchProxyResponse,
	RunCommandMessage,
} from "../protocol";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./base64";

type MenuCallback = () => void;

interface RequestOptions {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	data?: string | ArrayBuffer | Uint8Array;
	timeout?: number;
	responseType?: "arraybuffer" | "blob" | "json" | "text";
	onload?: (response: CompatResponse) => void;
	onerror?: (response: CompatResponse) => void;
	ontimeout?: (response: CompatResponse) => void;
}

interface CompatResponse {
	finalUrl: string;
	readyState: number;
	response: unknown;
	responseHeaders: string;
	responseText: string;
	responseXML: Document | null;
	status: number;
	statusText: string;
	error?: string;
}

const storageCache: Record<string, unknown> = {};
const menuCommands = new Map<string, MenuCallback>();
let extensionContextInvalidated = false;
let storageChangeListenerRegistered = false;

function isInvalidatedExtensionContext(error: unknown): boolean {
	return /extension context invalidated/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

function handleExtensionStorageError(error: unknown): void {
	if (isInvalidatedExtensionContext(error)) {
		extensionContextInvalidated = true;
		return;
	}
	console.warn("[cd2-extension] 扩展存储写入失败", error);
}

export const unsafeWindow = window;

export async function preloadExtensionStorage(): Promise<void> {
	try {
		Object.assign(storageCache, await chrome.storage.local.get(null));
		if (!storageChangeListenerRegistered) {
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area !== "local") return;
				for (const [key, change] of Object.entries(changes)) {
					if (change.newValue === undefined) delete storageCache[key];
					else storageCache[key] = change.newValue;
				}
			});
			storageChangeListenerRegistered = true;
		}
	} catch (error) {
		if (!isInvalidatedExtensionContext(error)) throw error;
		extensionContextInvalidated = true;
	}
}

export function GM_getValue<T>(key: string, defaultValue?: T): T {
	return (
		Object.hasOwn(storageCache, key) ? storageCache[key] : defaultValue
	) as T;
}

export function GM_setValue(key: string, value: unknown): void {
	storageCache[key] = value;
	if (extensionContextInvalidated) return;
	try {
		void chrome.storage.local
			.set({ [key]: value })
			.catch(handleExtensionStorageError);
	} catch (error) {
		handleExtensionStorageError(error);
	}
}

export function GM_setClipboard(
	data: string,
	_info?: unknown,
	callback?: () => void,
): void {
	const textarea = document.createElement("textarea");
	textarea.value = data;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	textarea.remove();
	if (!copied) throw new Error("扩展无法写入剪贴板");
	callback?.();
}

export function GM_registerMenuCommand(
	title: string,
	callback: MenuCallback,
): string {
	menuCommands.set(title, callback);
	return title;
}

export function GM_addStyle(css: string): HTMLStyleElement {
	const style = document.createElement("style");
	style.textContent = css;
	(document.head || document.documentElement).appendChild(style);
	return style;
}

function requestBodyToArrayBuffer(
	data: RequestOptions["data"],
): ArrayBuffer | undefined {
	if (data == null) return undefined;
	if (typeof data === "string") return new TextEncoder().encode(data).buffer;
	if (data instanceof ArrayBuffer) return data;
	return data.slice().buffer;
}

function makeResponse(
	result: FetchProxyResponse,
	responseType: RequestOptions["responseType"],
): CompatResponse {
	const buffer = result.bodyBase64
		? base64ToArrayBuffer(result.bodyBase64)
		: new ArrayBuffer(0);
	const text = new TextDecoder().decode(buffer);
	let response: unknown = text;
	if (responseType === "arraybuffer") response = buffer;
	else if (responseType === "blob") response = new Blob([buffer]);
	else if (responseType === "json") response = text ? JSON.parse(text) : null;
	return {
		finalUrl: "",
		readyState: 4,
		response,
		responseHeaders: result.headers || "",
		responseText: text,
		responseXML: null,
		status: result.status || 0,
		statusText: result.statusText || "",
		error: result.error,
	};
}

export function GM_xmlhttpRequest(options: RequestOptions): { abort(): void } {
	let aborted = false;
	const body = requestBodyToArrayBuffer(options.data);
	const message: FetchProxyMessage = {
		type: "cd2-fetch",
		request: {
			url: options.url,
			method: options.method || "GET",
			headers: options.headers || {},
			bodyBase64: body ? arrayBufferToBase64(body) : undefined,
			timeout: options.timeout,
		},
	};

	void chrome.runtime
		.sendMessage<FetchProxyMessage, FetchProxyResponse>(message)
		.then((result) => {
			if (aborted) return;
			if (!result?.ok) {
				options.onerror?.(
					makeResponse(result || { ok: false }, options.responseType),
				);
				return;
			}
			options.onload?.(makeResponse(result, options.responseType));
		})
		.catch((error: unknown) => {
			if (aborted) return;
			const response = makeResponse(
				{
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				},
				options.responseType,
			);
			options.onerror?.(response);
		});

	return {
		abort: () => {
			aborted = true;
		},
	};
}

export function registerExtensionCommandBridge(): void {
	chrome.runtime.onMessage.addListener((message: RunCommandMessage) => {
		if (message?.type !== "cd2-run-command") return;
		const command = [...menuCommands.entries()].find(([title]) =>
			title.startsWith(message.titlePrefix),
		);
		if (!command) return { ok: false, error: "当前页面尚未注册该功能" };
		command[1]();
		return { ok: true };
	});
}
