import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "utils", "mediaPlaylist.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
const { buildPotPlayerClipboardPlaylist, selectPreferredMedia, sortMediaPlaylistByName } = await import(moduleUrl);

const entry = (fileName, fileSize) => ({
  fileName,
  filePath: `/${fileName}`,
  fileSize,
});

const withAdvertisement = sortMediaPlaylistByName([
  entry("00-ad.mp4", 30 * 1024 ** 2),
  entry("02-main.mp4", 1_000 * 1024 ** 2),
  entry("01-main.mp4", 900 * 1024 ** 2),
]);
if (withAdvertisement.map(({ fileName }) => fileName).join(",") !== "00-ad.mp4,01-main.mp4,02-main.mp4") {
  throw new Error("Playlist is not naturally name ordered");
}
if (selectPreferredMedia(withAdvertisement)?.fileName !== "01-main.mp4") {
  throw new Error("A tiny leading advertisement was not skipped for initial playback");
}

const smallVideos = sortMediaPlaylistByName([
  entry("02.mp4", 42 * 1024 ** 2),
  entry("01.mp4", 2 * 1024 ** 2),
  entry("03.mp4", 50 * 1024 ** 2),
]);
if (selectPreferredMedia(smallVideos)?.fileName !== "01.mp4") {
  throw new Error("An all-small-video playlist did not start in name order");
}
if (smallVideos.length !== 3) {
  throw new Error("Small videos must never be filtered from the playlist");
}

const clipboardPlaylist = buildPotPlayerClipboardPlaylist(
  withAdvertisement.map((item) => ({
    ...item,
    videoUrl: `https://example.com/${item.fileName}`,
  })),
  "https://example.com/01-main.mp4",
);
const clipboardLines = clipboardPlaylist.split("\r\n");
if (
  clipboardLines.length !== 3 ||
  !clipboardLines[0].includes("01-main.mp4") ||
  !clipboardLines[1].includes("00-ad.mp4") ||
  !clipboardLines[2].includes("02-main.mp4")
) {
  throw new Error("PotPlayer clipboard playlist did not prioritize the preferred item");
}

console.log("Media playlist ordering and preferred-start checks passed.");
