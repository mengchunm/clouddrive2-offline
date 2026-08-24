function stripTransientUrlParts(url: string): string | undefined {
	try {
		const parsed = new URL(
			url,
			globalThis.location?.href ?? "http://localhost/",
		);
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return undefined;
	}
}

/** Stable key for per-video state. Cloud paths survive refreshed signed URLs. */
export function getMediaIdentity(
	url: string,
	filePath?: string,
	fileName?: string,
): string {
	if (filePath?.trim()) return `path:${filePath.trim()}`;
	const stableUrl = stripTransientUrlParts(url);
	if (stableUrl) return `url:${stableUrl}`;
	return `file:${fileName?.trim() || url.split(/[?#]/, 1)[0]}`;
}

export function isMkvMedia(fileName?: string, url?: string): boolean {
	const candidate = fileName?.trim() || url?.trim() || "";
	return /\.mkv(?:[?#].*)?$/i.test(candidate);
}
