import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import {
	CloudDriveFileSrv,
	type CloudDrivePushMessage,
	CloudDrivePushMessage_MessageType,
} from "../../offline/src/proto/clouddrive_pb";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./compat/base64";
import type {
	FetchProxyMessage,
	FetchProxyResponse,
	MarkTaskRootDeletedMessage,
	NativeStatusMessage,
	NativeUninstallMessage,
	OpenLocalPathMessage,
	OpenLocalPathResponse,
	OpenOptionsMessage,
	PlayPotPlayerPlaylistMessage,
	TrackTaskRootMessage,
} from "./protocol";

const NATIVE_HOST = "com.clouddrive2.offline";
const NATIVE_REQUEST_TIMEOUT = 15_000;
const CONFIG_KEY = "cd2_config_v1";
const PUSH_PORT_NAME = "cd2-push-events";
const TRACKED_ROOTS_KEY = "cd2_tracked_task_roots_v1";
const LEGACY_MEDIA_CACHE_DATABASE = "cd2-media-range-cache-v1";
const LEGACY_MEDIA_CACHE_SETTING = "cd2_media_cache_enabled";
const LEGACY_MEDIA_CACHE_CLEANUP_KEY = "cd2_legacy_media_cache_removed_v1";
type TrackedRoot = {
	taskKey: string;
	fileId: string;
	path: string;
	originalPath: string;
	status: "present" | "moved" | "deleted";
};
const pushPorts = new Set<chrome.runtime.Port>();
let trackedRoots: Record<string, TrackedRoot> = {};
const pendingRootDeletes = new Map<string, ReturnType<typeof setTimeout>>();
let pushAbortController: AbortController | undefined;
let pushReconnectTimer: ReturnType<typeof setTimeout> | undefined;

