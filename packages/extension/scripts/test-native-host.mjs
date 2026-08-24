import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optionsSource = readFileSync(
	path.join(root, "public", "options.js"),
	"utf8",
);
const expectedProtocol = Number(
	optionsSource.match(/const MIN_NATIVE_PROTOCOL = (\d+);/)?.[1],
);
if (!Number.isInteger(expectedProtocol)) {
	throw new Error(
		"Extension options do not declare a Native Host protocol version",
	);
}
const installerCommand = path.join(
	root,
	"public",
	"native-host",
	"clouddrive2-native-host.cmd",
);
if (!existsSync(installerCommand))
	throw new Error("Native Host installer was not generated");
const installer = readFileSync(installerCommand, "utf8");
if (
	!installer.includes('set "CD2_HOST_PS1=%~dp0clouddrive2-native-host.ps1"')
) {
	throw new Error(
		"Installer does not extract the Host beside the downloaded CMD",
	);
}
if (!installer.includes("; & $env:CD2_HOST_PS1 -Install;")) {
	throw new Error(
		"Installer does not register the Host in the extraction process",
	);
}
if (!installer.includes("[IO.File]::ReadAllText($env:CD2_HOST_B64)")) {
	throw new Error("Installer does not decode the chunked Base64 payload");
}
const longestInstallerLine = Math.max(
	...installer.split(/\r?\n/).map((line) => line.length),
);
if (longestInstallerLine >= 8000) {
	throw new Error(
		`Installer line exceeds the safe cmd.exe limit: ${longestInstallerLine}`,
	);
}
const embeddedPayload = installer
	.split(/\r?\n/)
	.map(
		(line) =>
			line.match(/^>{1,2} "%CD2_HOST_B64%" echo ([A-Za-z0-9+/=]+)$/)?.[1],
	)
	.filter(Boolean)
	.join("");
const sourceHost = readFileSync(path.join(root, "native-host", "host.ps1"));
if (!Buffer.from(embeddedPayload, "base64").equals(sourceHost)) {
	throw new Error("Installer's chunked payload does not match host.ps1");
}
const sourceHostText = sourceHost.toString("utf8");
if (
	!sourceHostText.includes('$lines.Add("playname=$startUrl")') ||
	!sourceHostText.includes("$dplIndex = $index + 1") ||
	sourceHostText.includes('$lines.Add("$index*file*$url")')
) {
	throw new Error(
		"PotPlayer DPL must select the requested URL and use one-based entry indexes",
	);
}

const testDirectory = mkdtempSync(path.join(tmpdir(), "cd2-native-host-"));
copyFileSync(
	path.join(root, "native-host", "host.ps1"),
	path.join(testDirectory, "clouddrive2-native-host.ps1"),
);
const command = path.join(testDirectory, "clouddrive2-native-host-run.cmd");
writeFileSync(
	command,
	'@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0clouddrive2-native-host.ps1" -NativeHost\r\nexit /b %errorlevel%\r\n',
	"ascii",
);

function encodeMessage(value) {
	const body = Buffer.from(JSON.stringify(value));
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length);
	return Buffer.concat([header, body]);
}

function runHost(request) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"cmd.exe",
			[
				"/d",
				"/c",
				command,
				"chrome-extension://pafaiigiceklmpecemghfnpimjhlgmpd/",
				"--parent-window=0",
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		const chunks = [];
		const errors = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => errors.push(chunk));
		child.on("error", reject);
		child.on("close", () => {
			const output = Buffer.concat(chunks);
			if (output.length < 4)
				return reject(
					new Error(
						Buffer.concat(errors).toString() || "Host returned no response",
					),
				);
			const length = output.readUInt32LE(0);
			resolve(JSON.parse(output.subarray(4, 4 + length).toString("utf8")));
		});
		child.stdin.end(encodeMessage(request));
	});
}

try {
	const ping = await runHost({ action: "ping", requestId: "ping-test" });
	if (
		!ping.ok ||
		ping.protocol !== expectedProtocol ||
		ping.requestId !== "ping-test"
	)
		throw new Error(`Unexpected ping: ${JSON.stringify(ping)}`);

	const rejected = await runHost({
		action: "revealPath",
		path: "relative-file.mkv",
		requestId: "path-test",
	});
	if (rejected.ok || !/absolute/i.test(rejected.error || ""))
		throw new Error(`Unexpected path response: ${JSON.stringify(rejected)}`);

	const invalidPlaylist = await runHost({
		action: "playPotPlayerPlaylist",
		title: "unsafe",
		startUrl: "file:///C:/video.mkv",
		entries: [{ url: "file:///C:/video.mkv", fileName: "video.mkv" }],
		requestId: "playlist-test",
	});
	if (invalidPlaylist.ok || !/HTTP\(S\)/i.test(invalidPlaylist.error || ""))
		throw new Error(
			`Unexpected playlist response: ${JSON.stringify(invalidPlaylist)}`,
		);

	const invalidStart = await runHost({
		action: "playPotPlayerPlaylist",
		title: "mismatched start",
		startUrl: "https://example.com/main.mkv",
		entries: [
			{
				url: "https://example.com/episode-01.mkv",
				fileName: "episode-01.mkv",
			},
		],
		requestId: "playlist-start-test",
	});
	if (invalidStart.ok || !/match an entry/i.test(invalidStart.error || ""))
		throw new Error(
			`Unexpected playlist start response: ${JSON.stringify(invalidStart)}`,
		);

	console.log("Native Host installer and CMD protocol checks passed.");
} finally {
	rmSync(testDirectory, { recursive: true, force: true });
}
