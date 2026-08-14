const EBML_HEADER = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const LANGUAGE = 0x22b59c;
const LANGUAGE_BCP47 = 0x22b59d;
const NAME = 0x536e;
const FLAG_DEFAULT = 0x88;
const FLAG_FORCED = 0x55aa;
const SUBTITLE_TRACK_TYPE = 17;
const INITIAL_READ_SIZE = 256 * 1024;

interface ElementHeader {
	id: number;
	dataOffset: number;
	dataSize: number;
	unknownSize: boolean;
}

export interface MkvSubtitleTrackMetadata {
	trackNumber: number;
	codecId: string;
	type: "srt" | "ass" | "ssa" | "vtt" | "unsupported";
	language?: string;
	trackName?: string;
	isDefault: boolean;
	isForced: boolean;
}

function vintWidth(firstByte: number): number {
	for (let width = 1; width <= 8; width += 1) {
		if (firstByte & (1 << (8 - width))) return width;
	}
	throw new Error("Invalid EBML variable integer");
}

function readElementId(
	data: Uint8Array,
	offset: number,
): { value: number; length: number } {
	const width = vintWidth(data[offset]);
	if (offset + width > data.length)
		throw new Error("Incomplete EBML element ID");
	let value = 0;
	for (let index = 0; index < width; index += 1)
		value = value * 256 + data[offset + index];
	return { value, length: width };
}

function readDataSize(
	data: Uint8Array,
	offset: number,
): { value: number; length: number; unknown: boolean } {
	const width = vintWidth(data[offset]);
	if (offset + width > data.length)
		throw new Error("Incomplete EBML element size");
	const mask = (1 << (8 - width)) - 1;
	let value = data[offset] & mask;
	let unknown = value === mask;
	for (let index = 1; index < width; index += 1) {
		value = value * 256 + data[offset + index];
		unknown = unknown && data[offset + index] === 0xff;
	}
	return { value, length: width, unknown };
}

function parseElementHeader(data: Uint8Array, offset: number): ElementHeader {
	if (offset >= data.length) throw new Error("Unexpected end of MKV metadata");
	const id = readElementId(data, offset);
	const size = readDataSize(data, offset + id.length);
	return {
		id: id.value,
		dataOffset: offset + id.length + size.length,
		dataSize: size.value,
		unknownSize: size.unknown,
	};
}

function* iterateChildren(
	data: Uint8Array,
	dataOffset: number,
	dataSize: number,
) {
	const end = Math.min(data.length, dataOffset + dataSize);
	let offset = dataOffset;
	while (offset < end) {
		let element: ElementHeader;
		try {
			element = parseElementHeader(data, offset);
		} catch {
			break;
		}
		yield element;
		if (element.unknownSize) break;
		const next = element.dataOffset + element.dataSize;
		if (next <= offset || next > data.length) break;
		offset = next;
	}
}

function readUint(data: Uint8Array, offset: number, length: number): number {
	let value = 0;
	for (let index = 0; index < length; index += 1)
		value = value * 256 + data[offset + index];
	return value;
}

function readUtf8(data: Uint8Array, offset: number, length: number): string {
	let end = offset + length;
	while (end > offset && data[end - 1] === 0) end -= 1;
	return new TextDecoder().decode(data.subarray(offset, end));
}

function codecType(codecId: string): MkvSubtitleTrackMetadata["type"] {
	switch (codecId) {
		case "S_TEXT/UTF8":
			return "srt";
		case "S_TEXT/ASS":
			return "ass";
		case "S_TEXT/SSA":
			return "ssa";
		case "S_TEXT/WEBVTT":
			return "vtt";
		default:
			return "unsupported";
	}
}

async function fetchRange(
	url: string,
	start: number,
	length: number,
	fetchFn: typeof fetch,
): Promise<Uint8Array> {
	const response = await fetchFn(url, {
		headers: { Range: `bytes=${start}-${start + length - 1}` },
	});
	if (response.status !== 206 && response.status !== 200) {
		throw new Error(`HTTP ${response.status} while reading MKV metadata`);
	}
	const data = new Uint8Array(await response.arrayBuffer());
	if (response.status === 200 && start > 0) {
		if (data.byteLength < start + length)
			throw new Error("视频地址不支持 HTTP Range");
		return data.slice(start, start + length);
	}
	return data;
}

