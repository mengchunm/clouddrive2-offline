import { readFileSync } from "node:fs";

const manifest = JSON.parse(
	readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
);
const hostHtml = readFileSync(
	new URL("../public/audio-host.html", import.meta.url),
	"utf8",
);
const hostBuildConfig = readFileSync(
	new URL("../vite.audio-host.config.ts", import.meta.url),
	"utf8",
);
const hostSource = readFileSync(
	new URL("../src/audio-host.ts", import.meta.url),
	"utf8",
);
const bridgeSource = readFileSync(
	new URL("../src/compat/audio-fallback.ts", import.meta.url),
	"utf8",
);
const mediaRangeSource = readFileSync(
	new URL("../src/compat/media-range.ts", import.meta.url),
	"utf8",
);
const rangeHostSource = readFileSync(
	new URL("../src/range-host.ts", import.meta.url),
	"utf8",
);
const controllerSource = readFileSync(
	new URL("../../artplayer/src/audioFallback.ts", import.meta.url),
	"utf8",
);
const playerSource = readFileSync(
	new URL("../../artplayer/src/player.ts", import.meta.url),
	"utf8",
);
const warmupSource = readFileSync(
	new URL("../src/audio-decoder-warmup.ts", import.meta.url),
	"utf8",
);
const floatingPanelSource = readFileSync(
	new URL("../../offline/src/ui/FloatingPanel.tsx", import.meta.url),
	"utf8",
);
const offlineTasksSource = readFileSync(
	new URL(
		"../../offline/src/ui/components/OfflineTasksTab.tsx",
		import.meta.url,
	),
	"utf8",
);

