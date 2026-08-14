import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = mkdtempSync(path.join(tmpdir(), "cd2-subtitle-parser-"));
const subtitlePath = path.join(directory, "sample.srt");
const mkvPath = path.join(directory, "sample.mkv");
const mp4Path = path.join(directory, "sample.mp4");

function createVideo(outputPath, subtitleCodec, extraArgs = []) {
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
			"-map",
			"0:v",
			"-map",
			"1:s",
			"-c:v",
			"libx264",
			"-c:s",
			subtitleCodec,
			"-metadata:s:s:0",
			"language=zho",
			...extraArgs,
			"-y",
			outputPath,
		],
		{ encoding: "utf8" },
	);
	if (ffmpeg.status !== 0)
		throw new Error(ffmpeg.stderr || "ffmpeg fixture generation failed");
}

function createRangeFetch(filePath) {
	const file = readFileSync(filePath);
	return async (_url, options = {}) => {
		const range = new Headers(options.headers).get("range");
		const match = range?.match(/bytes=(\d+)-(\d+)/);
		const start = match ? Number(match[1]) : 0;
		const requestedEnd = match ? Number(match[2]) : file.length - 1;
		const end = Math.min(requestedEnd, file.length - 1);
		return new Response(file.subarray(start, end + 1), {
			status: 206,
			headers: {
				"Content-Range": `bytes ${start}-${end}/${file.length}`,
				"Content-Length": String(end - start + 1),
			},
		});
	};
}

try {
	writeFileSync(subtitlePath, "1\n00:00:00,000 --> 00:00:01,000\n字幕测试\n");
	const assModuleUrl = pathToFileURL(path.resolve("src/utils/assToVtt.ts"));
	const { assToWebVtt } = await import(assModuleUrl.href);
	const fallbackVtt = assToWebVtt(
		"[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.20,Default,,0,0,0,,{\\b1}字幕\\N测试",
	);
	if (
		!fallbackVtt.includes("00:00:00.000 --> 00:00:01.200") ||
		!fallbackVtt.includes("字幕\n测试")
	) {
		throw new Error("ASS fallback conversion failed");
	}
	const noFormatFallbackVtt = assToWebVtt(
		"[Events]\nDialogue: 0,0:00:00.00,0:00:01.20,Default,,0,0,0,,省略Format也能显示",
	);
	if (!noFormatFallbackVtt.includes("省略Format也能显示")) {
		throw new Error("ASS fallback without Event Format failed");
	}
	const misplacedDialogueVtt = assToWebVtt(
		"[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n[Aegisub Project Garbage]\nLast Style Storage: Default\nDialogue: 0,0:00:02.00,0:00:03.20,Default,,0,0,0,,错误区段后的字幕也能保底显示",
	);
	if (!misplacedDialogueVtt.includes("错误区段后的字幕也能保底显示")) {
		throw new Error("ASS fallback outside Events section failed");
	}
	console.log("ASS to WebVTT fallback checks passed.");
	createVideo(mkvPath, "ass", ["-disposition:s:0", "forced+default"]);
	createVideo(mp4Path, "mov_text", ["-movflags", "+faststart"]);

	const mkvModuleUrl = pathToFileURL(path.resolve("src/utils/mkvMetadata.ts"));
	const { readMkvSubtitleTracks } = await import(mkvModuleUrl.href);
	const tracks = await readMkvSubtitleTracks(
		"memory://sample.mkv",
		createRangeFetch(mkvPath),
	);
	if (
		tracks.length !== 1 ||
		tracks[0].type !== "ass" ||
		tracks[0].language !== "zho" ||
		!tracks[0].isDefault ||
		!tracks[0].isForced
	) {
		throw new Error(`Unexpected MKV metadata: ${JSON.stringify(tracks)}`);
	}
	console.log("MKV metadata range parser checks passed.");
	const playerSource = readFileSync(
		new URL("../src/player.ts", import.meta.url),
		"utf8",
	);
	const memorySource = readFileSync(
		new URL("../src/memory.ts", import.meta.url),
		"utf8",
	);
	if (
		!playerSource.includes("subtitleMemory.get(_currentSubtitleVideoKey)") ||
		!playerSource.includes("return activateSubtitleSelection(") ||
		!playerSource.includes("audioFallbackPreparation.openResult") ||
		!playerSource.includes("_autoSubtitleActivationBarrier.then") ||
		!playerSource.includes("autoSubtitleScore") ||
		!memorySource.includes('"cd2_subtitle_mem"')
	) {
		throw new Error("Per-video automatic subtitle persistence is missing");
	}

	const { extractSubtitles } = await import("@cryguy/mkv-subtitle-extractor");
	const extractedTracks = await extractSubtitles("memory://sample.mkv", {
		fetch: createRangeFetch(mkvPath),
		concurrency: 4,
	});
	const extractedAss = new TextDecoder().decode(
		extractedTracks[0]?.output.subtitle,
	);
	if (!/Dialogue\s*:/i.test(extractedAss)) {
		throw new Error("MKV ASS extraction produced no Dialogue lines");
	}
	const extractedFallbackVtt = assToWebVtt(extractedAss);
	if (!extractedFallbackVtt.includes("字幕测试")) {
		throw new Error("Extracted MKV ASS could not be converted to WebVTT");
	}
	console.log("MKV ASS extraction and fallback checks passed.");

	const mp4ModuleUrl = pathToFileURL(path.resolve("src/utils/mp4Parser.ts"));
	const { extractMp4Subtitle } = await import(mp4ModuleUrl.href);
	const mp4Subtitles = await extractMp4Subtitle(
		"memory://sample.mp4",
		createRangeFetch(mp4Path),
	);
	if (mp4Subtitles.length !== 1) {
		throw new Error(
			`Unexpected MP4 subtitles: ${JSON.stringify(mp4Subtitles)}`,
		);
	}
	const vtt = await fetch(mp4Subtitles[0].url).then((response) =>
		response.text(),
	);
	URL.revokeObjectURL(mp4Subtitles[0].url);
	if (!vtt.includes("字幕测试"))
		throw new Error("MP4 subtitle content was not extracted");
	console.log("MP4 mov_text extraction checks passed.");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
