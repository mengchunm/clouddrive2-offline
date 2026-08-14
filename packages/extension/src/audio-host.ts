import { registerAc3Decoder } from "@mediabunny/ac3";
import {
	type AudioSample,
	AudioSampleSink,
	CustomSource,
	Input,
	MATROSKA,
} from "mediabunny";
import { warmUpAc3Decoder } from "./audio-decoder-warmup";

interface OpenRequest {
	type: "open";
	requestId: string;
	videoUrl: string;
	fileSize: number;
}

interface DecodeRequest {
	type: "decode";
	requestId: string;
	startTime: number;
	duration: number;
}

interface CloseRequest {
	type: "close";
}

interface CancelDecodeRequest {
	type: "cancel-decode";
}

type HostRequest =
	| OpenRequest
	| DecodeRequest
	| CancelDecodeRequest
	| CloseRequest;

interface RangeResponse {
	type: "range-response";
	requestId: string;
	data?: ArrayBuffer;
	error?: string;
}

interface PendingRangeRequest {
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
	timeoutId: number;
}

let input: Input | null = null;
let sink: AudioSampleSink | null = null;
let generation = 0;
let decodeGeneration = 0;
let activeDecodeRequestId: string | null = null;
let rangeSequence = 0;
const pendingRanges = new Map<string, PendingRangeRequest>();
const PCM_CHUNK_DURATION = 0.5;
const PCM_STARTUP_STREAM_DURATION = 1;
let decoderRegistrationError: Error | null = null;

function describeError(error: unknown): string {
	if (error instanceof DOMException) {
		return `${error.name}: ${error.message || "浏览器拒绝了 WebAssembly Worker 操作"}`;
	}
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}

async function warmUpDecoderWithRetry(): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await warmUpAc3Decoder();
			return;
		} catch (error) {
			lastError = error;
			if (attempt === 0) {
				await new Promise((resolve) => window.setTimeout(resolve, 250));
			}
		}
	}
	throw lastError;
}

let decoderWarmupScheduled = false;
let decoderWarmupStarted = false;

function scheduleDecoderWarmup(): void {
	if (decoderWarmupScheduled || decoderWarmupStarted) return;
	decoderWarmupScheduled = true;
	window.setTimeout(() => {
		decoderWarmupScheduled = false;
		// A real media open takes priority and initializes the same decoder path.
		if (input) return;
		decoderWarmupStarted = true;
		const startedAt = performance.now();
		void warmUpDecoderWithRetry()
			.then(() => {
				console.info(
					`[cd2-audio-host] E-AC-3 解码器预热完成: ${Math.round(performance.now() - startedAt)}ms`,
				);
			})
			.catch((error: unknown) => {
				console.warn(
					`[cd2-audio-host] E-AC-3 解码器预热失败（正式播放仍会按需初始化）: ${describeError(error)}`,
				);
			});
	}, 250);
}

function closeInput(): void {
	generation += 1;
	decodeGeneration += 1;
	activeDecodeRequestId = null;
	sink = null;
	input?.dispose();
	input = null;
	for (const pending of pendingRanges.values()) {
		window.clearTimeout(pending.timeoutId);
		pending.reject(new Error("音频读取已取消"));
	}
	pendingRanges.clear();
}

function readRange(
	port: MessagePort,
	videoUrl: string,
	start: number,
	end: number,
): Promise<Uint8Array> {
	const requestId = `range_${Date.now()}_${++rangeSequence}`;
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			pendingRanges.delete(requestId);
			reject(new Error("CloudDrive2 音频 Range 请求超时"));
		}, 60000);
		pendingRanges.set(requestId, { resolve, reject, timeoutId });
		port.postMessage({
			type: "range-request",
			requestId,
			videoUrl,
			position: start,
			length: end - start,
		});
	});
}

