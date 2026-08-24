export type MediaFileLike = {
  name: string;
  isDirectory?: boolean;
};

export type FileKind =
  | "folder"
  | "video"
  | "audio"
  | "image"
  | "subtitle"
  | "archive"
  | "pdf"
  | "code"
  | "link"
  | "document"
  | "file";

export const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "avi", "rmvb", "mov", "flv", "ts", "m2ts", "webm", "iso"]);
export const AUDIO_EXTENSIONS = new Set(["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "ape", "wma"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "heic"]);
const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "vtt", "sub", "sup"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "txt", "md", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub"]);
const CODE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "html",
  "htm",
  "css",
  "less",
  "scss",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "py",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "go",
  "rs",
  "sh",
  "bat",
  "cmd",
  "ps1",
  "sql",
]);
const LINK_AND_PLAYLIST_EXTENSIONS = new Set(["m3u", "m3u8", "pls", "cue", "torrent", "url"]);

export function getFileExtension(name: string): string {
  const cleanName = name.split(/[?#]/, 1)[0];
  const index = cleanName.lastIndexOf(".");
  return index > 0 ? cleanName.slice(index + 1).toLowerCase() : "";
}

export function getFileKind(file: MediaFileLike): FileKind {
  if (file.isDirectory) return "folder";
  const extension = getFileExtension(file.name);
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (SUBTITLE_EXTENSIONS.has(extension)) return "subtitle";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (extension === "pdf") return "pdf";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (LINK_AND_PLAYLIST_EXTENSIONS.has(extension)) return "link";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return "file";
}

export function isPlayableMediaFile(file: MediaFileLike): boolean {
  const kind = getFileKind(file);
  return kind === "video" || kind === "audio";
}