type NativeResponse = OpenLocalPathResponse & { requestId?: string };
type PendingNativeRequest = {
	resolve: (response: NativeResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

let nativePort: chrome.runtime.Port | undefined;
let nativeRequestSequence = 0;
const pendingNativeRequests = new Map<string, PendingNativeRequest>();

async function cleanupLegacyMediaCache(): Promise<void> {
	const stored = await chrome.storage.local.get(LEGACY_MEDIA_CACHE_CLEANUP_KEY);
	if (stored[LEGACY_MEDIA_CACHE_CLEANUP_KEY] === true) return;
	const removed = await new Promise<boolean>((resolve) => {
		const request = indexedDB.deleteDatabase(LEGACY_MEDIA_CACHE_DATABASE);
		request.onsuccess = () => resolve(true);
		request.onerror = () => resolve(false);
		request.onblocked = () => resolve(false);
	});
	if (!removed) return;
	await chrome.storage.local.remove(LEGACY_MEDIA_CACHE_SETTING);
	await chrome.storage.local.set({ [LEGACY_MEDIA_CACHE_CLEANUP_KEY]: true });
}

void cleanupLegacyMediaCache();

const trackedRootsReady = chrome.storage.local
	.get(TRACKED_ROOTS_KEY)
	.then((stored) => {
		trackedRoots =
			(stored[TRACKED_ROOTS_KEY] as Record<string, TrackedRoot>) || {};
	});

function broadcastPushMessage(message: Record<string, unknown>): void {
	for (const port of pushPorts) {
		try {
			port.postMessage(message);
		} catch {
			pushPorts.delete(port);
		}
	}
}

function saveTrackedRoots(): void {
	void chrome.storage.local.set({ [TRACKED_ROOTS_KEY]: trackedRoots });
}

function publishTrackedRoot(root: TrackedRoot): void {
	broadcastPushMessage({ type: "cd2-task-location-changed", location: root });
}

function applyFileSystemChange(message: CloudDrivePushMessage): void {
	if (message.data.case !== "fileSystemChange") return;
	const change = message.data.value;
	if (!change?.path) return;
	const changedPath = change.path.replace(/\\/g, "/");
	const newPath = change.newPath?.replace(/\\/g, "/");
	let changed = false;

	for (const [taskKey, root] of Object.entries(trackedRoots)) {
		const sameId = Boolean(
			change.theFile?.id && change.theFile.id === root.fileId,
		);
		const samePath = root.path === changedPath;
		const insideChangedDirectory = root.path.startsWith(
			`${changedPath.replace(/\/+$/, "")}/`,
		);
		if (
			change.changeType === 2 &&
			newPath &&
			(sameId || samePath || insideChangedDirectory)
		) {
			const suffix = insideChangedDirectory
				? root.path.slice(changedPath.length)
				: "";
			root.path = `${newPath}${suffix}`;
			root.status = root.path === root.originalPath ? "present" : "moved";
			const pending = pendingRootDeletes.get(taskKey);
			if (pending) clearTimeout(pending);
			pendingRootDeletes.delete(taskKey);
			publishTrackedRoot(root);
			changed = true;
		} else if (change.changeType === 0 && sameId) {
			root.path = change.theFile?.fullPathName || changedPath;
			root.status = root.path === root.originalPath ? "present" : "moved";
			const pending = pendingRootDeletes.get(taskKey);
			if (pending) clearTimeout(pending);
			pendingRootDeletes.delete(taskKey);
			publishTrackedRoot(root);
			changed = true;
		} else if (
			change.changeType === 1 &&
			(samePath || insideChangedDirectory)
		) {
			const oldTimer = pendingRootDeletes.get(taskKey);
			if (oldTimer) clearTimeout(oldTimer);
			pendingRootDeletes.set(
				taskKey,
				setTimeout(() => {
					pendingRootDeletes.delete(taskKey);
					const current = trackedRoots[taskKey];
					if (!current || current.path !== root.path) return;
					current.status = "deleted";
					saveTrackedRoots();
					publishTrackedRoot(current);
				}, 1_500),
			);
		}
	}
	if (changed) saveTrackedRoots();
}

async function runPushStream(signal: AbortSignal): Promise<void> {
	const stored = await chrome.storage.local.get(CONFIG_KEY);
	const config = stored[CONFIG_KEY] as
		| { grpcBaseUrl?: string; apiToken?: string }
		| undefined;
	const baseUrl = (config?.grpcBaseUrl || "http://localhost:19798").replace(
		/\/+$/,
		"",
	);
	const token = config?.apiToken?.trim();
	const authInterceptor: Interceptor = (next) => async (request) => {
		if (token) {
			request.header.set(
				"Authorization",
				token.startsWith("Bearer ") ? token : `Bearer ${token}`,
			);
		}
		return await next(request);
	};
	const client = createClient(
		CloudDriveFileSrv,
		createGrpcWebTransport({
			baseUrl,
			interceptors: [authInterceptor],
			fetch: (input, init) => fetch(input, init),
		}),
	);
	for await (const message of client.pushMessage(create(EmptySchema, {}), {
		signal,
	})) {
		if (
			message.messageType ===
			CloudDrivePushMessage_MessageType.FILE_SYSTEM_CHANGE
		) {
			applyFileSystemChange(message);
		}
		if (
			message.messageType !==
				CloudDrivePushMessage_MessageType.DOWNLOADER_COUNT &&
			message.messageType !==
				CloudDrivePushMessage_MessageType.FILE_SYSTEM_CHANGE
		) {
			continue;
		}
		broadcastPushMessage({ type: "cd2-task-state-changed" });
	}
}

function stopPushStream(): void {
	if (pushReconnectTimer) clearTimeout(pushReconnectTimer);
	pushReconnectTimer = undefined;
	pushAbortController?.abort();
	pushAbortController = undefined;
}

function startPushStream(): void {
	stopPushStream();
	if (pushPorts.size === 0) return;
	const controller = new AbortController();
	pushAbortController = controller;
	void runPushStream(controller.signal)
		.catch((error: unknown) => {
			if (!controller.signal.aborted) {
				console.warn("[cd2-extension] CloudDrive2 推送连接失败", error);
			}
		})
		.finally(() => {
			if (pushAbortController !== controller) return;
			pushAbortController = undefined;
			if (pushPorts.size > 0) {
				pushReconnectTimer = setTimeout(startPushStream, 3_000);
			}
		});
}

chrome.runtime.onConnect.addListener((port) => {
	if (port.name !== PUSH_PORT_NAME) return;
	pushPorts.add(port);
	void trackedRootsReady.then(() => {
		port.postMessage({ type: "cd2-task-locations", locations: trackedRoots });
	});
	if (!pushAbortController && !pushReconnectTimer) startPushStream();
	port.onDisconnect.addListener(() => {
		pushPorts.delete(port);
		if (pushPorts.size === 0) stopPushStream();
	});
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes[CONFIG_KEY] && pushPorts.size > 0) {
		startPushStream();
	}
});

function disconnectNativePort(reason = "Native Host 连接已关闭"): void {
	const port = nativePort;
	nativePort = undefined;
	if (port) {
		try {
			port.disconnect();
		} catch {
			// The port was already disconnected.
		}
	}
	for (const pending of pendingNativeRequests.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error(reason));
	}
	pendingNativeRequests.clear();
}

function ensureNativePort(): chrome.runtime.Port {
	if (nativePort) return nativePort;
	const port = chrome.runtime.connectNative(NATIVE_HOST);
	nativePort = port;
	port.onMessage.addListener((message: NativeResponse) => {
		let requestId = message?.requestId;
		if (!requestId && pendingNativeRequests.size === 1)
			requestId = pendingNativeRequests.keys().next().value;
		if (!requestId) return;
		const pending = pendingNativeRequests.get(requestId);
		if (!pending) return;
		pendingNativeRequests.delete(requestId);
		clearTimeout(pending.timer);
		pending.resolve(message);
	});
	port.onDisconnect.addListener(() => {
		const error = chrome.runtime.lastError?.message;
		if (nativePort === port)
			disconnectNativePort(error || "Native Host 连接已关闭");
	});
	return port;
}

