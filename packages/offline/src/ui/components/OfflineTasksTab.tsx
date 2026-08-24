import {
  AudioOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  DownloadOutlined,
  DownOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileZipOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  FontSizeOutlined,
  LinkOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PlaySquareOutlined,
  ReloadOutlined,
  RightOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  App as AntdApp,
  Button,
  Checkbox,
  Dropdown,
  Flex,
  Input,
  Pagination,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GM_setClipboard } from "vite-plugin-monkey/dist/client";
import {
  getConfig,
  getDeleteFiles,
  getLocalDirectoryEnabled,
  getPreferredPlayer,
  getTaskListViewState,
  LOCAL_DIRECTORY_KEY,
  setDeleteFiles,
  setPreferredPlayer,
  setTaskListViewState,
} from "@/config";
import {
  deleteCloudFiles,
  findFileByPath,
  getDownloadUrlPath,
  getMountPoints,
  getOfflineQuotaInfo,
  listAllOfflineFiles,
  listSubFiles,
  removeOfflineFilesBulk,
  submitOffline,
  subscribePushMessage,
  type TrackedTaskLocation,
} from "@/grpc/client";
import { mapCloudPathToLocal } from "@/localMount";
import { OfflineFileStatus } from "@/proto/clouddrive_pb";
import { getFileExtension, getFileKind, isPlayableMediaFile, VIDEO_EXTENSIONS } from "@/utils/mediaCatalog";
import { buildPotPlayerClipboardPlaylist, selectPreferredMedia, sortMediaPlaylistByName } from "@/utils/mediaPlaylist";
import { findMatchingTaskRoot } from "@/utils/taskRootMatch";
import { createTaskSearchText, getTaskSearchKeywords, matchesTaskSearch } from "@/utils/taskSearch";
import infuseImg from "../../../../../icon/infuse.png";
import potplayerImg from "../../../../../icon/potplayer.png";
import dandanplayImg from "../../../../../icon/弹弹play.png";

const PLAYER_CONFIG = {
  web: { label: "网页播放", iconUrl: null, fallbackText: "🌐" },
  potplayer: { label: "PotPlayer", iconUrl: potplayerImg, fallbackText: "🎬" },
  dandanplay: { label: "弹弹Play", iconUrl: dandanplayImg, fallbackText: "📺" },
  infuse: { label: "Infuse", iconUrl: infuseImg, fallbackText: "🔥" },
} as const;

type PlayerType = keyof typeof PLAYER_CONFIG;

function renderPlayerIcon(playerType: PlayerType, alt = "player") {
  const player = PLAYER_CONFIG[playerType];
  if (player.iconUrl) {
    return <img src={player.iconUrl} alt={alt} style={{ width: 16, height: 16, objectFit: "contain" }} />;
  }
  if (playerType === "web") return <PlayCircleOutlined />;
  return <span>{player.fallbackText}</span>;
}

function getStoredPlayerType(): PlayerType {
  return getPreferredPlayer();
}

type Row = {
  key: string;
  name: string;
  fileId?: string;
  parentId?: string;
  sizeMB: number;
  url: string;
  status: OfflineFileStatus;
  percendDonePct: number;
  infoHash?: string;
  addTime?: number;
  searchText: string;
};

type OfflineFile = Awaited<ReturnType<typeof listAllOfflineFiles>>["offlineFiles"][number];
type OfflineFileList = Awaited<ReturnType<typeof listAllOfflineFiles>>;
type TaskFile = Awaited<ReturnType<typeof listSubFiles>>[number];
type TaskFileBrowser = {
  task: Row;
  root: TaskFile;
  currentPath: string;
};
type TaskTreeFile = TaskFile & {
  treeAncestorKeys: string[];
};
type TaskFileState = {
  browser: TaskFileBrowser | null;
  files: TaskTreeFile[];
  allFiles: TaskTreeFile[];
  rootKeys: string[];
  childrenByDirectory: Record<string, string[]>;
  expandedDirectoryKeys: string[];
  loadingDirectoryKeys: string[];
  selectedKeys: React.Key[];
  loading: boolean;
};
type TaskFileSelectionGroup = {
  taskKey: string;
  files: TaskFile[];
};
type SubtitleFile = { fileName: string; filePath: string };
type ResolvedSubtitleFile = SubtitleFile & { url: string };
type Quota = { total: number; used: number; left: number };
type SearchIndexProgress = {
  loadedPages: number;
  totalPages: number;
  loadedTasks: number;
  totalTasks: number;
};

const PAGE_SIZE = 30;
const BTIH_RE_SOURCE = "urn:btih:([a-f0-9]{40}|[a-z2-7]{32})";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEX_RE = /^[a-f0-9]{40}$/i;
const BASE32_RE = /^[a-z2-7]{32}$/i;
const PAGE_CACHE_MAX = 12;
const SEARCH_CACHE_MAX_ROWS = 5_000;
const SEARCH_CACHE_TTL = 60_000;
const PAGE_REFRESH_TTL = 5_000;
const MIN_REFRESH_FEEDBACK_MS = 400;
const SCROLLBAR_HIDE_DELAY_MS = 700;
const SCROLLBAR_FADE_DURATION_MS = 250;
const FILE_CHECK_CACHE_MAX = 300;
const FILE_CHECK_CACHE_TTL = 120_000;
const MOUNT_POINTS_CACHE_TTL = 300_000;

function isPlayableFile(file: TaskFile): boolean {
  return isPlayableMediaFile(file);
}

function renderTaskFileTypeIcon(file: TaskFile) {
  if (file.isDirectory) {
    return (
      <span className="cd2-task-file-type-icon" aria-hidden="true">
        <FolderOutlined />
      </span>
    );
  }
  const kind = getFileKind(file);
  let icon = <FileOutlined />;
  if (kind === "video") icon = <PlaySquareOutlined />;
  else if (kind === "audio") icon = <AudioOutlined />;
  else if (kind === "image") icon = <FileImageOutlined />;
  else if (kind === "subtitle") icon = <FontSizeOutlined />;
  else if (kind === "archive") icon = <FileZipOutlined />;
  else if (kind === "pdf") icon = <FilePdfOutlined />;
  else if (kind === "code") icon = <CodeOutlined />;
  else if (kind === "link") icon = <LinkOutlined />;
  else if (kind === "document") icon = <FileTextOutlined />;
  return (
    <span className="cd2-task-file-type-icon" aria-hidden="true">
      {icon}
    </span>
  );
}

function formatFileBytes(value: bigint | number): string {
  let bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let index = 0;
  while (bytes >= 1024 && index < units.length - 1) {
    bytes /= 1024;
    index++;
  }
  return `${bytes.toFixed(bytes >= 100 ? 0 : bytes >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatMegabytes(value: number): string {
  return formatFileBytes(value * 1024 * 1024);
}

function formatTaskProgress(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return Math.min(100, Math.max(0, value)).toFixed(1);
}

function getCloudParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

async function resolveTaskRoot(
  parentPath: string,
  task: Pick<Row, "name" | "fileId">,
  forceRefresh = false,
  trackedPath?: string,
): Promise<TaskFile | undefined> {
  if (trackedPath) {
    const trackedParent = getCloudParentPath(trackedPath);
    const trackedName = trackedPath.replace(/\\/g, "/").split("/").pop();
    if (trackedName) {
      const trackedEntries = await listSubFiles(trackedParent, forceRefresh);
      const tracked = trackedEntries.find((entry) => entry.id === task.fileId || entry.name === trackedName);
      if (tracked) return tracked;
    }
  }
  const entries = await listSubFiles(parentPath, forceRefresh);
  const matched = findMatchingTaskRoot(entries, task);
  if (matched) return matched;
  return await findFileByPath(parentPath, task.name);
}

function getTaskFileKey(file: TaskFile): React.Key {
  return file.fullPathName || String(file.id || file.name);
}

function sendTaskRootTracking(row: Row, fileId: string, path: string, verified: boolean): void {
  const runtime = (
    globalThis as typeof globalThis & {
      chrome?: { runtime?: { id?: string; sendMessage?: (message: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime;
  if (!runtime?.id || !runtime.sendMessage) return;
  void runtime
    .sendMessage({
      type: "cd2-track-task-root",
      taskKey: row.key,
      fileId,
      path,
      verified,
    })
    .catch(() => undefined);
}

function trackTaskRoot(row: Row, file: TaskFile): void {
  const fileId = file.id || row.fileId;
  if (!fileId || !file.fullPathName) return;
  sendTaskRootTracking(row, fileId, file.fullPathName, true);
}

function joinCloudPath(parentPath: string, name: string): string {
  const parent = parentPath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${parent || ""}/${name}`.replace(/^\/{2,}/, "/");
}

function trackExpectedTaskRoot(row: Row, parentPath: string): void {
  if (!row.fileId) return;
  sendTaskRootTracking(row, row.fileId, joinCloudPath(parentPath, row.name), false);
}

function persistTaskRootDeleted(taskKey: string): void {
  const runtime = (
    globalThis as typeof globalThis & {
      chrome?: { runtime?: { id?: string; sendMessage?: (message: unknown) => Promise<unknown> } };
    }
  ).chrome?.runtime;
  if (!runtime?.id || !runtime.sendMessage) return;
  void runtime.sendMessage({ type: "cd2-mark-task-root-deleted", taskKey }).catch(() => undefined);
}

