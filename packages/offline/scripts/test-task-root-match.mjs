import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "utils", "taskRootMatch.ts"), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2021 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
const { findMatchingTaskRoot } = await import(moduleUrl);

const taskName = "[Dynamis One] Ansatsu Kyoushitsu Movie: Minna no Jikan (CR 1920x1080 AVC AAC MKV) [743F0871].mkv";
const actualRoot = {
  name: "[Dynamis One] Ansatsu Kyoushitsu Movie_ Minna no Jikan (CR 1920x1080 AVC AAC MKV) [743F0871].mkv",
};
if (findMatchingTaskRoot([actualRoot], taskName) !== actualRoot) {
  throw new Error("A punctuation-sanitized torrent root was not matched");
}
const unicodeSanitizedRoot = { name: "作品 名称 第01话.mkv" };
if (findMatchingTaskRoot([unicodeSanitizedRoot], "作品／名称【第01话】.mkv") !== unicodeSanitizedRoot) {
  throw new Error("Arbitrary Unicode punctuation changes were not matched");
}
const idRoot = { id: "cloud-file-42", name: "provider-renamed-file.mkv" };
if (findMatchingTaskRoot([idRoot], { fileId: "cloud-file-42", name: "completely different.mkv" }) !== idRoot) {
  throw new Error("Stable CloudDrive file ID was not preferred over the display name");
}
if (findMatchingTaskRoot([{ name: "Movie_ Name" }, { name: "Movie: Name" }], "Movie：Name") !== undefined) {
  throw new Error("An ambiguous normalized task root must not be accepted");
}
console.log("Task root filename compatibility checks passed.");