if (!manifest.sandbox?.pages?.includes("audio-host.html")) {
	throw new Error(
		"audio-host.html must be declared as a Manifest V3 sandbox page",
	);
}
if (!manifest.content_security_policy?.sandbox?.includes("worker-src blob:")) {
	throw new Error("sandbox CSP must permit the bundled AC-3 Blob worker");
}
if (
	hostHtml.includes('type="module"') ||
	!hostHtml.includes('<script src="audio-host.js"></script>') ||
	!hostBuildConfig.includes('formats: ["iife"]')
) {
	throw new Error(
		"the opaque-origin audio sandbox must load a classic bundled IIFE entry",
	);
}
if (manifest.content_security_policy?.extension_pages?.includes("blob:")) {
	throw new Error(
		"Manifest V3 extension_pages CSP must not permit blob workers",
	);
}
const accessibleResources = manifest.web_accessible_resources?.flatMap(
	(resource) => resource.resources ?? [],
);
if (
	!accessibleResources?.includes("range-host.html") ||
	!accessibleResources?.includes("range-host.js")
) {
	throw new Error("the transferable Range host must be web accessible");
}
if (!hostSource.includes("registerAc3Decoder()")) {
	throw new Error("AC-3/E-AC-3 decoder is not registered in the audio host");
}
if (
	!hostSource.includes("warmUpAc3Decoder()") ||
	!warmupSource.includes("new BufferSource(") ||
	!warmupSource.includes("sink.samples(0, 0.064)")
) {
	throw new Error(
		"the bundled E-AC-3 decoder must be warmed with a local sample",
	);
}
const hostReadyIndex = hostSource.lastIndexOf(
	'port.postMessage({ type: "host-ready" })',
);
const decoderRegistrationIndex = hostSource.lastIndexOf("registerAc3Decoder()");
const scheduledWarmupIndex = hostSource.lastIndexOf("scheduleDecoderWarmup()");
if (
	hostReadyIndex < 0 ||
	decoderRegistrationIndex < 0 ||
	scheduledWarmupIndex < 0 ||
	hostReadyIndex > decoderRegistrationIndex ||
	hostReadyIndex > scheduledWarmupIndex ||
	!hostSource.includes("if (input) return")
) {
	throw new Error(
		"the audio host must complete its handshake before background decoder warmup",
	);
}
const warmupBase64 = warmupSource.match(
	/EAC3_WARMUP_MKV_BASE64\s*=\s*\n\s*"([^"]+)"/,
)?.[1];
if (!warmupBase64) {
	throw new Error("the bundled E-AC-3 warmup sample is missing");
}
let warmupBinary;
try {
	warmupBinary = atob(warmupBase64);
} catch (error) {
	throw new Error(`the E-AC-3 warmup sample is not valid Base64: ${error}`);
}
if (
	warmupBinary.length < 4 ||
	[...warmupBinary.slice(0, 4)].map((char) => char.charCodeAt(0)).join(",") !==
		"26,69,223,163"
) {
	throw new Error("the E-AC-3 warmup sample is not a Matroska file");
}
if (!hostSource.includes('prefetchProfile: "network"')) {
	throw new Error("remote MKV audio must retain bounded Range prefetching");
}
if (
	!hostSource.includes("const PCM_CHUNK_DURATION = 0.5") ||
	!hostSource.includes("const PCM_STARTUP_STREAM_DURATION = 1") ||
	!hostSource.includes('type: "decode-chunk"') ||
	!hostSource.includes('request.type === "cancel-decode"') ||
	!hostSource.includes("!emittedFirstChunk")
) {
	throw new Error(
		"decoded AC-3/E-AC-3 PCM must be streamed before the full segment finishes",
	);
}
if (
	!bridgeSource.includes("fetchBinaryRange(") ||
	!bridgeSource.includes('"audio"') ||
	!mediaRangeSource.includes("fetchHostRange(") ||
	!mediaRangeSource.includes("getRangeHostPort()") ||
	!mediaRangeSource.includes('type: "cd2-fetch"') ||
	!rangeHostSource.includes("await response.arrayBuffer()") ||
	!rangeHostSource.includes("[data]")
) {
	throw new Error(
		"audio reads must use the transferable Range host with a proxy fallback",
	);
}
if (
	!rangeHostSource.includes("const chunks = new Map") ||
	!rangeHostSource.includes("const pendingChunks = new Map") ||
	!rangeHostSource.includes("const MAX_CONCURRENT_FETCHES = 4") ||
	!rangeHostSource.includes('priority === "audio"') ||
	!rangeHostSource.includes("pumpFetchQueue()") ||
	!rangeHostSource.includes("pending.promote(priority)") ||
	!rangeHostSource.includes("if (job.started) return") ||
	!rangeHostSource.includes("const MAX_MEMORY_SIZE = 64 * 1024 * 1024") ||
	!rangeHostSource.includes(
		"const effectiveEnd = Math.min(request.end, totalSize - 1)",
	)
) {
	throw new Error(
		"audio and subtitle ranges must share bounded chunks and clamp reads at EOF",
	);
}
if (!bridgeSource.includes('event.data.type === "decode-chunk"')) {
	throw new Error("streamed PCM chunks must be forwarded to the player");
}
if (
	!bridgeSource.includes("getHostPortWithRetry()") ||
	!bridgeSource.includes("iframeLoaded") ||
	!bridgeSource.includes("浏览器音频兼容宿主脚本未响应")
) {
	throw new Error(
		"the audio iframe handshake must recreate a stale host and report its failing stage",
	);
}
if (
	!bridgeSource.includes('type === "open" ? 90000 : 120000') ||
	!controllerSource.includes("100000")
) {
	throw new Error(
		"audio probing timeouts must leave room for a slow CloudDrive2 Range source",
	);
}
if (!bridgeSource.includes('addEventListener("cd2-audio-fallback-cancel"')) {
	throw new Error("seek cancellation must be forwarded to the audio host");
}
if (
	!bridgeSource.includes('addEventListener("cd2-audio-fallback-warmup"') ||
	!floatingPanelSource.includes('new CustomEvent("cd2-audio-fallback-warmup")')
) {
	throw new Error("expanding the task panel must start decoder warmup");
}
const emptyQueueGuard = controllerSource.indexOf("if (!this.sources.size)");
const driftCheck = controllerSource.indexOf(
	"Math.abs(expectedMedia - this.video.currentTime)",
);
if (
	emptyQueueGuard < 0 ||
	driftCheck < 0 ||
	emptyQueueGuard > driftCheck ||
	!controllerSource.includes("if (!this.pendingDecode) void this.resync()")
) {
	throw new Error(
		"an in-flight first audio decode must not be invalidated by drift checks",
	);
}
if (
	!controllerSource.includes("takeBrowserAudioFallbackPreparation(") ||
	!controllerSource.includes("consumePreparation(") ||
	!playerSource.includes("cachedPlayback.totalSize ?? fileSize") ||
	!playerSource.includes("cachedPlayback.url") ||
	!offlineTasksSource.includes('new CustomEvent("cd2-preload-video-audio"') ||
	!offlineTasksSource.includes("filePath: file.fullPathName") ||
	!bridgeSource.includes("Number.isFinite(knownFileSize)")
) {
	throw new Error(
		"audio probing must start before playlist/player initialization and reuse the known file size",
	);
}
if (
	!controllerSource.includes(
		'const chunkEvent = "cd2-audio-fallback-decode-chunk"',
	) ||
	!controllerSource.includes("private scheduleChunk(") ||
	!controllerSource.includes("private cancelPendingDecode()") ||
	!controllerSource.includes("private schedulePrime()") ||
	!controllerSource.includes("private scheduleBufferedChunks()") ||
	!controllerSource.includes('latencyHint: "interactive"')
) {
	throw new Error(
		"the player must schedule streamed and pause-time primed PCM immediately",
	);
}

console.log("Manifest V3 AC-3/E-AC-3 audio fallback check passed");
