export {};

interface RangeRequest {
	type: "range-request";
	requestId: string;
	url: string;
	start: number;
	end: number;
	timeout: number;
	priority?: "audio" | "subtitle" | "normal";
}

interface HostInitMessage {
	type: "cd2-range-host-init";
}

const CHUNK_SIZE = 1024 * 1024;
const MAX_MEMORY_SIZE = 64 * 1024 * 1024;
const chunks = new Map<string, ArrayBuffer>();
const fileSizes = new Map<string, number>();
const MAX_CONCURRENT_FETCHES = 4;

interface FetchJob {
	priority: number;
	sequence: number;
	started: boolean;
	run: () => void;
}

interface ScheduledFetch<T> {
	promise: Promise<T>;
	promote(priority: RangeRequest["priority"]): void;
}

const fetchQueue: FetchJob[] = [];
const pendingChunks = new Map<string, ScheduledFetch<ArrayBuffer>>();
let activeFetches = 0;
let fetchSequence = 0;
let memoryBytes = 0;
let initialized = false;

function priorityValue(priority: RangeRequest["priority"]): number {
	if (priority === "audio") return 0;
	if (priority === "subtitle") return 1;
	return 2;
}

function pumpFetchQueue(): void {
	while (activeFetches < MAX_CONCURRENT_FETCHES && fetchQueue.length > 0) {
		fetchQueue.sort(
			(left, right) =>
				left.priority - right.priority || left.sequence - right.sequence,
		);
		const next = fetchQueue.shift();
		if (!next) return;
		activeFetches += 1;
		next.started = true;
		next.run();
	}
}

function scheduleFetch<T>(
	priority: RangeRequest["priority"],
	operation: () => Promise<T>,
): ScheduledFetch<T> {
	let job: FetchJob;
	const promise = new Promise<T>((resolve, reject) => {
		job = {
			priority: priorityValue(priority),
			sequence: ++fetchSequence,
			started: false,
			run: () => {
				void operation()
					.then(resolve, reject)
					.finally(() => {
						activeFetches -= 1;
						pumpFetchQueue();
					});
			},
		};
		fetchQueue.push(job);
		pumpFetchQueue();
	});
	return {
		promise,
		promote(nextPriority) {
			if (job.started) return;
			job.priority = Math.min(job.priority, priorityValue(nextPriority));
			pumpFetchQueue();
		},
	};
}

function chunkKey(url: string, index: number): string {
	return `${url}\n${index}`;
}

function remember(key: string, data: ArrayBuffer): void {
	const previous = chunks.get(key);
	if (previous) {
		memoryBytes -= previous.byteLength;
		chunks.delete(key);
	}
	chunks.set(key, data);
	memoryBytes += data.byteLength;
	while (memoryBytes > MAX_MEMORY_SIZE && chunks.size > 1) {
		const oldestKey = chunks.keys().next().value as string | undefined;
		if (!oldestKey) break;
		const oldest = chunks.get(oldestKey);
		chunks.delete(oldestKey);
		memoryBytes -= oldest?.byteLength ?? 0;
	}
}

function readMemory(key: string): ArrayBuffer | undefined {
	const data = chunks.get(key);
	if (!data) return undefined;
	chunks.delete(key);
	chunks.set(key, data);
	return data;
}

function parseContentRange(
	value: string | null,
): { start: number; end: number; total: number } | null {
	const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
	if (!match) return null;
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
	};
}

async function fetchChunk(
	url: string,
	index: number,
	timeout: number,
): Promise<ArrayBuffer> {
	const start = index * CHUNK_SIZE;
	const end = start + CHUNK_SIZE - 1;
	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), timeout);
	try {
		const response = await fetch(url, {
			headers: { Range: `bytes=${start}-${end}` },
			cache: "no-store",
			credentials: "include",
			redirect: "follow",
			signal: controller.signal,
		});
		const contentRange = parseContentRange(
			response.headers.get("content-range"),
		);
		if (!response.ok || !contentRange || contentRange.start !== start) {
			await response.body?.cancel();
			throw new Error(`CloudDrive2 Range 响应异常 (${response.status})`);
		}
		const data = await response.arrayBuffer();
		const expected = contentRange.end - contentRange.start + 1;
		if (data.byteLength !== expected) {
			throw new Error(
				`CloudDrive2 Range 长度异常 (${data.byteLength}/${expected})`,
			);
		}
		fileSizes.set(url, contentRange.total);
		return data;
	} finally {
		window.clearTimeout(timeoutId);
	}
}

