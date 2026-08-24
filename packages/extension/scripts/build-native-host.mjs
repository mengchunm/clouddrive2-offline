import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "public", "native-host");
const outputFile = path.join(outputDir, "clouddrive2-native-host.cmd");
const source = readFileSync(path.join(root, "native-host", "host.ps1"));
const payload = source.toString("base64");
const payloadChunks = payload.match(/.{1,4000}/g) ?? [];

const installer = [
	"@echo off",
	"setlocal",
	'set "CD2_HOST_PS1=%~dp0clouddrive2-native-host.ps1"',
	'set "CD2_HOST_B64=%TEMP%\\clouddrive2-native-host-%RANDOM%-%RANDOM%.b64"',
	...payloadChunks.map(
		(chunk, index) =>
			`${index === 0 ? ">" : ">>"} "%CD2_HOST_B64%" echo ${chunk}`,
	),
	'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { $payload = [IO.File]::ReadAllText($env:CD2_HOST_B64); [IO.File]::WriteAllBytes($env:CD2_HOST_PS1,[Convert]::FromBase64String($payload)); & $env:CD2_HOST_PS1 -Install; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } catch { Write-Error $_; exit 1 } finally { Remove-Item -LiteralPath $env:CD2_HOST_B64 -Force -ErrorAction SilentlyContinue }"',
	"if errorlevel 1 goto failed",
	"echo.",
	"echo CloudDrive2 Offline local helper installed.",
	"echo Return to the extension settings page to continue.",
	"pause",
	"exit /b 0",
	":failed",
	"echo.",
	"echo Installation failed. Error code: %errorlevel%",
	"pause",
	"exit /b 1",
	"",
].join("\r\n");

const publicDirectory = path.join(root, "public");
if (
	path.dirname(outputDir) !== publicDirectory ||
	path.basename(outputDir) !== "native-host"
) {
	throw new Error(
		`Refusing to clean unexpected Native Host output path: ${outputDir}`,
	);
}
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
writeFileSync(outputFile, installer, "utf8");
