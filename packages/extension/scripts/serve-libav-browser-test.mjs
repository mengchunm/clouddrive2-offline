import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = mkdtempSync(path.join(tmpdir(), "cd2-libav-browser-"));
const subtitlePath = path.join(directory, "sample.ass");
const videoPath = path.join(directory, "sample.mkv");
writeFileSync(
	subtitlePath,
	`[Script Info]
ScriptType: v4.00+
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,浏览器WASM字幕测试
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
		"color=size=16x16:rate=1:duration=3",
		"-i",
		subtitlePath,
		"-map",
		"0:v",
		"-map",
		"1:s",
		"-c:v",
		"libx264",
		"-c:s",
		"ass",
		"-y",
		videoPath,
	],
	{ encoding: "utf8" },
);
if (ffmpeg.status !== 0) throw new Error(ffmpeg.stderr);
const video = readFileSync(videoPath);

const html = `<!doctype html><meta charset="utf-8"><title>libav browser test</title>
<body>测试中...</body><script type="module">
const iframe = document.createElement('iframe');
iframe.src = '/libav-host.html';
iframe.hidden = true;
document.body.appendChild(iframe);
iframe.onload = () => {
const channel = new MessageChannel();
const port = channel.port1;
port.onmessage = async ({ data }) => {
  if (data.type === 'host-ready') {
    port.postMessage({ type: 'extract', requestId: 'browser-test', videoUrl: '/sample.mkv', fileSize: ${video.length}, subtitleIndex: 0, startTime: 0, endTime: 3 });
  } else
  if (data.type === 'range-request') {
    const response = await fetch('/sample.mkv', { headers: { Range: 'bytes=' + data.position + '-' + (data.position + data.length - 1) } });
    const buffer = await response.arrayBuffer();
    port.postMessage({ type: 'range-response', requestId: data.requestId, position: data.position, data: buffer }, [buffer]);
  } else if (data.type === 'extract-result') {
    if (data.error) throw new Error(data.error);
    document.body.textContent = data.content.includes('浏览器WASM字幕测试') ? 'PASS' : 'FAIL';
  }
};
port.start();
iframe.contentWindow.postMessage({ type: 'cd2-libav-host-init' }, location.origin, [channel.port2]);
};
</script>`;

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/") {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(html);
		return;
	}
	if (url.pathname === "/sample.mkv") {
		const match = request.headers.range?.match(/bytes=(\d+)-(\d+)/);
		const start = match ? Number(match[1]) : 0;
		const end = Math.min(
			match ? Number(match[2]) : video.length - 1,
			video.length - 1,
		);
		response.writeHead(match ? 206 : 200, {
			"Content-Type": "video/x-matroska",
			"Content-Length": end - start + 1,
			"Content-Range": `bytes ${start}-${end}/${video.length}`,
			"Accept-Ranges": "bytes",
		});
		response.end(video.subarray(start, end + 1));
		return;
	}
	const file = path.join(root, "build", url.pathname.replace(/^\//, ""));
	try {
		const body = readFileSync(file);
		response.writeHead(200, {
			"Content-Type": file.endsWith(".wasm")
				? "application/wasm"
				: "text/javascript",
		});
		response.end(body);
	} catch {
		response.writeHead(404);
		response.end("Not found");
	}
});

server.listen(19876, "127.0.0.1", () => console.log("READY"));
function cleanup() {
	server.close();
	rmSync(directory, { recursive: true, force: true });
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
