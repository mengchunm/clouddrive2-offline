import type {
	MediaCacheStatsResponse,
	RegisterMediaCacheMessage,
	RegisterMediaCacheResponse,
} from "./protocol";

const DATABASE_NAME = "cd2-media-range-cache-v1";
const DATABASE_VERSION = 1;
const MEDIA_STORE = "media";
const CHUNK_STORE = "chunks";
const META_STORE = "meta";
const CACHE_USAGE_KEY = "usage";
const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_RESPONSE_SIZE = 32 * 1024 * 1024;
const MAX_CACHE_SIZE = 2 * 1024 * 1024 * 1024;
const EVICT_TO_SIZE = Math.floor(MAX_CACHE_SIZE * 0.9);
const CACHE_RESOURCE_PATH = "/media-cache-stream.bin";
const MEDIA_CACHE_ENABLED_KEY = "cd2_media_cache_enabled";
const CHUNK_TOUCH_INTERVAL = 60_000;
const MAX_MEMORY_CACHE_SIZE = 64 * 1024 * 1024;

interface MediaRecord {
	key: string;
	sourceUrl: string;
	totalSize: number;
	contentType: string;
	etag?: string;
	lastModified?: string;
	lastAccess: number;
}

interface ChunkRecord {
	id: string;
	mediaKey: string;
	index: number;
	data: ArrayBuffer;
	size: number;
	lastAccess: number;
}

interface UsageRecord {
	key: typeof CACHE_USAGE_KEY;
	totalBytes: number;
}

interface ExtensionFetchEvent extends Event {
	request: Request;
	respondWith(response: Response | Promise<Response>): void;
}

let databasePromise: Promise<IDBDatabase> | undefined;
const pendingChunks = new Map<string, Promise<ArrayBuffer>>();
const memoryChunks = new Map<string, ArrayBuffer>();
let memoryChunkBytes = 0;
let evictionPromise: Promise<void> | undefined;
let persistenceQueue = Promise.resolve();

function rememberChunk(id: string, data: ArrayBuffer): void {
	const existing = memoryChunks.get(id);
	if (existing) {
		memoryChunkBytes -= existing.byteLength;
		memoryChunks.delete(id);
	}
	memoryChunks.set(id, data);
	memoryChunkBytes += data.byteLength;
	while (memoryChunkBytes > MAX_MEMORY_CACHE_SIZE && memoryChunks.size > 1) {
		const oldestId = memoryChunks.keys().next().value as string | undefined;
		if (!oldestId) break;
		const oldest = memoryChunks.get(oldestId);
		memoryChunks.delete(oldestId);
		memoryChunkBytes -= oldest?.byteLength ?? 0;
	}
}

function readMemoryChunk(id: string): ArrayBuffer | undefined {
	const data = memoryChunks.get(id);
	if (!data) return undefined;
	// Refresh insertion order to make the map a small LRU cache.
	memoryChunks.delete(id);
	memoryChunks.set(id, data);
	return data;
}