function parseSeekHead(
	data: Uint8Array,
	seekHead: ElementHeader,
): Map<number, number> {
	const entries = new Map<number, number>();
	for (const seek of iterateChildren(
		data,
		seekHead.dataOffset,
		seekHead.dataSize,
	)) {
		if (seek.id !== SEEK) continue;
		let targetId = 0;
		let position = 0;
		for (const child of iterateChildren(data, seek.dataOffset, seek.dataSize)) {
			if (child.id === SEEK_ID) {
				targetId = readElementId(
					data.subarray(child.dataOffset, child.dataOffset + child.dataSize),
					0,
				).value;
			} else if (child.id === SEEK_POSITION) {
				position = readUint(data, child.dataOffset, child.dataSize);
			}
		}
		if (targetId) entries.set(targetId, position);
	}
	return entries;
}

function parseTracks(
	data: Uint8Array,
	tracks: ElementHeader,
): MkvSubtitleTrackMetadata[] {
	const results: MkvSubtitleTrackMetadata[] = [];
	for (const entry of iterateChildren(
		data,
		tracks.dataOffset,
		tracks.dataSize,
	)) {
		if (entry.id !== TRACK_ENTRY) continue;
		let trackNumber = 0;
		let trackType = 0;
		let codecId = "";
		let language: string | undefined;
		let trackName: string | undefined;
		let isDefault = true;
		let isForced = false;
		for (const child of iterateChildren(
			data,
			entry.dataOffset,
			entry.dataSize,
		)) {
			switch (child.id) {
				case TRACK_NUMBER:
					trackNumber = readUint(data, child.dataOffset, child.dataSize);
					break;
				case TRACK_TYPE:
					trackType = readUint(data, child.dataOffset, child.dataSize);
					break;
				case CODEC_ID:
					codecId = readUtf8(data, child.dataOffset, child.dataSize);
					break;
				case LANGUAGE:
					if (!language)
						language = readUtf8(data, child.dataOffset, child.dataSize);
					break;
				case LANGUAGE_BCP47:
					language = readUtf8(data, child.dataOffset, child.dataSize);
					break;
				case NAME:
					trackName = readUtf8(data, child.dataOffset, child.dataSize);
					break;
				case FLAG_DEFAULT:
					isDefault = readUint(data, child.dataOffset, child.dataSize) !== 0;
					break;
				case FLAG_FORCED:
					isForced = readUint(data, child.dataOffset, child.dataSize) !== 0;
					break;
			}
		}
		if (trackType === SUBTITLE_TRACK_TYPE) {
			results.push({
				trackNumber,
				codecId,
				type: codecType(codecId),
				language,
				trackName,
				isDefault,
				isForced,
			});
		}
	}
	return results;
}

/** 只读取 MKV 的 SeekHead 和 Tracks，不扫描 Cluster、字幕内容或内嵌字体。 */
export async function readMkvSubtitleTracks(
	url: string,
	fetchFn: typeof fetch,
): Promise<MkvSubtitleTrackMetadata[]> {
	const initial = await fetchRange(url, 0, INITIAL_READ_SIZE, fetchFn);
	const ebml = parseElementHeader(initial, 0);
	if (ebml.id !== EBML_HEADER) throw new Error("不是有效的 MKV/EBML 文件");
	const segmentOffset = ebml.dataOffset + ebml.dataSize;
	const segment = parseElementHeader(initial, segmentOffset);
	if (segment.id !== SEGMENT) throw new Error("MKV Segment 不存在");
	const segmentDataOffset = segment.dataOffset;

	let seekEntries = new Map<number, number>();
	for (const child of iterateChildren(
		initial,
		segmentDataOffset,
		initial.length - segmentDataOffset,
	)) {
		if (
			child.id === TRACKS &&
			child.dataOffset + child.dataSize <= initial.length
		) {
			return parseTracks(initial, child);
		}
		if (
			child.id === SEEK_HEAD &&
			child.dataOffset + child.dataSize <= initial.length
		) {
			seekEntries = parseSeekHead(initial, child);
		}
	}

	const tracksPosition = seekEntries.get(TRACKS);
	if (tracksPosition === undefined)
		throw new Error("MKV SeekHead 中未找到 Tracks");
	const absoluteOffset = segmentDataOffset + tracksPosition;
	let tracksData = await fetchRange(url, absoluteOffset, 64 * 1024, fetchFn);
	const tracks = parseElementHeader(tracksData, 0);
	if (tracks.id !== TRACKS) throw new Error("MKV Tracks 定位无效");
	const totalSize = tracks.dataOffset + tracks.dataSize;
	if (totalSize > tracksData.length) {
		tracksData = await fetchRange(url, absoluteOffset, totalSize, fetchFn);
	}
	return parseTracks(tracksData, parseElementHeader(tracksData, 0));
}
