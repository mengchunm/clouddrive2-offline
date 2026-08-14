import LibAVFactory from "virtual:cd2-libav-factory";
import libavWasmBase64 from "virtual:cd2-libav-wasm-base64";
import LibAV from "@libav.js/variant-default";

interface ExtractRequest {
	type: "extract";
	requestId: string;
	videoUrl: string;
	fileSize: number;
	subtitleIndex: number;
	startTime: number;
	endTime: number;
}

interface CancelExtractRequest {
	type: "cancel-extract";
	requestId: string;
}

interface RangeResponse {
	type: "range-response";
	requestId: string;
	position: number;
	data?: ArrayBuffer;
	error?: string;
}

interface PendingRange {
	extractRequestId: string;
	resolve: (data: Uint8Array) => void;
	reject: (error: Error) => void;
}

type LibAVInstance = Awaited<ReturnType<typeof LibAV.LibAV>>;
type LibAVStream = Awaited<
	ReturnType<LibAVInstance["ff_init_demuxer_file"]>
>[1][number];

interface WorkerScope {
	location: Location;
	postMessage(message: unknown, transfer?: Transferable[]): void;
	addEventListener(
		type: "message",
		listener: (
			event: MessageEvent<
				ExtractRequest | CancelExtractRequest | RangeResponse
			>,
		) => void,
	): void;
}

const scope = self as unknown as WorkerScope;
const pendingRanges = new Map<string, PendingRange>();
const canceledExtractions = new Set<string>();
let rangeSequence = 0;
let libavWasmBinary: Uint8Array | null = null;
let libavPromise: Promise<LibAVInstance> | null = null;
let extractionQueue: Promise<void> = Promise.resolve();