async function openAudio(
	port: MessagePort,
	request: OpenRequest,
): Promise<void> {
	closeInput();
	const openGeneration = generation;
	const nextInput = new Input({
		formats: [MATROSKA],
		source: new CustomSource({
			getSize: () => request.fileSize,
			read: (start, end) => readRange(port, request.videoUrl, start, end),
			maxCacheSize: 24 * 1024 * 1024,
			prefetchProfile: "network",
		}),
	});
	input = nextInput;
	try {
		const track = await nextInput.getPrimaryAudioTrack();
		if (!track) throw new Error("视频中没有音轨");
		const [codec, channels, sampleRate, name, language] = await Promise.all([
			track.getCodec(),
			track.getNumberOfChannels(),
			track.getSampleRate(),
			track.getName(),
			track.getLanguageCode(),
		]);
		if (input !== nextInput || generation !== openGeneration) return;
		if (codec !== "ac3" && codec !== "eac3") {
			closeInput();
			port.postMessage({
				type: "open-result",
				requestId: request.requestId,
				supported: false,
				codec,
			});
			return;
		}
		sink = new AudioSampleSink(track);
		port.postMessage({
			type: "open-result",
			requestId: request.requestId,
			supported: true,
			codec,
			channels,
			sampleRate,
			name,
			language,
		});
	} catch (error) {
		if (input === nextInput) closeInput();
		throw error;
	}
}

function copyChannel(sample: AudioSample, channel: number): Float32Array {
	const data = new Float32Array(
		sample.allocationSize({
			planeIndex: channel,
			format: "f32-planar",
		}) / Float32Array.BYTES_PER_ELEMENT,
	);
	sample.copyTo(data, { planeIndex: channel, format: "f32-planar" });
	return data;
}

function downmixToStereo(
	channels: Float32Array[],
	frameCount: number,
): [Float32Array, Float32Array] {
	const left = new Float32Array(frameCount);
	const right = new Float32Array(frameCount);
	if (channels.length === 1) {
		left.set(channels[0]);
		right.set(channels[0]);
		return [left, right];
	}
	if (channels.length === 2) {
		left.set(channels[0]);
		right.set(channels[1]);
		return [left, right];
	}

	// FFmpeg's common 5.1 order is FL, FR, FC, LFE, SL, SR. Conservative
	// coefficients leave headroom while retaining dialogue and surround cues.
	const fl = channels[0];
	const fr = channels[1] ?? fl;
	const fc = channels[2];
	const lfe = channels[3];
	const sl = channels[4];
	const sr = channels[5] ?? sl;
	for (let index = 0; index < frameCount; index += 1) {
		const mixedLeft =
			0.5 * fl[index] +
			0.354 * (fc?.[index] ?? 0) +
			0.18 * (lfe?.[index] ?? 0) +
			0.354 * (sl?.[index] ?? 0);
		const mixedRight =
			0.5 * fr[index] +
			0.354 * (fc?.[index] ?? 0) +
			0.18 * (lfe?.[index] ?? 0) +
			0.354 * (sr?.[index] ?? 0);
		left[index] = Math.max(-1, Math.min(1, mixedLeft));
		right[index] = Math.max(-1, Math.min(1, mixedRight));
	}
	return [left, right];
}

function postPcmChunk(
	port: MessagePort,
	requestId: string,
	startTime: number,
	sampleRate: number,
	leftParts: Float32Array[],
	rightParts: Float32Array[],
	totalFrames: number,
): void {
	if (!totalFrames) return;
	const left = new Float32Array(totalFrames);
	const right = new Float32Array(totalFrames);
	let offset = 0;
	for (let index = 0; index < leftParts.length; index += 1) {
		left.set(leftParts[index], offset);
		right.set(rightParts[index], offset);
		offset += leftParts[index].length;
	}
	port.postMessage(
		{
			type: "decode-chunk",
			requestId,
			startTime,
			duration: totalFrames / sampleRate,
			sampleRate,
			left: left.buffer,
			right: right.buffer,
		},
		[left.buffer, right.buffer],
	);
}

