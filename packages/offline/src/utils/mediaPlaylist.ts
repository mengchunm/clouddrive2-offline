export interface MediaPlaylistEntry {
  fileName: string;
  filePath: string;
  fileSize: number;
}

export interface PotPlayerClipboardEntry {
  videoUrl: string;
  fileName: string;
}

const MAIN_CONTENT_RATIO = 0.2;
const LARGE_CONTENT_MIN_BYTES = 128 * 1024 * 1024;

export function sortMediaPlaylistByName<T extends MediaPlaylistEntry>(entries: T[]): T[] {
  return [...entries].sort((left, right) =>
    left.fileName.localeCompare(right.fileName, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

/**
 * Keep natural name order, but avoid starting with a tiny clip when the torrent
 * also contains clearly larger content. Nothing is filtered from the playlist.
 */
export function selectPreferredMedia<T extends MediaPlaylistEntry>(nameOrderedEntries: T[]): T | undefined {
  const first = nameOrderedEntries[0];
  if (!first) return undefined;
  const largestSize = Math.max(...nameOrderedEntries.map((entry) => Math.max(0, entry.fileSize)));
  if (largestSize < LARGE_CONTENT_MIN_BYTES || first.fileSize >= largestSize * MAIN_CONTENT_RATIO) {
    return first;
  }
  return nameOrderedEntries.find((entry) => entry.fileSize >= largestSize * MAIN_CONTENT_RATIO) ?? first;
}

/**
 * PotPlayer /clipboard starts with the first item. Put the preferred item first,
 * then retain natural name order for every remaining item. A trailing `\title`
 * is PotPlayer's native URL-title syntax.
 */
export function buildPotPlayerClipboardPlaylist<T extends PotPlayerClipboardEntry>(
  entries: T[],
  preferredUrl: string,
): string {
  const preferredIndex = entries.findIndex((entry) => entry.videoUrl === preferredUrl);
  const playbackOrder =
    preferredIndex > 0
      ? [entries[preferredIndex], ...entries.slice(0, preferredIndex), ...entries.slice(preferredIndex + 1)]
      : entries;
  return playbackOrder
    .map((entry, index) => {
      const url = new URL(entry.videoUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("PotPlayer 播放列表仅支持 HTTP(S) 地址");
      }
      const title = entry.fileName.replace(/[\r\n\\]/g, " ").trim() || `Video ${index + 1}`;
      return `${entry.videoUrl}\\${title}`;
    })
    .join("\r\n");
}