async function getChunk(
	url: string,
	index: number,
	timeout: number,
	priority: RangeRequest["priority"],
): Promise<ArrayBuffer> {
	const key = chunkKey(url, index);
	const cached = readMemory(key);
	if (cached) return cached;
	const pending = pendingChunks.get(key);
	if (pending) {
		pending.promote(priority);
		return pending.promise;
	}
	const scheduled = scheduleFetch(priority, () =>
		fetchChunk(url, index, timeout),
	);
	const promise = scheduled.promise
		.then((data) => {
			remember(key, data);
			return data;
		})
		.finally(() => pendingChunks.delete(key));
	const request = { promise, promote: scheduled.promote };
	pendingChunks.set(key, request);
	return promise;
}

async function readRange(
	request: RangeRequest,
): Promise<{ data: ArrayBuffer; totalSize: number }> {
	if (
		!/^https?:\/\//i.test(request.url) ||
		!Number.isSafeInteger(request.start) ||
		!Number.isSafeInteger(request.end) ||
		request.start < 0 ||
		request.end < request.start
	) {
		throw new Error("Range 请求参数无效");
	}
	let totalSize = fileSizes.get(request.url);
	if (totalSize !== undefined && request.start >= totalSize) {
		return { data: new ArrayBuffer(0), totalSize };
	}
	const firstIndex = Math.floor(request.start / CHUNK_SIZE);
	const firstChunk = await getChunk(
		request.url,
		firstIndex,
		request.timeout,
		request.priority,
	);
	totalSize = fileSizes.get(request.url);
	if (!totalSize) throw new Error("CloudDrive2 Range 响应缺少文件总长度");
	if (request.start >= totalSize) {
		return { data: new ArrayBuffer(0), totalSize };
	}
	const effectiveEnd = Math.min(request.end, totalSize - 1);
	const length = effectiveEnd - request.start + 1;
	const output = new Uint8Array(length);
	let position = request.start;
	let outputOffset = 0;
	while (position <= effectiveEnd) {
		const index = Math.floor(position / CHUNK_SIZE);
		const chunk = new Uint8Array(
			index === firstIndex
				? firstChunk
				: await getChunk(request.url, index, request.timeout, request.priority),
		);
		const chunkStart = index * CHUNK_SIZE;
		const from = position - chunkStart;
		const copyLength = Math.min(chunk.byteLength - from, length - outputOffset);
		if (copyLength <= 0) {
			throw new Error(`Range 数据提前结束 (${outputOffset}/${length})`);
		}
		output.set(chunk.subarray(from, from + copyLength), outputOffset);
		position += copyLength;
		outputOffset += copyLength;
	}
	return { data: output.buffer, totalSize };
}

window.addEventListener("message", (event: MessageEvent<HostInitMessage>) => {
	if (
		initialized ||
		event.source !== window.parent ||
		event.data?.type !== "cd2-range-host-init" ||
		!event.ports[0]
	) {
		return;
	}
	initialized = true;
	const port = event.ports[0];
	port.addEventListener("message", (portEvent: MessageEvent<RangeRequest>) => {
		const request = portEvent.data;
		if (request.type !== "range-request") return;
		void readRange(request)
			.then(({ data, totalSize }) =>
				port.postMessage(
					{
						type: "range-response",
						requestId: request.requestId,
						data,
						totalSize,
					},
					[data],
				),
			)
			.catch((error: unknown) =>
				port.postMessage({
					type: "range-response",
					requestId: request.requestId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	});
	port.start();
	port.postMessage({ type: "host-ready" });
});