function sendPersistentNativeMessage(
	message: Record<string, unknown>,
	timeoutMs = NATIVE_REQUEST_TIMEOUT,
): Promise<NativeResponse> {
	return new Promise((resolve, reject) => {
		const requestId = `native-${Date.now()}-${++nativeRequestSequence}`;
		let port: chrome.runtime.Port;
		try {
			port = ensureNativePort();
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const timer = setTimeout(() => {
			pendingNativeRequests.delete(requestId);
			if (nativePort === port) {
				disconnectNativePort("Native Host 响应超时，已重置连接");
			}
			reject(new Error("Native Host 响应超时"));
		}, timeoutMs);
		pendingNativeRequests.set(requestId, { resolve, reject, timer });
		try {
			port.postMessage({ ...message, requestId });
		} catch (error) {
			clearTimeout(timer);
			pendingNativeRequests.delete(requestId);
			disconnectNativePort();
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function proxyFetch(
	message: FetchProxyMessage,
): Promise<FetchProxyResponse> {
	const { request } = message;
	const controller = new AbortController();
	const timeoutId = request.timeout
		? setTimeout(() => controller.abort(), request.timeout)
		: undefined;
	try {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body:
				request.bodyBase64 &&
				!["GET", "HEAD"].includes(request.method.toUpperCase())
					? base64ToArrayBuffer(request.bodyBase64)
					: undefined,
			signal: controller.signal,
			redirect: "follow",
		});
		const headers = [...response.headers.entries()]
			.map(([key, value]) => `${key}: ${value}`)
			.join("\r\n");
		return {
			ok: true,
			status: response.status,
			statusText: response.statusText,
			headers,
			bodyBase64: arrayBufferToBase64(await response.arrayBuffer()),
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

chrome.runtime.onMessage.addListener(
	(
		message:
			| FetchProxyMessage
			| OpenOptionsMessage
			| TrackTaskRootMessage
			| MarkTaskRootDeletedMessage
			| OpenLocalPathMessage
			| PlayPotPlayerPlaylistMessage
			| NativeStatusMessage
			| NativeUninstallMessage,
		_sender,
		sendResponse,
	) => {
		if (message?.type === "cd2-mark-task-root-deleted") {
			void trackedRootsReady.then(() => {
				const root = trackedRoots[message.taskKey];
				if (root && root.status !== "moved") {
					root.status = "deleted";
					saveTrackedRoots();
					publishTrackedRoot(root);
				}
				sendResponse({ ok: true });
			});
			return true;
		}
		if (message?.type === "cd2-track-task-root") {
			void trackedRootsReady.then(() => {
				const existing = trackedRoots[message.taskKey];
				const preserveTrackedResult =
					!message.verified &&
					existing?.fileId === message.fileId &&
					(existing.status === "moved" || existing.status === "deleted");
				trackedRoots[message.taskKey] = {
					taskKey: message.taskKey,
					fileId: message.fileId,
					path: preserveTrackedResult ? existing.path : message.path,
					originalPath: existing?.originalPath || message.path,
					status: preserveTrackedResult ? existing.status : "present",
				};
				saveTrackedRoots();
				sendResponse({ ok: true });
			});
			return true;
		}
		if (message?.type === "cd2-open-options") {
			void chrome.runtime
				.openOptionsPage()
				.then(() => sendResponse({ ok: true }))
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			return true;
		}
		if (message?.type === "cd2-fetch") {
			void proxyFetch(message).then(sendResponse);
			return true;
		}
		if (message?.type === "cd2-open-local-path") {
			void sendPersistentNativeMessage({
				action: message.reveal ? "revealPath" : "openDirectory",
				path: message.localPath,
			})
				.then(sendResponse)
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies OpenLocalPathResponse),
				);
			return true;
		}
		if (message?.type === "cd2-play-potplayer-playlist") {
			void sendPersistentNativeMessage({
				action: "playPotPlayerPlaylist",
				title: message.title,
				startUrl: message.startUrl,
				entries: message.entries,
			})
				.then(sendResponse)
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies OpenLocalPathResponse),
				);
			return true;
		}
		if (message?.type === "cd2-native-status") {
			void sendPersistentNativeMessage({ action: "ping" }, 10_000)
				.then(sendResponse)
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			return true;
		}
		if (message?.type === "cd2-native-uninstall") {
			void sendPersistentNativeMessage({ action: "uninstall" }, 3_000)
				.then((response) => {
					sendResponse(response);
					disconnectNativePort("本地助手已卸载");
				})
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			return true;
		}
	},
);