function forgetMediaMemoryChunks(mediaKey: string): void {
	const prefix = `${mediaKey}:`;
	for (const [id, data] of memoryChunks) {
		if (!id.startsWith(prefix)) continue;
		memoryChunks.delete(id);
		memoryChunkBytes -= data.byteLength;
	}
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise;
	databasePromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(MEDIA_STORE)) {
				database.createObjectStore(MEDIA_STORE, { keyPath: "key" });
			}
			if (!database.objectStoreNames.contains(CHUNK_STORE)) {
				const chunks = database.createObjectStore(CHUNK_STORE, {
					keyPath: "id",
				});
				chunks.createIndex("lastAccess", "lastAccess");
				chunks.createIndex("mediaKey", "mediaKey");
			}
			if (!database.objectStoreNames.contains(META_STORE)) {
				database.createObjectStore(META_STORE, { keyPath: "key" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	return databasePromise;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function parseContentRange(value: string | null): {
	start: number;
	end: number;
	total: number;
} | null {
	const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	const total = Number(match[3]);
	return Number.isSafeInteger(start) &&
		Number.isSafeInteger(end) &&
		Number.isSafeInteger(total) &&
		start >= 0 &&
		end >= start &&
		total > end
		? { start, end, total }
		: null;
}

function parseRequestedRange(
	value: string | null,
	totalSize: number,
): { start: number; end: number; partial: boolean } | null {
	if (!value) return { start: 0, end: totalSize - 1, partial: false };
	const match = value.match(/^bytes=(\d+)-(\d*)$/i);
	if (!match) return null;
	const start = Number(match[1]);
	const requestedEnd = match[2] ? Number(match[2]) : totalSize - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 0 ||
		start >= totalSize ||
		requestedEnd < start
	) {
		return null;
	}
	return {
		start,
		end: Math.min(requestedEnd, totalSize - 1, start + MAX_RESPONSE_SIZE - 1),
		partial: true,
	};
}

async function getMedia(key: string): Promise<MediaRecord | undefined> {
	const database = await openDatabase();
	const transaction = database.transaction(MEDIA_STORE, "readonly");
	return requestResult(
		transaction.objectStore(MEDIA_STORE).get(key) as IDBRequest<
			MediaRecord | undefined
		>,
	);
}

async function saveMedia(media: MediaRecord): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(MEDIA_STORE, "readwrite");
	transaction.objectStore(MEDIA_STORE).put(media);
	await transactionDone(transaction);
}

async function deleteMediaChunks(mediaKey: string): Promise<void> {
	forgetMediaMemoryChunks(mediaKey);
	const database = await openDatabase();
	const transaction = database.transaction(
		[CHUNK_STORE, META_STORE],
		"readwrite",
	);
	const chunks = transaction.objectStore(CHUNK_STORE);
	const usageStore = transaction.objectStore(META_STORE);
	const usage = ((await requestResult(
		usageStore.get(CACHE_USAGE_KEY) as IDBRequest<UsageRecord | undefined>,
	)) as UsageRecord | undefined) ?? {
		key: CACHE_USAGE_KEY,
		totalBytes: 0,
	};
	let removedBytes = 0;
	await new Promise<void>((resolve, reject) => {
		const cursorRequest = chunks.index("mediaKey").openCursor(mediaKey);
		cursorRequest.onerror = () => reject(cursorRequest.error);
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor) {
				resolve();
				return;
			}
			const record = cursor.value as ChunkRecord;
			removedBytes += record.size;
			cursor.delete();
			cursor.continue();
		};
	});
	usage.totalBytes = Math.max(0, usage.totalBytes - removedBytes);
	usageStore.put(usage);
	await transactionDone(transaction);
}

