import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libavOutputDir = path.join(root, "public", "libav");
// libav's factory and WASM bytes are embedded in libav-worker.js. Remove old
// copied assets so a rebuild cannot ship a second, unused runtime.
rmSync(libavOutputDir, { recursive: true, force: true });

const libassRoot = path.dirname(
	fileURLToPath(import.meta.resolve("libass-wasm")),
);
const libassOutputDir = path.join(root, "public", "libass");
mkdirSync(libassOutputDir, { recursive: true });

for (const file of [
	"subtitles-octopus-worker.js",
	"subtitles-octopus-worker.wasm",
]) {
	copyFileSync(path.join(libassRoot, file), path.join(libassOutputDir, file));
}