function getLibavWasmBinary(): Uint8Array {
	if (libavWasmBinary) return libavWasmBinary;
	const binary = atob(libavWasmBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	libavWasmBinary = bytes;
	return bytes;
}

async function getLibav(): Promise<LibAVInstance> {
	if (!libavPromise) {
		libavPromise = LibAV.LibAV({
			noworker: true,
			nothreads: true,
			factory: (options: Record<string, unknown>) =>
				LibAVFactory({
					...options,
					wasmBinary: getLibavWasmBinary(),
				}),
		});
	}
	try {
		return await libavPromise;
	} catch (error) {
		libavPromise = null;
		throw error;
	}
}

function requestRange(
	videoUrl: string,
	position: number,
	length: number,
	extractRequestId: string,
): Promise<Uint8Array> {
	const requestId = `range-${++rangeSequence}`;
	return new Promise((resolve, reject) => {
		if (canceledExtractions.has(extractRequestId)) {
			reject(new Error("Operation canceled"));
			return;
		}
		pendingRanges.set(requestId, { extractRequestId, resolve, reject });
		scope.postMessage({
			type: "range-request",
			requestId,
			videoUrl,
			position,
			length: Math.min(Math.max(length, 1024 * 1024), 4 * 1024 * 1024),
		});
	});
}

function throwIfCanceled(requestId: string): void {
	if (canceledExtractions.has(requestId)) {
		throw new Error("Operation canceled");
	}
}

function cancelExtraction(requestId: string): void {
	canceledExtractions.add(requestId);
	for (const [rangeRequestId, pending] of pendingRanges) {
		if (pending.extractRequestId !== requestId) continue;
		pendingRanges.delete(rangeRequestId);
		pending.reject(new Error("Operation canceled"));
	}
}

function combineInt64(low?: number, high?: number): number | null {
	if (low === undefined || high === undefined) return null;
	if (low === -1 && high === -2147483648) return null;
	return high * 0x1_0000_0000 + (low >>> 0);
}

function splitInt64(value: number): [number, number] {
	const integer = BigInt(Math.trunc(value));
	return [
		Number(BigInt.asIntN(32, integer)),
		Number(BigInt.asIntN(32, integer >> 32n)),
	];
}

function formatAssTimestamp(seconds: number): string {
	const centiseconds = Math.max(0, Math.round(seconds * 100));
	const hours = Math.floor(centiseconds / 360000);
	const minutes = Math.floor((centiseconds % 360000) / 6000);
	const secs = Math.floor((centiseconds % 6000) / 100);
	const fraction = centiseconds % 100;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function formatVttTimestamp(seconds: number): string {
	const milliseconds = Math.max(0, Math.round(seconds * 1000));
	const hours = Math.floor(milliseconds / 3_600_000);
	const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
	const secs = Math.floor((milliseconds % 60_000) / 1000);
	const fraction = milliseconds % 1000;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

function splitAssPacket(value: string): string[] | null {
	const fields: string[] = [];
	let start = 0;
	for (let index = 0; index < 8; index += 1) {
		const comma = value.indexOf(",", start);
		if (comma < 0) return null;
		fields.push(value.slice(start, comma));
		start = comma + 1;
	}
	fields.push(value.slice(start));
	return fields;
}

function assembleAss(
	header: string,
	packets: Array<{ text: string; start: number; duration: number }>,
): string {
	const lineEnding = header.includes("\r\n") ? "\r\n" : "\n";
	const normalizedHeader = header.replace(/\0+$/g, "").trimEnd();
	const dialogues: string[] = [];
	for (const packet of packets) {
		const fields = splitAssPacket(packet.text);
		if (!fields) continue;
		const end = packet.start + Math.max(packet.duration, 0.01);
		dialogues.push(
			`Dialogue: ${fields[1]},${formatAssTimestamp(packet.start)},${formatAssTimestamp(end)},${fields.slice(2).join(",")}`,
		);
	}
	const defaultFormat =
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";
	const eventsMatch = /^\[Events\][ \t]*$/im.exec(normalizedHeader);
	if (!eventsMatch || eventsMatch.index === undefined) {
		return `${normalizedHeader}${lineEnding}${lineEnding}[Events]${lineEnding}${defaultFormat}${lineEnding}${dialogues.join(lineEnding)}${lineEnding}`;
	}
	const bodyStart = eventsMatch.index + eventsMatch[0].length;
	const remaining = normalizedHeader.slice(bodyStart);
	const nextSection = /^[ \t]*\[[^\]\r\n]+\][ \t]*$/m.exec(remaining);
	const insertAt =
		nextSection?.index === undefined
			? normalizedHeader.length
			: bodyStart + nextSection.index;
	const prefix = normalizedHeader.slice(0, insertAt).trimEnd();
	const suffix = normalizedHeader.slice(insertAt).trimStart();
	const eventsBody = normalizedHeader.slice(bodyStart, insertAt);
	const formatLine = /^Format\s*:/im.test(eventsBody)
		? ""
		: `${defaultFormat}${lineEnding}`;
	return `${prefix}${lineEnding}${formatLine}${dialogues.join(lineEnding)}${
		suffix ? `${lineEnding}${suffix}` : ""
	}${lineEnding}`;
}

function assembleWebVtt(
	packets: Array<{ text: string; start: number; duration: number }>,
): string {
	const cues = packets
		.map((packet) => {
			const text = packet.text.replace(/\0+$/g, "").trim();
			if (!text) return "";
			const duration = packet.duration > 0 ? packet.duration : 2;
			return `${formatVttTimestamp(packet.start)} --> ${formatVttTimestamp(
				packet.start + Math.max(duration, 0.1),
			)}\n${text}`;
		})
		.filter(Boolean);
	return `WEBVTT\n\n${cues.join("\n\n")}${cues.length ? "\n" : ""}`;
}

function packetTime(
	low: number | undefined,
	high: number | undefined,
	stream: LibAVStream,
): number | null {
	const timestamp = combineInt64(low, high);
	return timestamp === null
		? null
		: (timestamp * stream.time_base_num) / stream.time_base_den;
}

async function extractSubtitle(request: ExtractRequest) {
	throwIfCanceled(request.requestId);
	const libav = await getLibav();
	throwIfCanceled(request.requestId);
	const filename = `cd2-${request.requestId}.mkv`;
	let formatContext = 0;
	let packet = 0;
	let lastRangeError: string | null = null;
	try {
		libav.onblockread = async (name, position, length) => {
			try {
				throwIfCanceled(request.requestId);
				const data = await requestRange(
					request.videoUrl,
					position,
					length,
					request.requestId,
				);
				throwIfCanceled(request.requestId);
				await libav.ff_block_reader_dev_send(name, position, data);
			} catch (error) {
				lastRangeError = error instanceof Error ? error.message : String(error);
				await libav.ff_block_reader_dev_send(name, position, null, {
					error: lastRangeError,
				});
			}
		};
		throwIfCanceled(request.requestId);
		await libav.mkblockreaderdev(filename, request.fileSize);
		const initialized = await libav.ff_init_demuxer_file(filename);
		throwIfCanceled(request.requestId);
		formatContext = initialized[0];
		const streams = initialized[1];
		const subtitleStreams = streams.filter(
			(stream) => stream.codec_type === libav.AVMEDIA_TYPE_SUBTITLE,
		);
		const subtitleStream = subtitleStreams[request.subtitleIndex];
		if (!subtitleStream) {
			throw new Error(`找不到第 ${request.subtitleIndex + 1} 条字幕轨道`);
		}
		const codecName = await libav.avcodec_get_name(subtitleStream.codec_id);
		if (!new Set(["ass", "ssa", "subrip", "webvtt"]).has(codecName)) {
			throw new Error(`libav 暂未接入 ${codecName} 字幕输出`);
		}
		const parameters = await libav.ff_copyout_codecpar(subtitleStream.codecpar);
		const videoStream = streams.find(
			(stream) => stream.codec_type === libav.AVMEDIA_TYPE_VIDEO,
		);
		const seekStream = videoStream ?? subtitleStream;
		const seekTimestamp =
			(request.startTime * seekStream.time_base_den) / seekStream.time_base_num;
		const [seekLow, seekHigh] = splitInt64(seekTimestamp);
		const seekResult = await libav.av_seek_frame(
			formatContext,
			seekStream.index,
			seekLow,
			seekHigh,
			libav.AVSEEK_FLAG_BACKWARD,
		);
		if (seekResult < 0 && request.startTime > 0) {
			throw new Error(`MKV 时间定位失败: ${libav.ff_error(seekResult)}`);
		}

		packet = await libav.av_packet_alloc();
		const streamByIndex = new Map(
			streams.map((stream) => [stream.index, stream]),
		);
		const extractedPackets: Array<{
			text: string;
			start: number;
			duration: number;
		}> = [];
		while (true) {
			throwIfCanceled(request.requestId);
			const result = await libav.av_read_frame(formatContext, packet);
			throwIfCanceled(request.requestId);
			if (result < 0) break;
			const streamIndex = await libav.AVPacket_stream_index(packet);
			const stream = streamByIndex.get(streamIndex);
			if (!stream) {
				await libav.av_packet_unref(packet);
				continue;
			}
			const pts = packetTime(
				await libav.AVPacket_pts(packet),
				await libav.AVPacket_ptshi(packet),
				stream,
			);
			if (pts !== null && pts > request.endTime) {
				await libav.av_packet_unref(packet);
				break;
			}
			if (streamIndex === subtitleStream.index && pts !== null) {
				const copied = await libav.ff_copyout_packet(packet);
				const rawDuration = combineInt64(copied.duration, copied.durationhi);
				extractedPackets.push({
					text: new TextDecoder().decode(copied.data),
					start: pts,
					duration:
						rawDuration === null
							? 0
							: (rawDuration * stream.time_base_num) / stream.time_base_den,
				});
			}
			await libav.av_packet_unref(packet);
		}
		const header = new TextDecoder().decode(
			parameters.extradata ?? new Uint8Array(),
		);
		const isAss = codecName === "ass" || codecName === "ssa";
		return {
			content: isAss
				? assembleAss(header, extractedPackets)
				: assembleWebVtt(extractedPackets),
			codec: codecName,
			format: isAss ? "ass" : "vtt",
			startTime: request.startTime,
			endTime: request.endTime,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			lastRangeError
				? `${message}（Range 请求失败: ${lastRangeError}）`
				: message,
		);
	} finally {
		if (packet) await libav.av_packet_free_js(packet);
		if (formatContext) await libav.avformat_close_input_js(formatContext);
		await libav.unlink(filename).catch(() => undefined);
		canceledExtractions.delete(request.requestId);
	}
}

function queueSubtitleExtraction(request: ExtractRequest) {
	const result = extractionQueue
		.then(() => extractSubtitle(request))
		.finally(() => canceledExtractions.delete(request.requestId));
	extractionQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

scope.addEventListener(
	"message",
	(
		event: MessageEvent<ExtractRequest | CancelExtractRequest | RangeResponse>,
	) => {
		const message = event.data;
		if (message.type === "range-response") {
			const pending = pendingRanges.get(message.requestId);
			if (!pending) return;
			pendingRanges.delete(message.requestId);
			if (message.error) pending.reject(new Error(message.error));
			else pending.resolve(new Uint8Array(message.data ?? new ArrayBuffer(0)));
			return;
		}
		if (message.type === "cancel-extract") {
			cancelExtraction(message.requestId);
			return;
		}
		if (message.type !== "extract") return;
		void queueSubtitleExtraction(message)
			.then((result) =>
				scope.postMessage({
					type: "extract-result",
					requestId: message.requestId,
					...result,
				}),
			)
			.catch((error: unknown) =>
				scope.postMessage({
					type: "extract-result",
					requestId: message.requestId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	},
);