function inferContentType(fileName?: string): string {
	const extension = fileName
		?.toLowerCase()
		.match(/\.([^.?#/]+)(?:[?#]|$)/)?.[1];
	const types: Record<string, string> = {
		mp4: "video/mp4",
		m4v: "video/mp4",
		mov: "video/quicktime",
		webm: "video/webm",
		mkv: "video/x-matroska",
		ts: "video/mp2t",
		m2ts: "video/mp2t",
		avi: "video/x-msvideo",
		flv: "video/x-flv",
		ogv: "video/ogg",
		mp3: "audio/mpeg",
		m4a: "audio/mp4",
		flac: "audio/flac",
		wav: "audio/wav",
		ogg: "audio/ogg",
		opus: "audio/ogg",
	};
	return (extension && types[extension]) || "application/octet-stream";
}

async function probeMedia(
	sourceUrl: string,
	fileName?: string,
): Promise<Omit<MediaRecord, "key">> {
	const response = await fetch(sourceUrl, {
		headers: { Range: "bytes=0-0" },
		cache: "no-store",
		credentials: "include",
		redirect: "follow",
	});
	const contentRange = parseContentRange(response.headers.get("content-range"));
	if (!response.ok || !contentRange) {
		await response.body?.cancel();
		throw new Error("视频响应不支持可缓存的 HTTP Range");
	}
	await response.body?.cancel();
	const responseType = response.headers.get("content-type")?.split(";", 1)[0];
	return {
		sourceUrl,
		totalSize: contentRange.total,
		contentType:
			responseType && responseType !== "application/octet-stream"
				? responseType
				: inferContentType(fileName),
		etag: response.headers.get("etag") || undefined,
		lastModified: response.headers.get("last-modified") || undefined,
		lastAccess: Date.now(),
	};
}

export async function registerMediaCache(
	message: RegisterMediaCacheMessage,
): Promise<RegisterMediaCacheResponse> {
	const settings = await chrome.storage.local.get(MEDIA_CACHE_ENABLED_KEY);
	if (settings[MEDIA_CACHE_ENABLED_KEY] === false) {
		return { ok: true, playbackUrl: message.url, cacheEnabled: false };
	}
	if (!/^https?:\/\//i.test(message.url)) {
		return { ok: true, playbackUrl: message.url, cacheEnabled: false };
	}
	try {
		const key = await sha256(message.cacheKey || message.url);
		const existing = await getMedia(key);
		let media = existing;
		if (!media || media.sourceUrl !== message.url) {
			const knownSize = Number(message.fileSize);
			const probed: Omit<MediaRecord, "key"> =
				Number.isSafeInteger(knownSize) && knownSize > 0
					? {
							sourceUrl: message.url,
							totalSize: knownSize,
							contentType: inferContentType(message.fileName),
							lastAccess: Date.now(),
						}
					: await probeMedia(message.url, message.fileName);
			const sameFile =
				existing &&
				existing.totalSize === probed.totalSize &&
				((Number.isSafeInteger(knownSize) && knownSize > 0) ||
					(existing.etag && existing.etag === probed.etag) ||
					(existing.lastModified &&
						existing.lastModified === probed.lastModified));
			if (existing && !sameFile) await deleteMediaChunks(key);
			media = { key, ...probed };
			await saveMedia(media);
		} else {
			media.lastAccess = Date.now();
			await saveMedia(media);
		}
		return {
			ok: true,
			cacheEnabled: true,
			playbackUrl: `${chrome.runtime.getURL("media-cache-stream.bin")}?key=${key}`,
			totalSize: media.totalSize,
		};
	} catch (error) {
		return {
			ok: true,
			playbackUrl: message.url,
			cacheEnabled: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getMediaCacheStats(): Promise<MediaCacheStatsResponse> {
	const database = await openDatabase();
	const transaction = database.transaction(META_STORE, "readonly");
	const usage = await requestResult(
		transaction.objectStore(META_STORE).get(CACHE_USAGE_KEY) as IDBRequest<
			UsageRecord | undefined
		>,
	);
	return {
		ok: true,
		totalBytes: usage?.totalBytes ?? 0,
		maxBytes: MAX_CACHE_SIZE,
	};
}

export async function clearMediaCache(): Promise<MediaCacheStatsResponse> {
	await persistenceQueue.catch(() => undefined);
	memoryChunks.clear();
	memoryChunkBytes = 0;
	const database = await openDatabase();
	const transaction = database.transaction(
		[MEDIA_STORE, CHUNK_STORE, META_STORE],
		"readwrite",
	);
	transaction.objectStore(MEDIA_STORE).clear();
	transaction.objectStore(CHUNK_STORE).clear();
	transaction.objectStore(META_STORE).put({
		key: CACHE_USAGE_KEY,
		totalBytes: 0,
	} satisfies UsageRecord);
	await transactionDone(transaction);
	return { ok: true, totalBytes: 0, maxBytes: MAX_CACHE_SIZE };
}

async function readChunk(id: string): Promise<ArrayBuffer | undefined> {
	const memory = readMemoryChunk(id);
	if (memory) return memory;
	const database = await openDatabase();
	const transaction = database.transaction(CHUNK_STORE, "readonly");
	const record = await requestResult(
		transaction.objectStore(CHUNK_STORE).get(id) as IDBRequest<
			ChunkRecord | undefined
		>,
	);
	if (!record) return undefined;
	rememberChunk(id, record.data);
	if (Date.now() - record.lastAccess >= CHUNK_TOUCH_INTERVAL)
		void touchChunk(id);
	return record.data;
}

async function touchChunk(id: string): Promise<void> {
	try {
		const database = await openDatabase();
		const transaction = database.transaction(CHUNK_STORE, "readwrite");
		const store = transaction.objectStore(CHUNK_STORE);
		const record = await requestResult(
			store.get(id) as IDBRequest<ChunkRecord | undefined>,
		);
		if (record) {
			record.lastAccess = Date.now();
			store.put(record);
		}
		await transactionDone(transaction);
	} catch {
		// LRU 时间更新失败不应中断播放。
	}
}

async function putChunk(record: ChunkRecord): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(
		[CHUNK_STORE, META_STORE],
		"readwrite",
	);
	const chunks = transaction.objectStore(CHUNK_STORE);
	const usageStore = transaction.objectStore(META_STORE);
	const previous = await requestResult(
		chunks.get(record.id) as IDBRequest<ChunkRecord | undefined>,
	);
	const usage = (await requestResult(
		usageStore.get(CACHE_USAGE_KEY) as IDBRequest<UsageRecord | undefined>,
	)) ?? { key: CACHE_USAGE_KEY, totalBytes: 0 };
	chunks.put(record);
	usage.totalBytes += record.size - (previous?.size ?? 0);
	usageStore.put(usage);
	await transactionDone(transaction);
	scheduleEviction();
}

function persistChunkInBackground(record: ChunkRecord): void {
	persistenceQueue = persistenceQueue
		.catch(() => undefined)
		.then(() => putChunk(record));
	void persistenceQueue.catch((error: unknown) =>
		console.warn("[cd2-media-cache] 分块后台持久化失败:", error),
	);
}

function scheduleEviction(): void {
	if (evictionPromise) return;
	evictionPromise = evictOldChunks().finally(() => {
		evictionPromise = undefined;
	});
}

async function evictOldChunks(): Promise<void> {
	const database = await openDatabase();
	const transaction = database.transaction(
		[CHUNK_STORE, META_STORE],
		"readwrite",
	);
	const chunks = transaction.objectStore(CHUNK_STORE);
	const usageStore = transaction.objectStore(META_STORE);
	const usage = (await requestResult(
		usageStore.get(CACHE_USAGE_KEY) as IDBRequest<UsageRecord | undefined>,
	)) ?? { key: CACHE_USAGE_KEY, totalBytes: 0 };
	if (usage.totalBytes <= MAX_CACHE_SIZE) {
		await transactionDone(transaction);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const cursorRequest = chunks.index("lastAccess").openCursor();
		cursorRequest.onerror = () => reject(cursorRequest.error);
		cursorRequest.onsuccess = () => {
			const cursor = cursorRequest.result;
			if (!cursor || usage.totalBytes <= EVICT_TO_SIZE) {
				resolve();
				return;
			}
			const record = cursor.value as ChunkRecord;
			usage.totalBytes = Math.max(0, usage.totalBytes - record.size);
			cursor.delete();
			cursor.continue();
		};
	});
	usageStore.put(usage);
	await transactionDone(transaction);
}

async function fetchChunk(
	media: MediaRecord,
	index: number,
): Promise<ArrayBuffer> {
	const start = index * CHUNK_SIZE;
	const end = Math.min(media.totalSize - 1, start + CHUNK_SIZE - 1);
	const response = await fetch(media.sourceUrl, {
		headers: { Range: `bytes=${start}-${end}` },
		cache: "no-store",
		credentials: "include",
		redirect: "follow",
	});
	const contentRange = parseContentRange(response.headers.get("content-range"));
	if (!response.ok || !contentRange || contentRange.start !== start) {
		await response.body?.cancel();
		throw new Error(`CloudDrive2 Range 请求失败 (${response.status})`);
	}
	const data = await response.arrayBuffer();
	const expectedLength = end - start + 1;
	if (data.byteLength !== expectedLength) {
		throw new Error(
			`CloudDrive2 Range 长度异常 (${data.byteLength}/${expectedLength})`,
		);
	}
	const record: ChunkRecord = {
		id: `${media.key}:${index}`,
		mediaKey: media.key,
		index,
		data,
		size: data.byteLength,
		lastAccess: Date.now(),
	};
	rememberChunk(record.id, data);
	// Do not hold the first video/audio response behind an IndexedDB write. The
	// in-memory LRU makes the block immediately available to every concurrent
	// consumer while persistence continues in the background.
	persistChunkInBackground(record);
	return data;
}

async function getOrFetchChunk(
	media: MediaRecord,
	index: number,
): Promise<ArrayBuffer> {
	const id = `${media.key}:${index}`;
	const cached = await readChunk(id);
	if (cached) return cached;
	const pending = pendingChunks.get(id);
	if (pending) return pending;
	const request = fetchChunk(media, index).finally(() =>
		pendingChunks.delete(id),
	);
	pendingChunks.set(id, request);
	return request;
}

function createMediaStream(
	media: MediaRecord,
	start: number,
	end: number,
): ReadableStream<Uint8Array> {
	let position = start;
	let canceled = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (canceled || position > end) {
				controller.close();
				return;
			}
			try {
				const index = Math.floor(position / CHUNK_SIZE);
				const data = new Uint8Array(await getOrFetchChunk(media, index));
				const chunkStart = index * CHUNK_SIZE;
				const from = position - chunkStart;
				const length = Math.min(data.byteLength - from, end - position + 1);
				controller.enqueue(data.subarray(from, from + length));
				position += length;
			} catch (error) {
				controller.error(error);
			}
		},
		cancel() {
			canceled = true;
		},
	});
}

async function handleMediaRequest(request: Request): Promise<Response> {
	const requestUrl = new URL(request.url);
	const key = requestUrl.searchParams.get("key");
	const media = key ? await getMedia(key) : undefined;
	if (!media)
		return new Response("Media cache entry not found", { status: 404 });
	const commonHeaders = new Headers({
		"Accept-Ranges": "bytes",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store",
		"Content-Type": media.contentType,
		"Cross-Origin-Resource-Policy": "cross-origin",
	});
	if (request.method === "HEAD") {
		commonHeaders.set("Content-Length", String(media.totalSize));
		return new Response(null, { status: 200, headers: commonHeaders });
	}
	const range = parseRequestedRange(
		request.headers.get("range"),
		media.totalSize,
	);
	if (!range) {
		commonHeaders.set("Content-Range", `bytes */${media.totalSize}`);
		return new Response(null, { status: 416, headers: commonHeaders });
	}
	const length = range.end - range.start + 1;
	commonHeaders.set("Content-Length", String(length));
	if (range.partial) {
		commonHeaders.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${media.totalSize}`,
		);
	}
	return new Response(createMediaStream(media, range.start, range.end), {
		status: range.partial ? 206 : 200,
		headers: commonHeaders,
	});
}

export function registerMediaCacheFetchHandler(): void {
	const extensionOrigin = new URL(chrome.runtime.getURL("")).origin;
	globalThis.addEventListener("fetch", ((event: Event) => {
		const fetchEvent = event as ExtensionFetchEvent;
		const url = new URL(fetchEvent.request.url);
		if (url.origin !== extensionOrigin || url.pathname !== CACHE_RESOURCE_PATH)
			return;
		fetchEvent.respondWith(handleMediaRequest(fetchEvent.request));
	}) as EventListener);
}
