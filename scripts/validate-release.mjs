import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const extensionPackage = JSON.parse(
	readFileSync(path.join(root, "packages/extension/package.json"), "utf8"),
);
const manifest = JSON.parse(
	readFileSync(
		path.join(root, "packages/extension/public/manifest.json"),
		"utf8",
	),
);
const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const version = extensionPackage.version;

const failures = [];
if (manifest.version !== version)
	failures.push(
		`package version ${version} != manifest version ${manifest.version}`,
	);
if (
	!new RegExp(`^## ${version.replaceAll(".", "\\.")}\\b`, "m").test(changelog)
) {
	failures.push(`CHANGELOG.md has no ${version} section`);
}
const releaseNote = path.join(root, `docs/releases/${version}.md`);
if (!existsSync(releaseNote))
	failures.push(`missing docs/releases/${version}.md`);

const requestedTag = process.argv[2]?.trim();
if (requestedTag && requestedTag.replace(/^v/, "") !== version) {
	failures.push(`release tag ${requestedTag} != v${version}`);
}

if (failures.length > 0) {
	throw new Error(`Release validation failed:\n- ${failures.join("\n- ")}`);
}
console.log(`Release metadata is consistent for v${version}.`);
