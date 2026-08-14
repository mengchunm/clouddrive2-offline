import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import LibAV from "@libav.js/variant-default";

const workerSource = readFileSync(
	new URL("../src/libav-worker.ts", import.meta.url),
	"utf8",
);
const workerBuildConfig = readFileSync(
	new URL("../vite.libav-worker.config.ts", import.meta.url),
	"utf8",
);
const playerSource = readFileSync(
	new URL("../../artplayer/src/player.ts", import.meta.url),
	"utf8",
);
const manifest = JSON.parse(
	readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
);
const subtitleBridgeSource = readFileSync(
	new URL("../src/compat/libav-subtitles.ts", import.meta.url),
	"utf8",
);
if (
	!workerSource.includes('from "virtual:cd2-libav-factory"') ||
	!workerSource.includes('from "virtual:cd2-libav-wasm-base64"') ||
	!workerSource.includes("wasmBinary: getLibavWasmBinary()") ||
	!workerSource.includes("let libavPromise:") ||
	!workerSource.includes("queueSubtitleExtraction(message)") ||
	workerSource.includes("libav.terminate()") ||
	workerSource.includes("toImport:") ||
	workerSource.includes("wasmurl:") ||
	!workerBuildConfig.includes("cd2-inline-libav-runtime") ||
	!workerBuildConfig.includes('.toString("base64")')
) {
	throw new Error(
		"the extension subtitle worker must embed both the libav factory and WASM bytes",
	);
}
const accessibleResources = manifest.web_accessible_resources?.flatMap(
	(resource) => resource.resources ?? [],
);
if (accessibleResources?.includes("libav/*")) {
	throw new Error(
		"the inlined libav runtime must not ship a duplicate asset copy",
	);
}
if (
	!workerSource.includes('type: "cancel-extract"') ||
	!workerSource.includes("cancelExtraction(message.requestId)") ||
	!workerSource.includes("throwIfCanceled(request.requestId)") ||
	!subtitleBridgeSource.includes('"cd2-libav-cancel-subtitle"') ||
	!subtitleBridgeSource.includes('type: "cancel-extract"') ||
	!playerSource.includes('currentPlayer.on("video:seeking"') ||
	!playerSource.includes("cancelActiveLibavSubtitleExtraction()") ||
	!playerSource.includes("!state.loading) return") ||
	!playerSource.includes("state.requestNonce === requestNonce")
) {
	throw new Error(
		"only stale subtitle prefetch must be canceled through the libav worker",
	);
}
if (
	!playerSource.includes("lookBehind = 1") ||
	!playerSource.includes("lookAhead = 1") ||
	!playerSource.includes("coveringRange.end - 2") ||
	!playerSource.includes("coveringRange.end - 1") ||
	!playerSource.includes("addCoveredSubtitleRange(state.ranges")
) {
	throw new Error(
		"the first remote subtitle read must stay tiny and extend with short overlapping windows",
	);
}

const directory = mkdtempSync(path.join(tmpdir(), "cd2-libav-mkv-"));
const subtitlePath = path.join(directory, "sample.ass");
const srtPath = path.join(directory, "sample.srt");
const videoPath = path.join(directory, "sample.mkv");

try {
	writeFileSync(
		subtitlePath,
		`[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,字幕测试
`,
	);
	writeFileSync(
		srtPath,
		`1
00:00:00,100 --> 00:00:00,900
SubRip 字幕测试
`,
	);
	const ffmpeg = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=size=16x16:rate=1:duration=1",
			"-i",
			subtitlePath,
			"-i",
			srtPath,
			"-map",
			"0:v",
			"-map",
			"1:s",
			"-map",
			"2:s",
			"-c:v",
			"libx264",
			"-c:s:0",
			"ass",
			"-c:s:1",
			"srt",
			"-y",
			videoPath,
		],
		{ encoding: "utf8" },
	);
	if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr);

	const file = readFileSync(videoPath);
	const libav = await LibAV.LibAV({ noworker: true, nothreads: true });
	libav.onblockread = async (name, position, length) => {
		const end = Math.min(position + Math.max(length, 64 * 1024), file.length);
		await libav.ff_block_reader_dev_send(
			name,
			position,
			file.subarray(position, end),
		);
	};
	await libav.mkblockreaderdev("input.mkv", file.length);
	const [formatContext, streams] =
		await libav.ff_init_demuxer_file("input.mkv");
	const subtitleStreams = streams.filter(
		(stream) => stream.codec_type === libav.AVMEDIA_TYPE_SUBTITLE,
	);
	if (subtitleStreams.length !== 2)
		throw new Error(
			`libav found ${subtitleStreams.length} subtitle streams instead of 2`,
		);
	const subtitleCodecs = new Map();
	for (const stream of subtitleStreams) {
		subtitleCodecs.set(
			stream.index,
			await libav.avcodec_get_name(stream.codec_id),
		);
	}
	const assStream = subtitleStreams.find(
		(stream) => subtitleCodecs.get(stream.index) === "ass",
	);
	const subripStream = subtitleStreams.find(
		(stream) => subtitleCodecs.get(stream.index) === "subrip",
	);
	if (!assStream || !subripStream) {
		throw new Error(
			`Unexpected subtitle codecs: ${[...subtitleCodecs.values()].join(", ")}`,
		);
	}
	const codecParameters = await libav.ff_copyout_codecpar(assStream.codecpar);
	const packet = await libav.av_packet_alloc();
	const subtitlePackets = new Map(
		subtitleStreams.map((stream) => [stream.index, []]),
	);
	while (true) {
		const [result, packets] = await libav.ff_read_frame_multi(
			formatContext,
			packet,
			{ limit: 256 * 1024 },
		);
		for (const stream of subtitleStreams) {
			subtitlePackets.get(stream.index).push(...(packets[stream.index] ?? []));
		}
		if (result !== -libav.EAGAIN) break;
	}
	const assPackets = subtitlePackets.get(assStream.index);
	const subripPackets = subtitlePackets.get(subripStream.index);
	if (assPackets.length === 0) {
		throw new Error("libav found the ASS track but returned no packets");
	}
	if (subripPackets.length === 0) {
		throw new Error("libav found the SubRip track but returned no packets");
	}
	const assPacketText = new TextDecoder().decode(assPackets[0].data);
	if (!assPacketText.includes("字幕测试")) {
		throw new Error(`Unexpected ASS packet: ${assPacketText}`);
	}
	const subripPacketText = new TextDecoder().decode(subripPackets[0].data);
	if (!subripPacketText.includes("SubRip 字幕测试")) {
		throw new Error(`Unexpected SubRip packet: ${subripPacketText}`);
	}
	if (!codecParameters.extradata?.length) {
		throw new Error("libav returned no ASS CodecPrivate data");
	}
	console.log(
		`libav Matroska check passed: codecs=ass,subrip, packets=${assPackets.length + subripPackets.length}`,
	);
	await libav.av_packet_free_js(packet);
	await libav.avformat_close_input_js(formatContext);
	await libav.unlink("input.mkv");
	libav.terminate();
} finally {
	rmSync(directory, { recursive: true, force: true });
}