async function decodeAudio(
	port: MessagePort,
	request: DecodeRequest,
): Promise<void> {
	const activeSink = sink;
	const currentDecodeGeneration = ++decodeGeneration;
	activeDecodeRequestId = request.requestId;
	if (!activeSink) throw new Error("音频解码器尚未初始化");
	const requestedStart = Math.max(0, request.startTime);
	const requestedDuration = Math.min(15, Math.max(1, request.duration));
	const requestedEnd = requestedStart + requestedDuration;
	let leftParts: Float32Array[] = [];
	let rightParts: Float32Array[] = [];
	let chunkStartTime = Number.NaN;
	let sampleRate = 0;
	let chunkFrames = 0;
	let decodedFrames = 0;
	let emittedFirstChunk = false;

	for await (const sample of activeSink.samples(requestedStart, requestedEnd)) {
		try {
			if (currentDecodeGeneration !== decodeGeneration || sink !== activeSink) {
				return;
			}
			if (!Number.isFinite(chunkStartTime)) chunkStartTime = sample.timestamp;
			sampleRate = sample.sampleRate;
			const channels = Array.from(
				{ length: sample.numberOfChannels },
				(_, channel) => copyChannel(sample, channel),
			);
			const [left, right] = downmixToStereo(channels, sample.numberOfFrames);
			leftParts.push(left);
			rightParts.push(right);
			chunkFrames += sample.numberOfFrames;
			decodedFrames += sample.numberOfFrames;
			// The very first decoded AC-3 frame is enough to start Web Audio.
			// Later messages are coalesced to keep MessagePort overhead bounded.
			if (
				!emittedFirstChunk ||
				decodedFrames <= sampleRate * PCM_STARTUP_STREAM_DURATION ||
				chunkFrames >= sampleRate * PCM_CHUNK_DURATION
			) {
				postPcmChunk(
					port,
					request.requestId,
					chunkStartTime,
					sampleRate,
					leftParts,
					rightParts,
					chunkFrames,
				);
				leftParts = [];
				rightParts = [];
				chunkFrames = 0;
				chunkStartTime = Number.NaN;
				emittedFirstChunk = true;
			}
		} finally {
			sample.close();
		}
	}
	if (currentDecodeGeneration !== decodeGeneration || sink !== activeSink)
		return;

	if (!decodedFrames || !sampleRate) {
		throw new Error("指定时间段没有可解码的 AC-3/E-AC-3 音频");
	}
	if (chunkFrames && Number.isFinite(chunkStartTime)) {
		postPcmChunk(
			port,
			request.requestId,
			chunkStartTime,
			sampleRate,
			leftParts,
			rightParts,
			chunkFrames,
		);
	}
	port.postMessage({
		type: "decode-result",
		requestId: request.requestId,
		duration: decodedFrames / sampleRate,
		sampleRate,
	});
	if (activeDecodeRequestId === request.requestId) activeDecodeRequestId = null;
}

window.addEventListener("message", (event: MessageEvent) => {
	if (
		event.source !== window.parent ||
		event.data?.type !== "cd2-audio-host-init" ||
		!event.ports[0]
	) {
		return;
	}
	const port = event.ports[0];
	port.addEventListener(
		"message",
		(portEvent: MessageEvent<HostRequest | RangeResponse>) => {
			const request = portEvent.data;
			if (request.type === "range-response") {
				const pending = pendingRanges.get(request.requestId);
				if (!pending) return;
				pendingRanges.delete(request.requestId);
				window.clearTimeout(pending.timeoutId);
				if (request.error) pending.reject(new Error(request.error));
				else
					pending.resolve(new Uint8Array(request.data ?? new ArrayBuffer(0)));
				return;
			}
			if (request.type === "close") {
				closeInput();
				return;
			}
			if (request.type === "cancel-decode") {
				decodeGeneration += 1;
				const requestId = activeDecodeRequestId;
				activeDecodeRequestId = null;
				if (requestId) {
					port.postMessage({
						type: "decode-result",
						requestId,
						error: "音频解码已取消",
					});
				}
				return;
			}
			if (decoderRegistrationError) {
				port.postMessage({
					type: `${request.type}-result`,
					requestId: request.requestId,
					error: `AC-3/E-AC-3 解码器注册失败: ${decoderRegistrationError.message}`,
				});
				return;
			}
			const operation =
				request.type === "open"
					? openAudio(port, request)
					: decodeAudio(port, request);
			void operation
				.catch((error: unknown) =>
					port.postMessage({
						type: `${request.type}-result`,
						requestId: request.requestId,
						error: error instanceof Error ? error.message : String(error),
					}),
				)
				.finally(() => {
					if (
						request.type === "decode" &&
						activeDecodeRequestId === request.requestId
					) {
						activeDecodeRequestId = null;
					}
				});
		},
	);
	port.start();
	// Complete the lightweight iframe handshake before decoder registration.
	// Port messages are processed in later tasks, so registration still finishes
	// before an open/decode request can run, while synchronous startup failures no
	// longer surface as an opaque 30-second host timeout.
	port.postMessage({ type: "host-ready" });
	try {
		registerAc3Decoder();
	} catch (error) {
		decoderRegistrationError =
			error instanceof Error ? error : new Error(String(error));
	}
	if (!decoderRegistrationError) scheduleDecoderWarmup();
});