function sortTaskFiles(files: TaskFile[]): TaskFile[] {
  return [...files].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function createTaskTreeFiles(files: TaskFile[], parent?: TaskTreeFile): TaskTreeFile[] {
  return sortTaskFiles(files).map((file) => ({
    ...file,
    treeAncestorKeys: parent ? [...parent.treeAncestorKeys, String(getTaskFileKey(parent))] : [],
  }));
}

function flattenTaskTree(
  allFiles: TaskTreeFile[],
  rootKeys: string[],
  childrenByDirectory: Record<string, string[]>,
  expandedDirectoryKeys: string[],
): TaskTreeFile[] {
  const filesByKey = new Map(allFiles.map((file) => [String(getTaskFileKey(file)), file]));
  const expanded = new Set(expandedDirectoryKeys);
  const visible: TaskTreeFile[] = [];
  const append = (keys: string[]) => {
    for (const key of keys) {
      const file = filesByKey.get(key);
      if (!file) continue;
      visible.push(file);
      if (file.isDirectory && expanded.has(key)) append(childrenByDirectory[key] ?? []);
    }
  };
  append(rootKeys);
  return visible;
}

function createTaskFileState(browser: TaskFileBrowser | null, loading: boolean): TaskFileState {
  return {
    browser,
    files: [],
    allFiles: [],
    rootKeys: [],
    childrenByDirectory: {},
    expandedDirectoryKeys: [],
    loadingDirectoryKeys: [],
    selectedKeys: [],
    loading,
  };
}

type MountPoints = Awaited<ReturnType<typeof getMountPoints>>;
let mountPointsCache: { scope: string; value: MountPoints; fetchedAt: number } | undefined;
let mountPointsRequest: { scope: string; promise: Promise<MountPoints> } | undefined;

function base32ToHex(base32: string): string | undefined {
  const clean = base32.replace(/=+$/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return undefined;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  if (bytes.length === 0) return undefined;
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalizeHash(hash: string): string {
  const h = hash.toLowerCase();
  if (HEX_RE.test(h)) return h;
  if (BASE32_RE.test(h)) return base32ToHex(h) ?? h;
  return h;
}

function collectBtihMatches(text: string): string[] {
  const re = new RegExp(BTIH_RE_SOURCE, "gi");
  return Array.from(text.matchAll(re), (m) => m[1]);
}

function extractHashFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const direct = collectBtihMatches(text);
  if (direct[0]) return direct[0];
  try {
    const decoded = decodeURIComponent(text);
    if (decoded !== text) {
      const decodedMatches = collectBtihMatches(decoded);
      if (decodedMatches[0]) return decodedMatches[0];
    }
  } catch {
    // ignore decode errors
  }
  return undefined;
}

function extractPinnedHashes(urlsStr: string): Set<string> {
  const hashes = new Set<string>();
  const addFrom = (text: string) => {
    for (const h of collectBtihMatches(text)) {
      hashes.add(canonicalizeHash(h));
    }
  };
  addFrom(urlsStr);
  try {
    const decoded = decodeURIComponent(urlsStr);
    if (decoded !== urlsStr) addFrom(decoded);
  } catch {
    // ignore decode errors
  }
  return hashes;
}

function getRowHash(row: Row): string | undefined {
  const raw = row.infoHash ?? extractHashFromText(row.url);
  if (!raw) return undefined;
  return canonicalizeHash(raw);
}

function mapOfflineFileToRow(file: OfflineFile): Row {
  const row = {
    key: file.infoHash || file.url,
    name: file.name,
    sizeMB: Number(file.size || 0) / (1024 * 1024),
    url: file.url,
    status: file.status,
    percendDonePct: file.percendDone,
    infoHash: file.infoHash,
    fileId: file.fileId || undefined,
    parentId: file.parentId || undefined,
    addTime: (() => {
      const value = Number(file.addTime || 0);
      if (!value) return undefined;
      return value > 1e12 ? value : value * 1000;
    })(),
  };
  return { ...row, searchText: createTaskSearchText(row) };
}

function mergeTaskRowsPreservingOrder(current: Row[], incoming: Row[], pinnedHashes: Set<string>): Row[] {
  if (current.length === 0) return incoming;
  const incomingByKey = new Map(incoming.map((row) => [row.key, row]));
  const currentKeys = new Set(current.map((row) => row.key));
  const newPinned: Row[] = [];
  const newUnpinned: Row[] = [];
  for (const row of incoming) {
    if (currentKeys.has(row.key)) continue;
    const hash = getRowHash(row);
    if (hash && pinnedHashes.has(hash)) newPinned.push(row);
    else newUnpinned.push(row);
  }
  const retained = current.flatMap((row) => {
    const updated = incomingByKey.get(row.key);
    return updated ? [updated] : [];
  });
  return [...newPinned, ...retained, ...newUnpinned];
}

async function loadAllOfflineRows(
  firstPage: OfflineFileList,
  onProgress?: (progress: SearchIndexProgress) => void,
): Promise<Row[]> {
  const files = [...firstPage.offlineFiles];
  const totalPages = Math.max(1, firstPage.pageCount);
  let loadedPages = 1;
  onProgress?.({
    loadedPages,
    totalPages,
    loadedTasks: files.length,
    totalTasks: firstPage.totalCount,
  });
  const concurrency = 4;
  for (let first = 2; first <= firstPage.pageCount; first += concurrency) {
    const pages = Array.from(
      { length: Math.min(concurrency, firstPage.pageCount - first + 1) },
      (_, index) => first + index,
    );
    const results = await Promise.all(pages.map((pageNumber) => listAllOfflineFiles(pageNumber)));
    for (const result of results) files.push(...result.offlineFiles);
    loadedPages += results.length;
    onProgress?.({
      loadedPages,
      totalPages,
      loadedTasks: files.length,
      totalTasks: firstPage.totalCount,
    });
  }
  return files.map(mapOfflineFileToRow);
}

type CachedPage = {
  rows: Row[];
  totalCount: number;
  pageCount: number;
  fetchedAt: number;
};

type SearchResultCache = {
  keywordKey: string;
  rows: Row[];
  totalCount: number;
  fetchedAt: number;
};

type TaskListCache = {
  scope: string;
  pages: Map<number, CachedPage>;
  quota?: Quota;
  allRows?: Row[];
  allRowsTotalCount?: number;
  allRowsFetchedAt: number;
  lastSearch?: SearchResultCache;
  fileChecks: Map<string, { taskName: string; fileId?: string; missing: boolean; checkedAt: number }>;
};

let taskListCache: TaskListCache | undefined;
let searchIndexRequest:
  | {
      scope: string;
      promise: Promise<{ rows: Row[]; totalCount: number }>;
      listeners: Set<(progress: SearchIndexProgress) => void>;
      progress?: SearchIndexProgress;
    }
  | undefined;
let firstPageRequest: { scope: string; promise: Promise<OfflineFileList> } | undefined;

function getTaskCacheScope(): string {
  const config = getConfig();
  return `${config.grpcBaseUrl}\n${config.offlineDestPath}\n${config.apiToken}`;
}

function getCachedMountPoints(forceRefresh = false): Promise<MountPoints> {
  const scope = getTaskCacheScope();
  if (
    !forceRefresh &&
    mountPointsCache?.scope === scope &&
    Date.now() - mountPointsCache.fetchedAt < MOUNT_POINTS_CACHE_TTL
  ) {
    return Promise.resolve(mountPointsCache.value);
  }
  if (mountPointsRequest?.scope === scope) return mountPointsRequest.promise;
  const promise = getMountPoints().then((value) => {
    mountPointsCache = { scope, value, fetchedAt: Date.now() };
    return value;
  });
  mountPointsRequest = { scope, promise };
  const clearRequest = () => {
    if (mountPointsRequest?.promise === promise) mountPointsRequest = undefined;
  };
  void promise.then(clearRequest, clearRequest);
  return promise;
}

function getTaskListCache(): TaskListCache {
  const scope = getTaskCacheScope();
  if (!taskListCache || taskListCache.scope !== scope) {
    taskListCache = {
      scope,
      pages: new Map(),
      allRowsFetchedAt: 0,
      fileChecks: new Map(),
    };
    searchIndexRequest = undefined;
    firstPageRequest = undefined;
  }
  return taskListCache;
}

function invalidateTaskSearchCache(): void {
  const cache = getTaskListCache();
  cache.allRowsFetchedAt = 0;
  if (cache.lastSearch) cache.lastSearch.fetchedAt = 0;
}

function getFirstTaskPage(cache: TaskListCache): Promise<OfflineFileList> {
  if (firstPageRequest?.scope === cache.scope) return firstPageRequest.promise;
  const promise = listAllOfflineFiles(1);
  firstPageRequest = { scope: cache.scope, promise };
  const clearRequest = () => {
    if (firstPageRequest?.promise === promise) firstPageRequest = undefined;
  };
  void promise.then(clearRequest, clearRequest);
  return promise;
}

export async function prefetchOfflineTaskPage(): Promise<void> {
  const cache = getTaskListCache();
  const cached = cache.pages.get(1);
  if (cached && Date.now() - cached.fetchedAt < PAGE_REFRESH_TTL) return;
  try {
    const result = await getFirstTaskPage(cache);
    cacheTaskPage(cache, 1, result, result.offlineFiles.map(mapOfflineFileToRow));
  } catch {
    // Prefetch is opportunistic; the visible panel will report real errors.
  }
}

function cacheTaskPage(cache: TaskListCache, page: number, result: OfflineFileList, rows: Row[]): void {
  cache.pages.delete(page);
  cache.pages.set(page, {
    rows,
    totalCount: result.totalCount,
    pageCount: result.pageCount,
    fetchedAt: Date.now(),
  });
  while (cache.pages.size > PAGE_CACHE_MAX) {
    const oldestPage = cache.pages.keys().next().value;
    if (oldestPage === undefined) break;
    cache.pages.delete(oldestPage);
  }

  if (cache.allRows) {
    const updates = new Map(rows.map((row) => [row.key, row]));
    cache.allRows = cache.allRows.map((row) => updates.get(row.key) ?? row);
    if (cache.allRowsTotalCount !== result.totalCount) cache.allRowsFetchedAt = 0;
  }
  if (cache.lastSearch) {
    const updates = new Map(rows.map((row) => [row.key, row]));
    cache.lastSearch.rows = cache.lastSearch.rows.map((row) => updates.get(row.key) ?? row);
    if (cache.lastSearch.totalCount !== result.totalCount) cache.lastSearch.fetchedAt = 0;
  }
}

function getSearchIndex(
  cache: TaskListCache,
  onProgress?: (progress: SearchIndexProgress) => void,
): Promise<{ rows: Row[]; totalCount: number }> {
  if (searchIndexRequest?.scope === cache.scope) {
    if (onProgress) {
      searchIndexRequest.listeners.add(onProgress);
      if (searchIndexRequest.progress) onProgress(searchIndexRequest.progress);
    }
    return searchIndexRequest.promise;
  }

  const listeners = new Set<(progress: SearchIndexProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const reportProgress = (progress: SearchIndexProgress) => {
    if (searchIndexRequest?.scope === cache.scope) searchIndexRequest.progress = progress;
    for (const listener of listeners) listener(progress);
  };

  const promise = (async () => {
    const firstPage = await getFirstTaskPage(cache);
    const rows = await loadAllOfflineRows(firstPage, reportProgress);
    cacheTaskPage(cache, 1, firstPage, rows.slice(0, firstPage.pageRowCount || PAGE_SIZE));
    if (rows.length <= SEARCH_CACHE_MAX_ROWS) {
      cache.allRows = rows;
      cache.allRowsTotalCount = firstPage.totalCount;
      cache.allRowsFetchedAt = Date.now();
    } else {
      cache.allRows = undefined;
      cache.allRowsTotalCount = undefined;
      cache.allRowsFetchedAt = 0;
    }
    return { rows, totalCount: firstPage.totalCount };
  })();

  searchIndexRequest = { scope: cache.scope, promise, listeners };
  const clearRequest = () => {
    if (searchIndexRequest?.promise === promise) searchIndexRequest = undefined;
  };
  void promise.then(clearRequest, clearRequest);
  return promise;
}

async function findPinnedRows(pinnedHashes: Set<string>, totalPages: number, currentPage: number): Promise<Row[]> {
  if (pinnedHashes.size === 0) return [];
  if (!totalPages || totalPages <= 1) return [];

  const found: Row[] = [];
  const foundHashes = new Set<string>();

  for (let p = 1; p <= totalPages; p++) {
    if (p === currentPage) continue;
    const listRes = await listAllOfflineFiles(p);
    for (const f of listRes.offlineFiles) {
      const rawHash = f.infoHash ?? extractHashFromText(f.url);
      if (!rawHash) continue;
      const hash = canonicalizeHash(rawHash);
      if (!pinnedHashes.has(hash) || foundHashes.has(hash)) continue;
      foundHashes.add(hash);
      found.push(mapOfflineFileToRow(f));
      if (foundHashes.size >= pinnedHashes.size) break;
    }
    if (foundHashes.size >= pinnedHashes.size) break;
  }

  return found;
}

export function OfflineTasksTab() {
  const { message, modal } = AntdApp.useApp();
  const [initialViewState] = useState(() => getTaskListViewState());
  const initialCache = getTaskListCache();
  const initialPage = initialCache.pages.get(initialViewState.page);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(initialViewState.page);
  const [rows, setRows] = useState<Row[]>(() => initialPage?.rows ?? []);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [total, setTotal] = useState<number>(() => initialPage?.totalCount ?? 0);
  const [searchText, setSearchText] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexing, setSearchIndexing] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchIndexProgress | null>(null);
  const [quota, setQuota] = useState<Quota | null>(() => initialCache.quota ?? null);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [shouldDeleteFiles, setShouldDeleteFiles] = useState(() => getDeleteFiles());
  const [localDirectoryEnabled, setLocalDirectoryEnabled] = useState(() => getLocalDirectoryEnabled());
  const [missingTasks, setMissingTasks] = useState<Set<string>>(new Set());
  const [taskLocations, setTaskLocations] = useState<Record<string, TrackedTaskLocation>>({});
  const taskLocationsRef = useRef(taskLocations);
  taskLocationsRef.current = taskLocations;
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<string[]>([]);
  const [taskFileStates, setTaskFileStates] = useState<Record<string, TaskFileState>>({});
  const [defaultPlayer, setDefaultPlayer] = useState<PlayerType>(getStoredPlayerType);
  const selectedRef = useRef<React.Key[]>(selected);
  selectedRef.current = selected;
  const taskFileStatesRef = useRef(taskFileStates);
  taskFileStatesRef.current = taskFileStates;
  const reqIdRef = useRef(0);
  const manualRefreshInFlightRef = useRef(false);
  const taskFilesRequestRef = useRef(new Map<string, number>());
  const fileCheckRequestIdRef = useRef(0);
  const fileCheckRequestRef = useRef(new Map<string, { taskName: string; fileId?: string; requestId: number }>());
  const taskTableRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(initialViewState.page);
  const scrollTopRef = useRef(initialViewState.scrollTop);
  const scrollRestorePendingRef = useRef(initialViewState.scrollTop > 0);
  const scrollSaveTimerRef = useRef<number | null>(null);
  /** 最近提交的 btih hash 集合，用于置顶匹配 */
  const pinnedHashesRef = useRef<Set<string>>(new Set());
  const searchKeywords = useMemo(() => getTaskSearchKeywords(searchQuery), [searchQuery]);
  const searchActive = searchKeywords.length > 0;
  const selectedPartialTaskFileGroups = useMemo(() => {
    const groups: TaskFileSelectionGroup[] = [];
    for (const [taskKey, state] of Object.entries(taskFileStates)) {
      const selectedKeys = new Set(state.selectedKeys);
      const files = state.allFiles.filter((file) => selectedKeys.has(getTaskFileKey(file)));
      if (files.length > 0 && files.length < state.allFiles.length) groups.push({ taskKey, files });
    }
    return groups;
  }, [taskFileStates]);
  const selectedPartialTaskFiles = selectedPartialTaskFileGroups.flatMap((group) => group.files);
  const partialTaskKeys = useMemo(
    () => new Set(selectedPartialTaskFileGroups.map((group) => group.taskKey)),
    [selectedPartialTaskFileGroups],
  );

  const persistTaskListView = useCallback(() => {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    setTaskListViewState({
      page: pageRef.current,
      scrollTop: scrollTopRef.current,
    });
  }, []);

  const changePage = useCallback(
    (nextPage: number) => {
      const normalizedPage = Math.max(1, Math.floor(nextPage));
      pageRef.current = normalizedPage;
      scrollTopRef.current = 0;
      scrollRestorePendingRef.current = true;
      persistTaskListView();
      selectedRef.current = [];
      setSelected([]);
      setExpandedTaskKeys([]);
      taskFilesRequestRef.current = new Map();
      taskFileStatesRef.current = {};
      setTaskFileStates({});
      setPage(normalizedPage);
    },
    [persistTaskListView],
  );

  // The keyed table is recreated when the player changes, so rebind the scroll listener.
  // biome-ignore lint/correctness/useExhaustiveDependencies: defaultPlayer tracks the keyed table DOM replacement.
  useEffect(() => {
    const tableBody = taskTableRef.current?.querySelector<HTMLElement>(".ant-table-body");
    if (!tableBody) return;

    let scrollbarHideTimer: number | undefined;
    let scrollbarFadeTimer: number | undefined;
    const showScrollbarWhileScrolling = () => {
      tableBody.classList.remove("cd2-is-fading");
      tableBody.classList.add("cd2-is-scrolling");
      if (scrollbarHideTimer !== undefined) window.clearTimeout(scrollbarHideTimer);
      if (scrollbarFadeTimer !== undefined) window.clearTimeout(scrollbarFadeTimer);
      scrollbarHideTimer = window.setTimeout(() => {
        tableBody.classList.remove("cd2-is-scrolling");
        tableBody.classList.add("cd2-is-fading");
        scrollbarHideTimer = undefined;
        scrollbarFadeTimer = window.setTimeout(() => {
          tableBody.classList.remove("cd2-is-fading");
          scrollbarFadeTimer = undefined;
        }, SCROLLBAR_FADE_DURATION_MS);
      }, SCROLLBAR_HIDE_DELAY_MS);
    };
    const onScroll = () => {
      showScrollbarWhileScrolling();
      if (scrollRestorePendingRef.current) return;
      scrollTopRef.current = tableBody.scrollTop;
      if (scrollSaveTimerRef.current !== null) return;
      scrollSaveTimerRef.current = window.setTimeout(persistTaskListView, 150);
    };
    const onPageHide = () => persistTaskListView();
    tableBody.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onPageHide);
    return () => {
      tableBody.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onPageHide);
      if (scrollbarHideTimer !== undefined) window.clearTimeout(scrollbarHideTimer);
      if (scrollbarFadeTimer !== undefined) window.clearTimeout(scrollbarFadeTimer);
      tableBody.classList.remove("cd2-is-scrolling", "cd2-is-fading");
      persistTaskListView();
    };
  }, [defaultPlayer, persistTaskListView]);

  useEffect(() => {
    if (loading || rows.length === 0 || !scrollRestorePendingRef.current) return;
    const pageToRestore = page;
    const frame = window.requestAnimationFrame(() => {
      if (pageRef.current !== pageToRestore) return;
      const tableBody = taskTableRef.current?.querySelector<HTMLElement>(".ant-table-body");
      if (!tableBody) return;
      tableBody.scrollTop = scrollTopRef.current;
      scrollRestorePendingRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading, page, rows]);

  useEffect(() => {
    const extensionChrome = (
      globalThis as typeof globalThis & {
        chrome?: {
          storage?: {
            local?: {
              set: (items: Record<string, unknown>) => Promise<void>;
            };
            onChanged?: {
              addListener: (listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void;
              removeListener: (
                listener: (changes: Record<string, { newValue?: unknown }>, area: string) => void,
              ) => void;
            };
          };
        };
      }
    ).chrome;

    let nativeDetectionInFlight = false;
    let lastNativeDetectionAt = 0;
    const detectNativeHost = async () => {
      const now = Date.now();
      if (nativeDetectionInFlight || now - lastNativeDetectionAt < 10_000) {
        return;
      }
      nativeDetectionInFlight = true;
      lastNativeDetectionAt = now;
      try {
        const runtime = (
          extensionChrome as typeof extensionChrome & {
            runtime?: {
              id?: string;
              sendMessage?: (message: unknown) => Promise<{
                ok?: boolean;
                kind?: string;
                protocol?: number;
                error?: string;
              }>;
            };
          }
        )?.runtime;
        if (!runtime?.id || !runtime.sendMessage) return;
        const result = await runtime.sendMessage({ type: "cd2-native-status" });
        const ready = result?.ok === true && result.kind === "powershell" && (result.protocol ?? 0) >= 8;
        if (ready) {
          setLocalDirectoryEnabled(true);
          void extensionChrome?.storage?.local?.set({
            [LOCAL_DIRECTORY_KEY]: true,
          });
          console.info(`[cd2] 本地文件定位助手已连接（协议 ${result.protocol}）`);
          return;
        }
        const errorText = result?.error || "";
        const definitelyUnavailable =
          result?.ok === true ||
          /not found|not registered|forbidden|specified native messaging host|找不到/i.test(errorText);
        if (definitelyUnavailable) {
          setLocalDirectoryEnabled(false);
          void extensionChrome?.storage?.local?.set({
            [LOCAL_DIRECTORY_KEY]: false,
          });
        }
        console.warn(`[cd2] 本地文件定位助手检测失败${errorText ? `：${errorText}` : ""}`);
      } catch (error) {
        const errorText = (error as Error).message || String(error);
        if (!/extension context invalidated|message channel closed|asynchronous response/i.test(errorText)) {
          console.warn(`[cd2] 本地文件定位助手检测异常：${errorText}`);
        }
      } finally {
        nativeDetectionInFlight = false;
      }
    };

    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && LOCAL_DIRECTORY_KEY in changes) {
        setLocalDirectoryEnabled(changes[LOCAL_DIRECTORY_KEY].newValue === true);
      }
    };
    let storageChanged:
      | {
          addListener: (listener: typeof onChanged) => void;
          removeListener: (listener: typeof onChanged) => void;
        }
      | undefined;
    try {
      storageChanged = extensionChrome?.storage?.onChanged;
      storageChanged?.addListener(onChanged);
    } catch {
      storageChanged = undefined;
    }
    const onFocus = () => void detectNativeHost();
    window.addEventListener("focus", onFocus);
    void detectNativeHost();
    return () => {
      window.removeEventListener("focus", onFocus);
      try {
        storageChanged?.removeListener(onChanged);
      } catch {
        // The previous extension context was reloaded.
      }
    };
  }, []);

  useEffect(() => {
    if (localDirectoryEnabled) void getCachedMountPoints().catch(() => undefined);
  }, [localDirectoryEnabled]);

  const checkMissingTasksInBackground = useCallback(async (candidateRows: Row[]) => {
    const finishedRows = candidateRows.filter((row) => row.status === OfflineFileStatus.OFFLINE_FINISHED);
    if (finishedRows.length === 0) return;

    const cache = getTaskListCache();
    const now = Date.now();
    const missing = new Set<string>();
    const present = new Set<string>();
    const rowsToCheck: Row[] = [];
    const requestIds = new Map<string, number>();
    for (const row of finishedRows) {
      const cached = cache.fileChecks.get(row.key);
      if (
        cached?.taskName === row.name &&
        cached.fileId === row.fileId &&
        now - cached.checkedAt < FILE_CHECK_CACHE_TTL
      ) {
        cache.fileChecks.delete(row.key);
        cache.fileChecks.set(row.key, cached);
        if (cached.missing) missing.add(row.key);
        else present.add(row.key);
      } else {
        // 磁力元数据解析完成后任务名可能改变。旧名称对应的缺失结果
        // 不能沿用到同一个 infoHash，否则真实目录已存在仍会显示缺失。
        if (cached) cache.fileChecks.delete(row.key);
        present.add(row.key);
        const requestId = ++fileCheckRequestIdRef.current;
        fileCheckRequestRef.current.set(row.key, {
          taskName: row.name,
          fileId: row.fileId,
          requestId,
        });
        requestIds.set(row.key, requestId);
        rowsToCheck.push(row);
      }
    }

    if (missing.size > 0 || present.size > 0) {
      setMissingTasks((previous) => {
        const next = new Set(previous);
        for (const key of missing) next.add(key);
        for (const key of present) next.delete(key);
        return next;
      });
    }
    missing.clear();
    present.clear();
    if (rowsToCheck.length === 0) return;

    const parentPath = getConfig().offlineDestPath || "/";
    for (const row of rowsToCheck) trackExpectedTaskRoot(row, parentPath);
    try {
      // A directory listing is authoritative here. FindFileByPath may miss a
      // torrent root when its name contains punctuation such as a colon.
      const destinationEntries = await listSubFiles(parentPath, true, true);
      await Promise.all(
        rowsToCheck.map(async (row) => {
          const requestId = requestIds.get(row.key);
          const isCurrentRequest = () => {
            const current = fileCheckRequestRef.current.get(row.key);
            return current?.taskName === row.name && current.fileId === row.fileId && current.requestId === requestId;
          };
          try {
            const trackedLocation = taskLocationsRef.current[row.key];
            const file =
              trackedLocation?.status === "moved"
                ? undefined
                : (findMatchingTaskRoot(destinationEntries, row) ?? (await findFileByPath(parentPath, row.name)));
            if (!isCurrentRequest()) return;
            const isMissing = trackedLocation?.status === "deleted" || (!file && trackedLocation?.status !== "moved");
            if (file) trackTaskRoot(row, file);
            else if (isMissing) persistTaskRootDeleted(row.key);
            cache.fileChecks.delete(row.key);
            cache.fileChecks.set(row.key, {
              taskName: row.name,
              fileId: row.fileId,
              missing: isMissing,
              checkedAt: Date.now(),
            });
            if (isMissing) missing.add(row.key);
            else present.add(row.key);
          } catch (error) {
            if (!isCurrentRequest()) return;
            // A transient API failure is not evidence of deletion.
            present.add(row.key);
            cache.fileChecks.delete(row.key);
            console.warn(`[cd2] task root check failed for ${row.name}`, error);
          }
        }),
      );
    } catch (error) {
      // Avoid turning an unavailable destination listing into false warnings.
      for (const row of rowsToCheck) {
        cache.fileChecks.delete(row.key);
        present.add(row.key);
      }
      console.warn("[cd2] destination directory check failed", error);
    }
    while (cache.fileChecks.size > FILE_CHECK_CACHE_MAX) {
      const oldestKey = cache.fileChecks.keys().next().value;
      if (oldestKey === undefined) break;
      cache.fileChecks.delete(oldestKey);
    }

    setMissingTasks((previous) => {
      const next = new Set(previous);
      for (const key of missing) {
        const checked = cache.fileChecks.get(key);
        const request = fileCheckRequestRef.current.get(key);
        if (checked?.missing && request?.taskName === checked.taskName && request.fileId === checked.fileId)
          next.add(key);
      }
      for (const key of present) next.delete(key);
      return next;
    });
  }, []);

  // 核心拉取逻辑：缓存立即显示，网络刷新和文件存在性检查在后台完成。
  const doFetchAll = useCallback(
    async (showLoading: boolean, forceNetwork = false, refreshQuota = true) => {
      const thisReqId = ++reqIdRef.current;
      const cache = getTaskListCache();
      const keywordKey = searchKeywords.join("\u0000");
      const visibleRows = (source: Row[]) => source.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      const updateSearchProgress = (progress: SearchIndexProgress) => {
        if (thisReqId === reqIdRef.current) setSearchProgress(progress);
      };

      const commitRows = (nextRows: Row[]) => {
        const displayRows = forceNetwork
          ? mergeTaskRowsPreservingOrder(rowsRef.current, nextRows, pinnedHashesRef.current)
          : nextRows;
        rowsRef.current = displayRows;
        setRows(displayRows);
        return displayRows;
      };

      const applySearchRows = (source: Row[], sourceTotal: number, cacheResult: boolean) => {
        const filtered = source.filter((row) => matchesTaskSearch(row, searchKeywords));
        const displayRows = commitRows(filtered);
        setTotal(displayRows.length);
        if (cacheResult && displayRows.length <= SEARCH_CACHE_MAX_ROWS) {
          cache.lastSearch = {
            keywordKey,
            rows: displayRows,
            totalCount: sourceTotal,
            fetchedAt: Date.now(),
          };
        }
        void checkMissingTasksInBackground(visibleRows(displayRows));
      };

      if (searchActive) {
        const now = Date.now();
        const freshAllRows =
          cache.allRows && cache.allRowsTotalCount !== undefined && now - cache.allRowsFetchedAt < SEARCH_CACHE_TTL;
        const lastSearch = cache.lastSearch?.keywordKey === keywordKey ? cache.lastSearch : undefined;

        const refreshFirstPageIfNeeded = async () => {
          const cachedFirstPage = cache.pages.get(1);
          if (!forceNetwork && cachedFirstPage && Date.now() - cachedFirstPage.fetchedAt < PAGE_REFRESH_TTL)
            return false;
          const firstPage = await getFirstTaskPage(cache);
          const firstPageRows = firstPage.offlineFiles.map(mapOfflineFileToRow);
          cacheTaskPage(cache, 1, firstPage, firstPageRows);
          return true;
        };

        if (freshAllRows) {
          applySearchRows(cache.allRows ?? [], cache.allRowsTotalCount ?? 0, true);
          setLoading(false);
          setSearchIndexing(false);
          setSearchProgress(null);
          try {
            if (await refreshFirstPageIfNeeded()) {
              if (cache.allRowsFetchedAt === 0) {
                setSearchIndexing(true);
                const index = await getSearchIndex(cache, updateSearchProgress);
                if (thisReqId === reqIdRef.current) applySearchRows(index.rows, index.totalCount, true);
              } else if (thisReqId === reqIdRef.current && cache.allRows) {
                applySearchRows(cache.allRows, cache.allRowsTotalCount ?? cache.allRows.length, true);
              }
            }
          } catch {
            // Cached search results remain usable when a status refresh fails.
          } finally {
            if (thisReqId === reqIdRef.current) setSearchIndexing(false);
          }
          return;
        }
        if (lastSearch && now - lastSearch.fetchedAt < SEARCH_CACHE_TTL) {
          commitRows(lastSearch.rows);
          setTotal(lastSearch.rows.length);
          setLoading(false);
          setSearchIndexing(false);
          setSearchProgress(null);
          void checkMissingTasksInBackground(visibleRows(lastSearch.rows));
          try {
            if (await refreshFirstPageIfNeeded()) {
              if (cache.lastSearch?.fetchedAt === 0) {
                setSearchIndexing(true);
                const index = await getSearchIndex(cache, updateSearchProgress);
                if (thisReqId === reqIdRef.current) applySearchRows(index.rows, index.totalCount, true);
              } else {
                const refreshed = cache.lastSearch?.keywordKey === keywordKey ? cache.lastSearch.rows : lastSearch.rows;
                if (thisReqId === reqIdRef.current) {
                  commitRows(refreshed);
                  setTotal(refreshed.length);
                }
              }
            }
          } catch {
            // Cached search results remain usable when a status refresh fails.
          } finally {
            if (thisReqId === reqIdRef.current) setSearchIndexing(false);
          }
          return;
        }

        if (cache.allRows) applySearchRows(cache.allRows, cache.allRowsTotalCount ?? cache.allRows.length, false);
        else if (lastSearch) {
          commitRows(lastSearch.rows);
          setTotal(lastSearch.rows.length);
        } else {
          const cachedRows = Array.from(cache.pages.values()).flatMap((entry) => entry.rows);
          const uniqueRows = Array.from(new Map(cachedRows.map((row) => [row.key, row])).values());
          applySearchRows(uniqueRows, uniqueRows.length, false);
        }

        setSearchIndexing(true);
        setSearchProgress({
          loadedPages: 0,
          totalPages: 0,
          loadedTasks: 0,
          totalTasks: cache.pages.get(1)?.totalCount ?? 0,
        });
        if (showLoading && !cache.allRows && !lastSearch && cache.pages.size === 0) setLoading(true);
        try {
          const index = await getSearchIndex(cache, updateSearchProgress);
          if (thisReqId !== reqIdRef.current) return;
          applySearchRows(index.rows, index.totalCount, true);
        } catch (error) {
          if (thisReqId === reqIdRef.current && showLoading) {
            message.error((error as Error)?.message || "搜索索引加载失败");
          }
        } finally {
          if (thisReqId === reqIdRef.current) {
            setLoading(false);
            setSearchIndexing(false);
          }
        }
        return;
      }

      setSearchIndexing(false);
      setSearchProgress(null);
      const cachedPage = cache.pages.get(page);
      if (cachedPage) {
        cache.pages.delete(page);
        cache.pages.set(page, cachedPage);
        if (!forceNetwork) commitRows(cachedPage.rows);
        setTotal(cachedPage.totalCount);
        if (cache.quota) setQuota(cache.quota);
        setLoading(false);
      } else if (showLoading) setLoading(true);

      const quotaRequest = refreshQuota
        ? getOfflineQuotaInfo()
            .then((result) => {
              cache.quota = result;
              if (thisReqId === reqIdRef.current) setQuota(result);
            })
            .catch(() => undefined)
        : Promise.resolve();

      try {
        const listRes = page === 1 ? await getFirstTaskPage(cache) : await listAllOfflineFiles(page);
        const lastPage = Math.max(1, listRes.pageCount);
        if (page > lastPage) {
          if (thisReqId === reqIdRef.current) changePage(lastPage);
          return;
        }
        const mapped = listRes.offlineFiles.map(mapOfflineFileToRow);
        if (thisReqId !== reqIdRef.current) return;
        let finalRows = mapped;

        // 置顶排序：匹配 pinnedHashes 的行排在最前面（必要时跨页补齐）。
        const pinned = pinnedHashesRef.current;
        if (pinned.size > 0) {
          const top: Row[] = [];
          const rest: Row[] = [];
          const matchedHashes = new Set<string>();
          for (const row of mapped) {
            const hash = getRowHash(row);
            if (hash && pinned.has(hash)) {
              matchedHashes.add(hash);
              top.push(row);
            } else rest.push(row);
          }

          const missingHashes = new Set(Array.from(pinned).filter((hash) => !matchedHashes.has(hash)));
          const extraPinned = await findPinnedRows(missingHashes, listRes.pageCount, page);
          if (thisReqId !== reqIdRef.current) return;
          const seen = new Set<string>();
          finalRows = [...top, ...extraPinned, ...rest]
            .filter((row) => {
              const hash = getRowHash(row);
              if (!hash || !seen.has(hash)) {
                if (hash) seen.add(hash);
                return true;
              }
              return false;
            })
            .slice(0, PAGE_SIZE);
        }

        const displayRows = commitRows(finalRows);
        cacheTaskPage(cache, page, listRes, forceNetwork ? displayRows : mapped);
        setTotal(listRes.totalCount);
        setLoading(false);
        void checkMissingTasksInBackground(displayRows);
      } catch (error) {
        if (!cachedPage && showLoading) message.error((error as Error)?.message || "加载失败");
      } finally {
        if (thisReqId === reqIdRef.current) setLoading(false);
        void quotaRequest;
      }
    },
    [changePage, checkMissingTasksInBackground, message, page, searchActive, searchKeywords],
  );

  /** 手动刷新（带 loading 动画，清除置顶） */
  const fetchAll = useCallback(() => {
    pinnedHashesRef.current = new Set();
    getTaskListCache().fileChecks.clear();
    return doFetchAll(true);
  }, [doFetchAll]);

  const refreshManually = useCallback(async () => {
    if (manualRefreshInFlightRef.current) return;
    manualRefreshInFlightRef.current = true;
    const startedAt = Date.now();
    setRefreshing(true);
    try {
      await fetchAll();
    } finally {
      const remainingFeedbackTime = MIN_REFRESH_FEEDBACK_MS - (Date.now() - startedAt);
      if (remainingFeedbackTime > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, remainingFeedbackTime));
      }
      manualRefreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, [fetchAll]);

  /** 静默刷新（无 loading 动画，并强制读取服务端最新任务状态） */
  const fetchAllSilent = useCallback(() => doFetchAll(false, true, false), [doFetchAll]);

  // 初始加载
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // 监听事件驱动刷新：任务提交 / 任务删除 → 静默刷新
  useEffect(() => {
    const onSubmitted = (e: Event) => {
      invalidateTaskSearchCache();
      const urlsStr = (e as CustomEvent)?.detail?.urls as string | undefined;
      if (urlsStr) {
        const hashes = extractPinnedHashes(urlsStr);
        if (hashes.size > 0) pinnedHashesRef.current = hashes;
      }
      fetchAllSilent();
    };
    const onDeleted = () => {
      invalidateTaskSearchCache();
      fetchAllSilent();
    };
    window.addEventListener("cd2-task-submitted", onSubmitted);
    window.addEventListener("cd2-task-deleted", onDeleted);
    return () => {
      window.removeEventListener("cd2-task-submitted", onSubmitted);
      window.removeEventListener("cd2-task-deleted", onDeleted);
    };
  }, [fetchAllSilent]);

  // 监听 artplayer 的 URL 解析请求（用于分集切换）

  const hasActiveTask = useMemo(
    () =>
      rows.some(
        (row) => row.status === OfflineFileStatus.OFFLINE_INIT || row.status === OfflineFileStatus.OFFLINE_DOWNLOADING,
      ),
    [rows],
  );

  // CloudDrive2 的 PushMessage 只有下载任务数量，没有离线下载百分比。
  // 因此只在可见列表确实存在活跃任务时探测状态；完成或页面隐藏后立即停止。
  useEffect(() => {
    if (!hasActiveTask) return;
    let stopped = false;
    let timer: number | undefined;
    let inFlight = false;

    const probe = async () => {
      timer = undefined;
      if (stopped || document.hidden || inFlight) return;
      inFlight = true;
      try {
        await fetchAllSilent();
      } finally {
        inFlight = false;
        if (!stopped && !document.hidden) timer = window.setTimeout(probe, 1_000);
      }
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      } else if (!stopped && timer === undefined && !inFlight) {
        void probe();
      }
    };

    timer = window.setTimeout(probe, 1_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasActiveTask, fetchAllSilent]);

  // CloudDrive2 PushMessage 事件驱动：下载状态或文件系统变化时刷新。
  // 将短时间内的密集推送合并，避免同一进度变化触发并发请求。
  useEffect(() => {
    const ac = new AbortController();
    let refreshTimer: number | undefined;
    let refreshInFlight = false;
    let refreshQueued = false;
    const runRefresh = async () => {
      refreshTimer = undefined;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try {
        await fetchAllSilent();
      } finally {
        refreshInFlight = false;
        if (refreshQueued && !ac.signal.aborted) {
          refreshQueued = false;
          refreshTimer = window.setTimeout(runRefresh, 120);
        }
      }
    };
    const scheduleRefresh = () => {
      getTaskListCache().fileChecks.clear();
      if (refreshTimer !== undefined) return;
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshTimer = window.setTimeout(runRefresh, 120);
    };
    subscribePushMessage(scheduleRefresh, ac.signal, (locations) => {
      setTaskLocations((previous) => ({ ...previous, ...locations }));
      const foundKeys = Object.values(locations)
        .filter((location) => location.status !== "deleted")
        .map((location) => location.taskKey);
      if (foundKeys.length > 0) {
        setMissingTasks((previous) => {
          const next = new Set(previous);
          for (const key of foundKeys) next.delete(key);
          return next;
        });
      }
    });
    return () => {
      ac.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [fetchAllSilent]);

  // 同步记忆"删除文件"选项
  const toggleDeleteFiles = useCallback((checked: boolean) => {
    setShouldDeleteFiles(checked);
    setDeleteFiles(checked);
  }, []);

  const statusText = useCallback((s: OfflineFileStatus) => {
    const map: Record<number, { text: string; color: string }> = {
      0: { text: "初始", color: "default" },
      1: { text: "下载中", color: "processing" },
      2: { text: "完成", color: "success" },
      3: { text: "错误", color: "error" },
      4: { text: "未知", color: "default" },
    };
    return map[s] ?? { text: "未知", color: "default" };
  }, []);

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        message.success("链接已复制");
      } catch {
        message.error("复制失败，请手动复制");
      }
    },
    [message],
  );

  const doRemove = useCallback(
    async (keys: string[], deleteFiles: boolean) => {
      try {
        await removeOfflineFilesBulk(keys, deleteFiles);
        message.success("操作成功");
        setSelected((prev) => {
          const next = prev.filter((key) => !keys.includes(key as string));
          selectedRef.current = next;
          return next;
        });
        const removedTaskKeys = new Set(keys);
        setExpandedTaskKeys((previous) => previous.filter((key) => !removedTaskKeys.has(key)));
        setTaskFileStates((previous) => {
          const next = { ...previous };
          for (const key of removedTaskKeys) delete next[key];
          taskFileStatesRef.current = next;
          return next;
        });
        window.dispatchEvent(new CustomEvent("cd2-task-deleted"));
      } catch (err) {
        message.error((err as Error)?.message || "操作失败");
      }
    },
    [message],
  );

  const reDownload = useCallback(
    async (row: Row) => {
      const hideMsg = message.loading("正在重新提交...", 0);
      try {
        await removeOfflineFilesBulk([row.infoHash || row.key], false);
        // Wait for the server to clear the cache/database before resubmitting
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const cfg = getConfig();
        const res = await submitOffline(row.url, cfg.offlineDestPath);
        if (res.ok) {
          message.success("已重新提交下载");
          hideMsg();

          try {
            await listSubFiles(cfg.offlineDestPath || "/", true);
          } catch (e) {
            console.warn("Failed to force refresh directory", e);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));

          // 立即从缺失集合中移除，以免UI因旧状态渲染为红色
          setMissingTasks((prev) => {
            const next = new Set(prev);
            next.delete(row.key);
            if (row.infoHash) next.delete(row.infoHash);
            return next;
          });

          window.dispatchEvent(
            new CustomEvent("cd2-task-submitted", {
              detail: { urls: row.url },
            }),
          );
        } else {
          hideMsg();
          if (res.alreadyExists) {
            message.error("提交失败: 任务已存在 (服务端未及时清除)");
          } else {
            message.error(res.errorMessage || "提交失败");
          }
        }
      } catch (err) {
        hideMsg();
        message.error(`重试失败：${(err as Error).message}`);
      }
    },
    [message],
  );

  const removeOne = useCallback(
    (row: Row) => {
      modal.confirm({
        title: "删除/取消任务？",
        content: (
          <Checkbox defaultChecked={shouldDeleteFiles} onChange={(e) => toggleDeleteFiles(e.target.checked)}>
            同时删除已下载文件
          </Checkbox>
        ),
        okText: "确认",
        cancelText: "关闭",
        onOk: () => doRemove([row.infoHash || row.key], shouldDeleteFiles),
      });
    },
    [doRemove, modal, shouldDeleteFiles, toggleDeleteFiles],
  );

  const locateCloudPath = useCallback((cloudPath: string) => {
    const baseUrl = getConfig().grpcBaseUrl.replace(/\/$/, "");
    window.open(`${baseUrl}/?page=files&path=${encodeURIComponent(cloudPath)}`, "_blank");
  }, []);

  const locateFile = useCallback(
    async (row: Row) => {
      try {
        const cfg = getConfig();
        const trackedLocation = taskLocations[row.key];
        if (trackedLocation?.status === "moved") {
          locateCloudPath(trackedLocation.path);
          return;
        }
        const file = await resolveTaskRoot(
          cfg.offlineDestPath || "/",
          row,
          true,
          taskLocations[row.key]?.status === "moved" ? taskLocations[row.key].path : undefined,
        );
        if (!file) {
          persistTaskRootDeleted(row.key);
          setTaskLocations((previous) => {
            const existing = previous[row.key];
            if (!existing || existing.status === "moved") return previous;
            return { ...previous, [row.key]: { ...existing, status: "deleted" } };
          });
          setMissingTasks((previous) => new Set(previous).add(row.key));
          message.warning("文件已不存在，已标记为删除");
          return;
        }
        locateCloudPath(file.fullPathName);
      } catch (e) {
        message.error(`定位失败：${(e as Error).message}`);
      }
    },
    [locateCloudPath, message, taskLocations],
  );

  const revealLocalFile = useCallback(
    async (file: TaskFile) => {
      try {
        let mountPoints = await getCachedMountPoints();
        let match = mapCloudPathToLocal(file.fullPathName, file.isDirectory, mountPoints);
        if (!match) {
          mountPoints = await getCachedMountPoints(true);
          match = mapCloudPathToLocal(file.fullPathName, file.isDirectory, mountPoints);
        }
        if (!match) {
          message.warning("文件不在任何已挂载的 CloudDrive2 目录中");
          return;
        }
        const runtime = (
          globalThis as typeof globalThis & {
            chrome?: {
              runtime?: {
                id?: string;
                sendMessage?: (message: unknown) => Promise<{ ok: boolean; error?: string }>;
              };
            };
          }
        ).chrome?.runtime;
        if (!runtime?.id || !runtime.sendMessage) {
          message.error("本地文件定位仅在浏览器扩展中可用");
          return;
        }
        const result = await runtime.sendMessage({
          type: "cd2-open-local-path",
          localPath: file.isDirectory ? match.localDirectory : match.localTarget,
          reveal: !file.isDirectory,
        });
        if (!result.ok) throw new Error(result.error || "本地助手未能打开路径");
      } catch (error) {
        message.error(`本地定位失败：${(error as Error).message}`);
      }
    },
    [message],
  );

  const revealLocalTask = useCallback(
    async (row: Row) => {
      try {
        const cfg = getConfig();
        const root = await resolveTaskRoot(
          cfg.offlineDestPath || "/",
          row,
          true,
          taskLocations[row.key]?.status === "moved" ? taskLocations[row.key].path : undefined,
        );
        if (!root) {
          message.warning("未找到任务文件，可能已经被移动或删除");
          return;
        }
        await revealLocalFile(root);
      } catch (error) {
        message.error(`读取任务本地位置失败：${(error as Error).message}`);
      }
    },
    [message, revealLocalFile, taskLocations],
  );

  const loadTaskDirectory = useCallback(
    async (browser: TaskFileBrowser, selectAll = selectedRef.current.includes(browser.task.key)) => {
      const taskKey = browser.task.key;
      const requestId = (taskFilesRequestRef.current.get(taskKey) ?? 0) + 1;
      taskFilesRequestRef.current.set(taskKey, requestId);
      setTaskFileStates((previous) => {
        const next = {
          ...previous,
          [taskKey]: createTaskFileState(browser, true),
        };
        taskFileStatesRef.current = next;
        return next;
      });
      try {
        const files = browser.root.isDirectory ? await listSubFiles(browser.currentPath) : [browser.root];
        if (requestId !== taskFilesRequestRef.current.get(taskKey)) return;
        const rootFiles = createTaskTreeFiles(files);
        const rootKeys = rootFiles.map((file) => String(getTaskFileKey(file)));
        setTaskFileStates((previous) => {
          const next = {
            ...previous,
            [taskKey]: {
              ...createTaskFileState(browser, false),
              files: rootFiles,
              allFiles: rootFiles,
              rootKeys,
              selectedKeys: selectAll ? rootKeys : [],
            },
          };
          taskFileStatesRef.current = next;
          return next;
        });
      } catch (error) {
        if (requestId === taskFilesRequestRef.current.get(taskKey)) {
          setTaskFileStates((previous) => {
            const next = {
              ...previous,
              [taskKey]: createTaskFileState(browser, false),
            };
            taskFileStatesRef.current = next;
            return next;
          });
          message.error(`读取任务文件失败：${(error as Error).message}`);
        }
      }
    },
    [message],
  );

  const toggleTaskDirectory = useCallback(
    async (taskKey: string, directory: TaskTreeFile) => {
      const directoryKey = String(getTaskFileKey(directory));
      const current = taskFileStatesRef.current[taskKey];
      if (!current || current.loadingDirectoryKeys.includes(directoryKey)) return;

      if (current.expandedDirectoryKeys.includes(directoryKey)) {
        setTaskFileStates((previous) => {
          const state = previous[taskKey];
          if (!state) return previous;
          const expandedDirectoryKeys = state.expandedDirectoryKeys.filter((key) => key !== directoryKey);
          const nextState = {
            ...state,
            expandedDirectoryKeys,
            files: flattenTaskTree(state.allFiles, state.rootKeys, state.childrenByDirectory, expandedDirectoryKeys),
          };
          const next = { ...previous, [taskKey]: nextState };
          taskFileStatesRef.current = next;
          return next;
        });
        return;
      }

      if (current.childrenByDirectory[directoryKey]) {
        setTaskFileStates((previous) => {
          const state = previous[taskKey];
          if (!state) return previous;
          const expandedDirectoryKeys = [...state.expandedDirectoryKeys, directoryKey];
          const nextState = {
            ...state,
            expandedDirectoryKeys,
            files: flattenTaskTree(state.allFiles, state.rootKeys, state.childrenByDirectory, expandedDirectoryKeys),
          };
          const next = { ...previous, [taskKey]: nextState };
          taskFileStatesRef.current = next;
          return next;
        });
        return;
      }

      const requestKey = `${taskKey}\n${directoryKey}`;
      const requestId = (taskFilesRequestRef.current.get(requestKey) ?? 0) + 1;
      taskFilesRequestRef.current.set(requestKey, requestId);
      setTaskFileStates((previous) => {
        const state = previous[taskKey];
        if (!state) return previous;
        const next = {
          ...previous,
          [taskKey]: {
            ...state,
            loadingDirectoryKeys: [...state.loadingDirectoryKeys, directoryKey],
          },
        };
        taskFileStatesRef.current = next;
        return next;
      });

      try {
        const children = createTaskTreeFiles(await listSubFiles(directory.fullPathName), directory);
        if (requestId !== taskFilesRequestRef.current.get(requestKey)) return;
        setTaskFileStates((previous) => {
          const state = previous[taskKey];
          if (!state) return previous;
          const childKeys = children.map((file) => String(getTaskFileKey(file)));
          const childKeySet = new Set(childKeys);
          const allFiles = [
            ...state.allFiles.filter((file) => !childKeySet.has(String(getTaskFileKey(file)))),
            ...children,
          ];
          const childrenByDirectory = {
            ...state.childrenByDirectory,
            [directoryKey]: childKeys,
          };
          const expandedDirectoryKeys = [...state.expandedDirectoryKeys, directoryKey];
          const selectedKeys = selectedRef.current.includes(taskKey)
            ? Array.from(new Set([...state.selectedKeys.map(String), ...childKeys]))
            : state.selectedKeys;
          const nextState = {
            ...state,
            allFiles,
            childrenByDirectory,
            expandedDirectoryKeys,
            loadingDirectoryKeys: state.loadingDirectoryKeys.filter((key) => key !== directoryKey),
            selectedKeys,
            files: flattenTaskTree(allFiles, state.rootKeys, childrenByDirectory, expandedDirectoryKeys),
          };
          const next = { ...previous, [taskKey]: nextState };
          taskFileStatesRef.current = next;
          return next;
        });
      } catch (error) {
        if (requestId !== taskFilesRequestRef.current.get(requestKey)) return;
        setTaskFileStates((previous) => {
          const state = previous[taskKey];
          if (!state) return previous;
          const next = {
            ...previous,
            [taskKey]: {
              ...state,
              loadingDirectoryKeys: state.loadingDirectoryKeys.filter((key) => key !== directoryKey),
            },
          };
          taskFileStatesRef.current = next;
          return next;
        });
        message.error(`读取文件夹失败：${(error as Error).message}`);
      }
    },
    [message],
  );

  const openTaskFiles = useCallback(
    async (task: Row) => {
      const taskKey = task.key;
      setExpandedTaskKeys((previous) => (previous.includes(taskKey) ? previous : [...previous, taskKey]));
      if (taskFileStatesRef.current[taskKey]?.browser) return;

      const requestId = (taskFilesRequestRef.current.get(taskKey) ?? 0) + 1;
      taskFilesRequestRef.current.set(taskKey, requestId);
      setTaskFileStates((previous) => {
        const next = {
          ...previous,
          [taskKey]: createTaskFileState(null, true),
        };
        taskFileStatesRef.current = next;
        return next;
      });
      try {
        const cfg = getConfig();
        const root = await resolveTaskRoot(
          cfg.offlineDestPath || "/",
          task,
          true,
          taskLocations[task.key]?.status === "moved" ? taskLocations[task.key].path : undefined,
        );
        if (requestId !== taskFilesRequestRef.current.get(taskKey)) return;
        if (!root) {
          message.warning("未找到任务文件，可能已经被移动或删除");
          setExpandedTaskKeys((previous) => previous.filter((key) => key !== taskKey));
          setTaskFileStates((previous) => {
            const next = {
              ...previous,
              [taskKey]: createTaskFileState(null, false),
            };
            taskFileStatesRef.current = next;
            return next;
          });
          return;
        }
        await loadTaskDirectory({
          task,
          root,
          currentPath: root.isDirectory ? root.fullPathName : getCloudParentPath(root.fullPathName),
        });
      } catch (error) {
        if (requestId !== taskFilesRequestRef.current.get(taskKey)) return;
        message.error(`打开任务文件失败：${(error as Error).message}`);
        setExpandedTaskKeys((previous) => previous.filter((key) => key !== taskKey));
        setTaskFileStates((previous) => {
          const next = {
            ...previous,
            [taskKey]: createTaskFileState(null, false),
          };
          taskFileStatesRef.current = next;
          return next;
        });
      }
    },
    [loadTaskDirectory, message, taskLocations],
  );

  const closeTaskFiles = useCallback((taskKey: string) => {
    setExpandedTaskKeys((previous) => previous.filter((key) => key !== taskKey));
  }, []);

  const deleteTaskFileGroups = useCallback(
    async (groups: TaskFileSelectionGroup[]) => {
      const files = groups.flatMap((group) => group.files);
      if (files.length === 0) return;
      const browsers = new Map(
        groups.map((group) => [group.taskKey, taskFileStatesRef.current[group.taskKey]?.browser ?? null]),
      );
      const hide = message.loading(`正在删除 ${files.length} 项...`, 0);
      try {
        await deleteCloudFiles(files.map((file) => file.fullPathName));
        message.success(files.length === 1 ? "文件已删除" : `已删除 ${files.length} 项`);
        const affectedTaskKeys = new Set(groups.map((group) => group.taskKey));
        setTaskFileStates((previous) => {
          const next = { ...previous };
          for (const taskKey of affectedTaskKeys) {
            const state = next[taskKey];
            if (state) next[taskKey] = { ...state, selectedKeys: [] };
          }
          taskFileStatesRef.current = next;
          return next;
        });
        setSelected((previous) => {
          const next = previous.filter((key) => !affectedTaskKeys.has(String(key)));
          selectedRef.current = next;
          return next;
        });
        const reloads: Promise<void>[] = [];
        for (const [taskKey, browser] of browsers) {
          if (browser?.root.isDirectory) {
            reloads.push(loadTaskDirectory(browser, false));
          } else {
            closeTaskFiles(taskKey);
            setTaskFileStates((previous) => {
              const next = { ...previous };
              delete next[taskKey];
              taskFileStatesRef.current = next;
              return next;
            });
          }
        }
        await Promise.all(reloads);
      } catch (error) {
        message.error(`删除失败：${(error as Error).message}`);
        throw error;
      } finally {
        hide();
      }
    },
    [closeTaskFiles, loadTaskDirectory, message],
  );

  const confirmDeleteTaskFiles = useCallback(
    (groups: TaskFileSelectionGroup[]) => {
      const files = groups.flatMap((group) => group.files);
      if (files.length === 0) return;
      modal.confirm({
        title: files.length === 1 ? `删除“${files[0].name}”？` : `删除选中的 ${files.length} 项？`,
        content: "将通过 CloudDrive2 删除对应文件或目录；能否进入回收站取决于云盘自身规则。",
        okText: "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => deleteTaskFileGroups(groups),
      });
    },
    [deleteTaskFileGroups, modal],
  );

  const removeSelected = useCallback(() => {
    const taskKeys = selected.filter((key) => !partialTaskKeys.has(String(key))) as string[];
    const groups = selectedPartialTaskFileGroups;
    const files = selectedPartialTaskFiles;
    if (taskKeys.length === 0 && files.length === 0) return;

    if (taskKeys.length === 0) {
      confirmDeleteTaskFiles(groups);
      return;
    }

    let deleteDownloadedFiles = shouldDeleteFiles;
    modal.confirm({
      title:
        files.length > 0
          ? `删除所选的 ${taskKeys.length} 个任务和 ${files.length} 个文件？`
          : `删除/取消 ${taskKeys.length} 个任务？`,
      content: (
        <Space direction="vertical" size={8}>
          {files.length > 0 && (
            <Typography.Text>选中的内部文件将通过 CloudDrive2 删除；能否进入回收站取决于云盘自身规则。</Typography.Text>
          )}
          <Checkbox
            defaultChecked={shouldDeleteFiles}
            onChange={(event) => {
              deleteDownloadedFiles = event.target.checked;
              toggleDeleteFiles(event.target.checked);
            }}
          >
            同时删除所选任务的已下载文件
          </Checkbox>
        </Space>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        if (files.length > 0) await deleteTaskFileGroups(groups);
        await doRemove(taskKeys, deleteDownloadedFiles);
      },
    });
  }, [
    confirmDeleteTaskFiles,
    deleteTaskFileGroups,
    doRemove,
    modal,
    partialTaskKeys,
    selected,
    selectedPartialTaskFileGroups,
    selectedPartialTaskFiles,
    shouldDeleteFiles,
    toggleDeleteFiles,
  ]);

  /** 公共：解析目标文件（含文件夹穿透，支持蓝光目录BFS广搜） */
  const resolveTargetFile = useCallback(
    async (row: Row) => {
      const cfg = getConfig();
      const parentPath = cfg.offlineDestPath || "/";
      const rootFile = await resolveTaskRoot(
        parentPath,
        row,
        true,
        taskLocations[row.key]?.status === "moved" ? taskLocations[row.key].path : undefined,
      );
      if (!rootFile) return undefined;
      if (!rootFile.isDirectory) return rootFile;

      const isMedia = (f: { name: string; isDirectory?: boolean }) =>
        !f.isDirectory && VIDEO_EXTENSIONS.has(getFileExtension(f.name));

      let largestMediaFile: typeof rootFile | undefined;
      let maxMediaSize = -1;
      const allMedia: { file: typeof rootFile; depth: number }[] = [];
      let hasBDMV = false;

      const queue: { path: string; depth: number }[] = [{ path: rootFile.fullPathName, depth: 1 }];
      let queryCount = 0;
      const MAX_DEPTH = 3;
      const MAX_QUERIES = 20;

      while (queue.length > 0 && queryCount < MAX_QUERIES) {
        const item = queue.shift();
        if (!item) break;
        const { path, depth } = item;
        queryCount++;

        try {
          const subFiles = await listSubFiles(path);

          for (const f of subFiles) {
            if (isMedia(f)) {
              allMedia.push({ file: f, depth });
              const size = Number(f.size || 0);
              if (size > maxMediaSize) {
                maxMediaSize = size;
                largestMediaFile = f;
              }
            }
          }

          if (depth < MAX_DEPTH) {
            const subDirs = subFiles.filter((f) => f.isDirectory);
            if (subDirs.length > 0) {
              const bdmvDir = subDirs.find((d) => d.name.toUpperCase() === "BDMV");
              const streamDir = subDirs.find((d) => d.name.toUpperCase() === "STREAM");
              const pUpper = path.toUpperCase();
              const isInsideBdmv = pUpper.endsWith("/BDMV") || pUpper.endsWith("\\BDMV");

              if (bdmvDir || streamDir || isInsideBdmv) {
                hasBDMV = true;
              }

              if (bdmvDir) {
                queue.length = 0;
                queue.push({ path: bdmvDir.fullPathName, depth: depth + 1 });
              } else if (isInsideBdmv && streamDir) {
                queue.length = 0;
                queue.push({ path: streamDir.fullPathName, depth: depth + 1 });
              } else {
                for (const d of subDirs) queue.push({ path: d.fullPathName, depth: depth + 1 });
              }
            }
          }
        } catch (e) {
          console.warn(`[cd2] resolveTargetFile scan failed for ${path}`, e);
        }
      }

      if (hasBDMV) {
        return largestMediaFile;
      } else {
        if (allMedia.length === 0) return undefined;
        const nameOrderedMedia = sortMediaPlaylistByName(
          allMedia.map(({ file }) => ({
            file,
            fileName: file.name,
            filePath: file.fullPathName,
            fileSize: Number(file.size || 0),
          })),
        );
        return selectPreferredMedia(nameOrderedMedia)?.file;
      }
    },
    [taskLocations],
  );

  /** 扫描文件夹内所有媒体文件，返回播放列表 */
  const resolvePlaylist = useCallback(
    async (row: Row): Promise<{ fileName: string; filePath: string; fileSize: number }[]> => {
      const cfg = getConfig();
      const parentPath = cfg.offlineDestPath || "/";
      const rootFile = await resolveTaskRoot(
        parentPath,
        row,
        true,
        taskLocations[row.key]?.status === "moved" ? taskLocations[row.key].path : undefined,
      );
      if (!rootFile?.isDirectory) return [];

      const isMedia = (f: { name: string; isDirectory?: boolean }) =>
        !f.isDirectory && VIDEO_EXTENSIONS.has(getFileExtension(f.name));

      const allMedia: {
        fileName: string;
        filePath: string;
        fileSize: number;
      }[] = [];
      const queue = [rootFile.fullPathName];
      let queryCount = 0;
      const MAX_QUERIES = 500;

      while (queue.length > 0 && queryCount < MAX_QUERIES) {
        const path = queue.shift();
        if (!path) break;
        queryCount++;
        try {
          const subFiles = await listSubFiles(path);
          for (const f of subFiles) {
            if (isMedia(f))
              allMedia.push({
                fileName: f.name,
                filePath: f.fullPathName,
                fileSize: Number(f.size || 0),
              });
          }
          const subDirs = subFiles.filter((f) => f.isDirectory);
          for (const directory of subDirs) queue.push(directory.fullPathName);
        } catch (e) {
          console.warn(`[cd2] resolvePlaylist scan failed for ${path}`, e);
        }
      }

      return sortMediaPlaylistByName(allMedia);
    },
    [taskLocations],
  );

  /** 扫描视频文件所在目录的字幕文件 */
  const resolveSubtitles = useCallback(async (videoFilePath: string): Promise<SubtitleFile[]> => {
    const subtitleExts = new Set(["srt", "ass", "ssa", "vtt"]);
    const isSubtitle = (f: { name: string; isDirectory?: boolean }) =>
      !f.isDirectory && subtitleExts.has(getFileExtension(f.name));

    // 获取视频文件所在目录路径
    const lastSlash = Math.max(videoFilePath.lastIndexOf("/"), videoFilePath.lastIndexOf("\\"));
    if (lastSlash < 0) return [];
    const parentDir = videoFilePath.substring(0, lastSlash);

    try {
      const files = await listSubFiles(parentDir);
      return files
        .filter(isSubtitle)
        .map((f) => ({ fileName: f.name, filePath: f.fullPathName }))
        .sort((a, b) =>
          a.fileName.localeCompare(b.fileName, undefined, {
            numeric: true,
            sensitivity: "base",
          }),
        );
    } catch (e) {
      console.warn(`[cd2] resolveSubtitles scan failed for ${parentDir}`, e);
      return [];
    }
  }, []);

  /** 将 downloadUrlPath 转为完整 URL */
  const buildVideoUrl = useCallback((urlInfo: { downloadUrlPath?: string; directUrl?: string }): string => {
    const cfg = getConfig();
    if (urlInfo.downloadUrlPath) {
      let p = urlInfo.downloadUrlPath;
      let u: URL;
      try {
        u = new URL(cfg.grpcBaseUrl || window.location.origin);
      } catch {
        u = new URL(window.location.origin);
      }
      p = p.replace(/(\{SCHEME\}|%7BSCHEME%7D)/gi, u.protocol.replace(":", ""));
      p = p.replace(/(\{HOST\}|%7BHOST%7D)/gi, u.host);
      if (p.startsWith("http//")) p = p.replace("http//", "http://");
      if (p.startsWith("https//")) p = p.replace("https//", "https://");
      if (p.startsWith("http://") || p.startsWith("https://")) return p;
      const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
      p = p.startsWith("/") ? p : `/${p}`;
      return `${baseUrl}${p}`;
    }
    return urlInfo.directUrl || "";
  }, []);

  const resolveSubtitleUrls = useCallback(
    async (subtitles: SubtitleFile[]): Promise<ResolvedSubtitleFile[]> => {
      const resolved = await Promise.all(
        subtitles.map(async (subtitle) => {
          try {
            const urlInfo = await getDownloadUrlPath(subtitle.filePath, true);
            const url = buildVideoUrl(urlInfo);
            return url ? { ...subtitle, url } : null;
          } catch {
            return null;
          }
        }),
      );
      return resolved.filter((subtitle): subtitle is ResolvedSubtitleFile => subtitle !== null);
    },
    [buildVideoUrl],
  );

  // 监听来自 artplayer 的分集 URL 解析请求
  useEffect(() => {
    const onResolveVideoUrl = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.filePath || !detail.requestId) return;

      const realWindow = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as Window;
      try {
        const urlInfo = await getDownloadUrlPath(detail.filePath, true);
        const videoUrl = buildVideoUrl(urlInfo);
        realWindow.dispatchEvent(
          new CustomEvent("cd2-video-url-resolved", {
            detail: { requestId: detail.requestId, videoUrl },
          }),
        );
      } catch (err) {
        realWindow.dispatchEvent(
          new CustomEvent("cd2-video-url-resolved", {
            detail: {
              requestId: detail.requestId,
              error: (err as Error).message,
            },
          }),
        );
      }
    };

    // 监听来自 artplayer 的字幕文件请求（分集切换时）
    const onResolveSubtitles = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || !detail.filePath || !detail.requestId) return;

      const realWindow2 = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as Window;
      try {
        const subs = await resolveSubtitles(detail.filePath);
        const subsWithUrl = await resolveSubtitleUrls(subs);
        realWindow2.dispatchEvent(
          new CustomEvent("cd2-subtitles-resolved", {
            detail: {
              requestId: detail.requestId,
              subtitles: subsWithUrl.filter(Boolean),
            },
          }),
        );
      } catch (err) {
        realWindow2.dispatchEvent(
          new CustomEvent("cd2-subtitles-resolved", {
            detail: {
              requestId: detail.requestId,
              subtitles: [],
              error: (err as Error).message,
            },
          }),
        );
      }
    };

    const realWindow = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as Window;
    realWindow.addEventListener("cd2-resolve-video-url", onResolveVideoUrl);
    realWindow.addEventListener("cd2-resolve-subtitles", onResolveSubtitles);
    return () => {
      realWindow.removeEventListener("cd2-resolve-video-url", onResolveVideoUrl);
      realWindow.removeEventListener("cd2-resolve-subtitles", onResolveSubtitles);
    };
  }, [buildVideoUrl, resolveSubtitles, resolveSubtitleUrls]);

  /** 播放：支持网页端和本地外部播放器串流 */
  const playFile = useCallback(
    async (row: Row, playerType: PlayerType = "web", targetFile?: TaskFile) => {
      const hide = message.loading(`正在获取${playerType === "web" ? "播放" : "串流"}地址...`, 0);
      try {
        const file = targetFile ?? (await resolveTargetFile(row));
        if (!file) {
          message.warning("未找到可播放的媒体文件，请在 CloudDrive2 网页端查看。");
          return;
        }

        // 当用户试图在网页端播放 ISO 或 BDMV 内的 M2TS 时，给出友好警告
        if (
          playerType === "web" &&
          (file.name.toLowerCase().endsWith(".iso") || file.name.toLowerCase().endsWith(".m2ts"))
        ) {
          message.info("注意：当前文件格式在网页端可能无法播放，推荐使用外部播放器。");
        }

        const cfg = getConfig();
        // 如果是外部播放器，也必须启用 preview = true。
        // 因为 preview = false 返回的直链会锁定单线程附加下载模式，导致 PotPlayer 分片请求时触发“文件不存在或被锁定”。
        const urlInfo = await getDownloadUrlPath(file.fullPathName, true);
        const videoUrl = buildVideoUrl(urlInfo);

        if (!videoUrl) {
          message.error("获取播放地址失败");
          return;
        }

        // 网页播放使用内嵌 ArtPlayer 弹幕播放器。
        if (playerType === "web") {
          const realWindow = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as Window & {
            __cd2ArtplayerReady?: boolean;
          };

          if (realWindow.__cd2ArtplayerReady) {
            const isVideo = VIDEO_EXTENSIONS.has(getFileExtension(file.name));
            if (isVideo && getFileExtension(file.name) === "mkv") {
              realWindow.dispatchEvent(
                new CustomEvent("cd2-preload-video-audio", {
                  detail: {
                    videoUrl,
                    fileSize: Number(file.size || 0),
                    filePath: file.fullPathName,
                    fileName: file.name,
                  },
                }),
              );
            }
            // 音频文件不混入视频选集，也不扫描无关字幕。
            const [playlist, subtitles] = isVideo
              ? await Promise.all([resolvePlaylist(row), resolveSubtitles(file.fullPathName)])
              : [[], []];
            const currentIndex = playlist.findIndex((p) => p.filePath === file.fullPathName);

            const subsWithUrl = await resolveSubtitleUrls(subtitles);

            realWindow.dispatchEvent(
              new CustomEvent("cd2-play-video", {
                detail: {
                  folderName: row.name,
                  fileName: file.name,
                  filePath: file.fullPathName,
                  videoUrl,
                  grpcBaseUrl: cfg.grpcBaseUrl,
                  apiToken: cfg.apiToken,
                  playlist: playlist.length > 1 ? playlist : undefined,
                  currentIndex: playlist.length > 1 ? (currentIndex >= 0 ? currentIndex : 0) : undefined,
                  subtitles: subsWithUrl.filter(Boolean),
                  fileSize: Number(file.size || 0),
                },
              }),
            );
            return;
          }

          // 内嵌播放器未就绪时，回退为直接打开视频地址。
          window.open(videoUrl, "_blank");
          return;
        }

        // 外部播放器调用逻辑
        {
          const openExternalUrl = (externalUrl: string) => {
            const anchor = document.createElement("a");
            anchor.setAttribute("href", externalUrl);
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            window.setTimeout(() => anchor.remove(), 500);
          };
          const isVideo = VIDEO_EXTENSIONS.has(getFileExtension(file.name));
          let externalPlaylist = [
            {
              fileName: file.name,
              filePath: file.fullPathName,
              videoUrl,
            },
          ];
          // Infuse 官方协议支持一次传入多个 url；PotPlayer 由新版
          // Native Host 生成单个 DPL 后一次启动，避免多次协议调用乱序。
          if (isVideo && (playerType === "infuse" || playerType === "potplayer")) {
            const playlist = await resolvePlaylist(row);
            const normalizePlaylistPath = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
            const targetPath = normalizePlaylistPath(file.fullPathName);
            const orderedPlaylist = playlist.some((item) => normalizePlaylistPath(item.filePath) === targetPath)
              ? playlist
              : sortMediaPlaylistByName([
                  ...playlist,
                  {
                    fileName: file.name,
                    filePath: file.fullPathName,
                    fileSize: Number(file.size || 0),
                  },
                ]);
            const resolvedPlaylist = [] as typeof externalPlaylist;
            const concurrency = 4;
            for (let first = 0; first < orderedPlaylist.length; first += concurrency) {
              const entries = await Promise.all(
                orderedPlaylist.slice(first, first + concurrency).map(async (item) => {
                  if (normalizePlaylistPath(item.filePath) === targetPath) return { ...item, videoUrl };
                  try {
                    const itemUrlInfo = await getDownloadUrlPath(item.filePath, true);
                    const itemVideoUrl = buildVideoUrl(itemUrlInfo);
                    return itemVideoUrl ? { ...item, videoUrl: itemVideoUrl } : undefined;
                  } catch (error) {
                    console.warn(`[cd2] external playlist URL failed for ${item.filePath}`, error);
                    return undefined;
                  }
                }),
              );
              resolvedPlaylist.push(...entries.filter((entry) => entry !== undefined));
            }
            if (resolvedPlaylist.length > 0) externalPlaylist = resolvedPlaylist;
          }
          switch (playerType) {
            case "potplayer": {
              let helperStartedPlaylist = false;
              if (externalPlaylist.length > 1) {
                const runtime = (
                  globalThis as typeof globalThis & {
                    chrome?: {
                      runtime?: {
                        id?: string;
                        sendMessage?: (message: unknown) => Promise<{
                          ok?: boolean;
                          error?: string;
                        }>;
                      };
                    };
                  }
                ).chrome?.runtime;
                if (runtime?.id && runtime.sendMessage) {
                  try {
                    const result = await runtime.sendMessage({
                      type: "cd2-play-potplayer-playlist",
                      title: row.name,
                      startUrl: videoUrl,
                      entries: externalPlaylist.map((entry) => ({
                        url: entry.videoUrl,
                        fileName: entry.fileName,
                      })),
                    });
                    if (result?.ok) helperStartedPlaylist = true;
                    else console.warn(`[cd2] PotPlayer playlist helper failed: ${result?.error || "unknown error"}`);
                  } catch (error) {
                    console.warn("[cd2] PotPlayer playlist helper failed", error);
                  }
                }
                if (helperStartedPlaylist) break;
                try {
                  GM_setClipboard(buildPotPlayerClipboardPlaylist(externalPlaylist, videoUrl), "text");
                  openExternalUrl("potplayer:///clipboard");
                  break;
                } catch (error) {
                  console.warn("[cd2] PotPlayer clipboard fallback failed", error);
                }
                message.warning("无法写入 PotPlayer 播放列表，已播放当前视频；请检查扩展的剪贴板权限");
              }
              openExternalUrl(`potplayer://${videoUrl}`);
              break;
            }
            case "infuse": {
              const parameters = new URLSearchParams();
              for (const entry of externalPlaylist) {
                parameters.append("url", entry.videoUrl);
                parameters.append("filename", entry.fileName);
              }
              openExternalUrl(`infuse://x-callback-url/play?${parameters.toString()}`);
              break;
            }
            case "dandanplay":
              openExternalUrl(`ddplay:${encodeURIComponent(`${videoUrl}|filePath=${file.name}`)}`);
              if (externalPlaylist.length > 1) message.info("弹弹Play 专用链暂不支持传入串流播放列表");
              break;
            default:
              message.error("不支持的播放器");
              return;
          }
        }
      } catch (e) {
        message.error(`播放失败：${(e as Error).message}`);
      } finally {
        hide();
      }
    },
    [message, resolveTargetFile, buildVideoUrl, resolvePlaylist, resolveSubtitles, resolveSubtitleUrls],
  );

  /** 下载：preview=false，走附件下载模式 */
  const downloadFile = useCallback(
    async (row: Row, targetFile?: TaskFile) => {
      const hide = message.loading("正在获取下载地址...", 0);
      try {
        const file = targetFile ?? (await resolveTargetFile(row));
        if (!file) {
          message.warning("未找到可下载的文件，请在 CloudDrive2 网页端查看。");
          return;
        }
        const urlInfo = await getDownloadUrlPath(file.fullPathName, false);
        const downloadUrl = buildVideoUrl(urlInfo);

        if (downloadUrl) {
          window.open(downloadUrl, "_blank");
        } else {
          message.error("获取下载地址失败");
        }
      } catch (e) {
        message.error(`下载失败：${(e as Error).message}`);
      } finally {
        hide();
      }
    },
    [message, resolveTargetFile, buildVideoUrl],
  );

  const createTaskFileColumns = useCallback(
    (browser: TaskFileBrowser, state: TaskFileState): ColumnsType<TaskTreeFile> => {
      return [
        {
          title: "文件名",
          dataIndex: "name",
          key: "name",
          ellipsis: { showTitle: false },
          render: (name: string, file: TaskTreeFile) => {
            const fileKey = String(getTaskFileKey(file));
            const isExpanded = state.expandedDirectoryKeys.includes(fileKey);
            const isLoading = state.loadingDirectoryKeys.includes(fileKey);
            const indentKeys = ["task-root", ...file.treeAncestorKeys];
            const indents = (
              <span className="cd2-task-tree-indents" aria-hidden="true">
                {indentKeys.map((indentKey) => (
                  <span key={indentKey} className="cd2-task-tree-indent" />
                ))}
              </span>
            );

            return (
              <span className="cd2-task-tree-name-cell">
                {indents}
                {file.isDirectory ? (
                  <button
                    type="button"
                    className="cd2-task-file-name cd2-task-tree-trigger"
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? "收起" : "展开"}文件夹：${name}`}
                    onClick={() => void toggleTaskDirectory(browser.task.key, file)}
                  >
                    <span className="cd2-task-tree-fold" aria-hidden="true">
                      {isLoading ? <LoadingOutlined spin /> : isExpanded ? <DownOutlined /> : <RightOutlined />}
                    </span>
                    {renderTaskFileTypeIcon(file)}
                    <span>{name}</span>
                  </button>
                ) : (
                  <span className="cd2-task-file-label">
                    <span className="cd2-task-tree-fold" aria-hidden="true" />
                    {renderTaskFileTypeIcon(file)}
                    <span>{name}</span>
                  </span>
                )}
              </span>
            );
          },
        },
        {
          title: "状态",
          key: "info",
          width: 90,
          render: (_: unknown, file: TaskFile) => {
            if (file.isDirectory) return null;
            return (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatFileBytes(file.size)}
              </Typography.Text>
            );
          },
        },
        {
          title: "操作",
          key: "actions",
          width: 180,
          render: (_: unknown, file: TaskFile) => {
            return (
              <Space size={2} onClick={(event) => event.stopPropagation()}>
                <Tooltip title="在 CloudDrive2 中定位">
                  <Button
                    size="small"
                    type="text"
                    icon={<FolderOpenOutlined />}
                    onClick={() => locateCloudPath(file.fullPathName)}
                  />
                </Tooltip>
                {localDirectoryEnabled && (
                  <Tooltip title={file.isDirectory ? "打开本地目录" : "在本地文件管理器中定位"}>
                    <Button size="small" type="text" icon={<DesktopOutlined />} onClick={() => revealLocalFile(file)} />
                  </Tooltip>
                )}
                {isPlayableFile(file) && (
                  <Dropdown
                    key={defaultPlayer}
                    trigger={["contextMenu"]}
                    menu={{
                      items: Object.entries(PLAYER_CONFIG).map(([key, item]) => ({
                        key,
                        label: item.label,
                        icon: renderPlayerIcon(key as PlayerType, key),
                      })),
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        const player = key as PlayerType;
                        setDefaultPlayer(player);
                        setPreferredPlayer(player);
                      },
                    }}
                  >
                    <Tooltip title="左键播放，右键选择播放器">
                      <Button
                        size="small"
                        type="text"
                        icon={renderPlayerIcon(defaultPlayer)}
                        onClick={() => playFile(browser.task, defaultPlayer, file)}
                      />
                    </Tooltip>
                  </Dropdown>
                )}
                {!file.isDirectory && (
                  <Tooltip title="下载此文件">
                    <Button
                      size="small"
                      type="text"
                      icon={<DownloadOutlined />}
                      onClick={() => downloadFile(browser.task, file)}
                    />
                  </Tooltip>
                )}
                <Tooltip title="删除此文件或目录">
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => confirmDeleteTaskFiles([{ taskKey: browser.task.key, files: [file] }])}
                  />
                </Tooltip>
              </Space>
            );
          },
        },
      ];
    },
    [
      defaultPlayer,
      confirmDeleteTaskFiles,
      downloadFile,
      localDirectoryEnabled,
      locateCloudPath,
      playFile,
      revealLocalFile,
      toggleTaskDirectory,
    ],
  );

  const columns: ColumnsType<Row> = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        key: "name",
        ellipsis: { showTitle: false },
        render: (name: string, row: Row) => {
          const locationStatus = taskLocations[row.key]?.status;
          const isUnavailable =
            locationStatus === "deleted" || (missingTasks.has(row.key) && locationStatus !== "moved");
          const isExpandable = row.status === OfflineFileStatus.OFFLINE_FINISHED && !isUnavailable;
          const isExpanded = expandedTaskKeys.includes(row.key);
          const content = (
            <>
              <span className={`cd2-task-fold-icon${isExpandable ? " cd2-is-expandable" : ""}`} aria-hidden="true">
                {isExpandable && (isExpanded ? <DownOutlined /> : <RightOutlined />)}
              </span>
              <span>{name}</span>
            </>
          );

          return isExpandable ? (
            <button
              type="button"
              className="cd2-task-name-cell cd2-task-expand-trigger"
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? "收起" : "展开"}任务文件：${name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (isExpanded) closeTaskFiles(row.key);
                else void openTaskFiles(row);
              }}
            >
              {content}
            </button>
          ) : (
            <span className="cd2-task-name-cell">{content}</span>
          );
        },
      },
      {
        title: "状态",
        key: "info",
        width: 90,
        render: (_: unknown, r: Row) => {
          const isMissing = missingTasks.has(r.key);
          const locationStatus = taskLocations[r.key]?.status;
          const st = statusText(r.status);
          return (
            <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
              {locationStatus === "moved" ? (
                <>
                  <Tag color="warning" style={{ margin: 0 }}>
                    文件已迁移
                  </Tag>
                  <Tooltip title={getCloudParentPath(taskLocations[r.key].path)}>
                    <Typography.Text type="secondary" ellipsis style={{ display: "block", maxWidth: 88, fontSize: 10 }}>
                      {getCloudParentPath(taskLocations[r.key].path)}
                    </Typography.Text>
                  </Tooltip>
                </>
              ) : locationStatus === "deleted" ? (
                <Tag color="error" style={{ margin: 0 }}>
                  文件已删除
                </Tag>
              ) : isMissing ? (
                <Tag color="error" style={{ margin: 0 }}>
                  文件已删除
                </Tag>
              ) : (
                <Tag color={st.color} style={{ margin: 0 }}>
                  {st.text} {formatTaskProgress(r.percendDonePct)}%
                </Tag>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatMegabytes(r.sizeMB)}
              </Typography.Text>
            </Space>
          );
        },
      },
      {
        title: "操作",
        key: "actions",
        width: 180,
        render: (_: unknown, r: Row) => {
          const isMissing = missingTasks.has(r.key);
          const locationStatus = taskLocations[r.key]?.status;
          const isUnavailable = locationStatus === "deleted" || (isMissing && locationStatus !== "moved");
          return (
            <Space size={2} onClick={(event) => event.stopPropagation()}>
              {r.status === OfflineFileStatus.OFFLINE_FINISHED &&
                (isUnavailable ? (
                  <Tooltip title="重新下载此任务">
                    <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => reDownload(r)} />
                  </Tooltip>
                ) : (
                  <>
                    <Tooltip title={locationStatus === "moved" ? "定位迁移后的目录" : "在 CloudDrive2 中定位"}>
                      <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => locateFile(r)} />
                    </Tooltip>
                    {localDirectoryEnabled && (
                      <Tooltip title="在本地文件管理器中打开任务位置">
                        <Button
                          size="small"
                          type="text"
                          icon={<DesktopOutlined />}
                          onClick={() => revealLocalTask(r)}
                        />
                      </Tooltip>
                    )}
                    <Dropdown
                      key={defaultPlayer}
                      trigger={["contextMenu"]}
                      menu={{
                        items: Object.entries(PLAYER_CONFIG).map(([key, item]) => ({
                          key,
                          label: item.label,
                          icon: renderPlayerIcon(key as PlayerType, key),
                        })),
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation();
                          const player = key as PlayerType;
                          setDefaultPlayer(player);
                          setPreferredPlayer(player);
                        },
                      }}
                    >
                      <Button
                        size="small"
                        type="text"
                        title="左键播放，右键选择播放器"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          playFile(r, defaultPlayer);
                        }}
                        icon={renderPlayerIcon(defaultPlayer)}
                      />
                    </Dropdown>

                    <Tooltip title="下载">
                      <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => downloadFile(r)} />
                    </Tooltip>
                  </>
                ))}
              <Tooltip title="复制链接">
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyUrl(r.url)} />
              </Tooltip>
              <Tooltip title="删除/取消">
                <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeOne(r)} />
              </Tooltip>
            </Space>
          );
        },
      },
    ],
    [
      copyUrl,
      closeTaskFiles,
      removeOne,
      statusText,
      locateFile,
      localDirectoryEnabled,
      playFile,
      revealLocalTask,
      downloadFile,
      defaultPlayer,
      expandedTaskKeys,
      missingTasks,
      openTaskFiles,
      reDownload,
      taskLocations,
    ],
  );

  const handleOuterSelectionChange = useCallback(
    (keys: React.Key[]) => {
      setTaskFileStates((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [taskKey, state] of Object.entries(previous)) {
          const wasSelected = selected.includes(taskKey);
          const isSelected = keys.includes(taskKey);
          if (wasSelected !== isSelected) {
            next[taskKey] = {
              ...state,
              selectedKeys: isSelected ? state.allFiles.map(getTaskFileKey) : [],
            };
            changed = true;
          }
        }
        if (!changed) return previous;
        taskFileStatesRef.current = next;
        return next;
      });
      selectedRef.current = keys;
      setSelected(keys);
    },
    [selected],
  );

  const handleTaskFileSelectionChange = useCallback((taskKey: string, keys: React.Key[]) => {
    const state = taskFileStatesRef.current[taskKey];
    if (!state) return;
    setTaskFileStates((previous) => {
      const current = previous[taskKey];
      if (!current) return previous;
      const next = {
        ...previous,
        [taskKey]: { ...current, selectedKeys: keys },
      };
      taskFileStatesRef.current = next;
      return next;
    });
    const selectedKeySet = new Set(keys.map(String));
    const allFilesSelected =
      state.allFiles.length > 0 && state.allFiles.every((file) => selectedKeySet.has(String(getTaskFileKey(file))));
    setSelected((previous) => {
      const withoutTask = previous.filter((key) => key !== taskKey);
      const next = allFilesSelected ? [...withoutTask, taskKey] : withoutTask;
      selectedRef.current = next;
      return next;
    });
  }, []);

  const rowSelection = {
    selectedRowKeys: selected,
    columnWidth: 32,
    onChange: handleOuterSelectionChange,
    getCheckboxProps: (row: Row) => {
      const state = taskFileStates[row.key];
      if (!state) return { indeterminate: false };
      const selectedKeys = new Set(state.selectedKeys);
      const selectedCount = state.allFiles.filter((file) => selectedKeys.has(getTaskFileKey(file))).length;
      return {
        indeterminate: selectedCount > 0 && selectedCount < state.allFiles.length,
      };
    },
  };

  const submitSearch = useCallback(() => {
    const nextQuery = searchText.trim();
    changePage(1);
    if (nextQuery === searchQuery) {
      void fetchAll();
    } else {
      setSearchQuery(nextQuery);
    }
  }, [changePage, fetchAll, searchQuery, searchText]);

  const searchPercent =
    searchProgress && searchProgress.totalPages > 0
      ? Math.min(100, Math.round((searchProgress.loadedPages / searchProgress.totalPages) * 100))
      : 0;
  return (
    <div className="cd2-task-list-layout">
      <Flex align="center" justify="space-between" gap={8} className="cd2-task-toolbar">
        <Space size={4} className="cd2-task-toolbar-actions">
          <Button size="small" icon={<ReloadOutlined />} onClick={refreshManually} loading={refreshing}>
            {refreshing ? "刷新中" : "刷新"}
          </Button>
          {selected.length > 0 || selectedPartialTaskFiles.length > 0 ? (
            <Button size="small" danger onClick={removeSelected}>
              删除所选({selected.length + selectedPartialTaskFiles.length})
            </Button>
          ) : null}
        </Space>
        <Space.Compact size="small" style={{ width: 190, flexShrink: 0 }}>
          <Input
            allowClear
            size="small"
            placeholder="搜索任务..."
            value={searchText}
            onChange={(event) => {
              const value = event.target.value;
              setSearchText(value);
              if (!value) {
                setSearchQuery("");
                setSearchIndexing(false);
                setSearchProgress(null);
                changePage(1);
              }
            }}
            onPressEnter={submitSearch}
          />
          <Button
            type="primary"
            size="small"
            icon={<SearchOutlined />}
            loading={searchIndexing}
            disabled={!searchText.trim()}
            onClick={submitSearch}
            title="搜索"
          />
        </Space.Compact>
      </Flex>

      {(searchIndexing || searchActive) && (
        <div
          style={{
            padding: "6px 9px",
            borderRadius: 6,
            background: "rgba(22, 119, 255, 0.06)",
            border: "1px solid rgba(22, 119, 255, 0.14)",
          }}
        >
          {searchIndexing ? (
            <Space direction="vertical" size={2} style={{ width: "100%" }}>
              <Flex justify="space-between" align="center" gap={8}>
                <Typography.Text style={{ fontSize: 12 }}>正在建立搜索索引</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                  {searchProgress?.totalPages
                    ? `${searchProgress.loadedPages}/${searchProgress.totalPages} 页`
                    : "准备中…"}
                </Typography.Text>
              </Flex>
              <Progress percent={searchPercent} size="small" showInfo={false} status="active" />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                已读取 {searchProgress?.loadedTasks ?? 0}/{searchProgress?.totalTasks || "?"} 条任务
              </Typography.Text>
            </Space>
          ) : (
            <Flex justify="space-between" align="center" gap={8}>
              <Typography.Text style={{ fontSize: 12 }}>
                找到 <Typography.Text strong>{total}</Typography.Text> 条任务
              </Typography.Text>
              <Typography.Text type="secondary" ellipsis style={{ maxWidth: 220, fontSize: 11 }}>
                {searchQuery}
              </Typography.Text>
            </Flex>
          )}
        </div>
      )}

      <div ref={taskTableRef} className="cd2-task-table">
        <Table<Row>
          size="small"
          key={`table_${defaultPlayer}`}
          rowKey={(r) => r.key}
          rowClassName={(r) => {
            const classNames: string[] = [];
            const hash = getRowHash(r);
            if (hash && pinnedHashesRef.current.has(hash)) classNames.push("cd2-row-highlight");
            return classNames.join(" ");
          }}
          columns={columns}
          dataSource={rows}
          loading={loading}
          tableLayout="fixed"
          rowSelection={rowSelection}
          scroll={{ x: 442, y: 1 }}
          pagination={false}
          expandable={{
            expandedRowKeys: expandedTaskKeys,
            expandRowByClick: false,
            showExpandColumn: false,
            rowExpandable: (row) =>
              row.status === OfflineFileStatus.OFFLINE_FINISHED &&
              taskLocations[row.key]?.status !== "deleted" &&
              (!missingTasks.has(row.key) || taskLocations[row.key]?.status === "moved"),
            expandedRowRender: (row) => {
              const fileState = taskFileStates[row.key];
              const activeBrowser = fileState?.browser ?? null;
              return (
                <div className="cd2-task-files-inline">
                  <Table<TaskTreeFile>
                    className="cd2-task-files-table"
                    size="small"
                    rowKey={getTaskFileKey}
                    columns={activeBrowser && fileState ? createTaskFileColumns(activeBrowser, fileState) : []}
                    dataSource={fileState?.files ?? []}
                    loading={fileState?.loading ?? false}
                    pagination={false}
                    showHeader={false}
                    tableLayout="fixed"
                    rowSelection={{
                      selectedRowKeys: fileState?.selectedKeys ?? [],
                      columnWidth: 32,
                      preserveSelectedRowKeys: true,
                      onChange: (keys) => handleTaskFileSelectionChange(row.key, keys),
                    }}
                    scroll={{ x: 442 }}
                    locale={{
                      emptyText: fileState?.loading ? "正在读取…" : "此目录中没有文件",
                    }}
                  />
                </div>
              );
            },
          }}
        />
      </div>

      <Flex align="center" justify="space-between" className="cd2-task-footer-bar">
        <div className="cd2-task-quota">
          {quota ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              配额：
              <Typography.Text strong style={{ fontSize: 12 }}>
                {quota.left}
              </Typography.Text>{" "}
              / {quota.total}
            </Typography.Text>
          ) : (
            <span />
          )}
        </div>
        <Pagination
          current={page}
          total={total}
          pageSize={PAGE_SIZE}
          size="small"
          showSizeChanger={false}
          onChange={changePage}
          className="cd2-task-pagination"
        />
      </Flex>
    </div>
  );
}
