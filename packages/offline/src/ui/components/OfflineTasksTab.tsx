import { CopyOutlined, DeleteOutlined, DownloadOutlined, FolderOpenOutlined, ReloadOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Checkbox, Dropdown, Flex, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getConfig, getDeleteFiles, setDeleteFiles } from "@/config";
import {
  findFileByPath,
  getDownloadUrlPath,
  getOfflineQuotaInfo,
  listAllOfflineFiles,
  listSubFiles,
  removeOfflineFilesBulk,
  submitOffline,
  subscribePushMessage,
} from "@/grpc/client";
import { OfflineFileStatus } from "@/proto/clouddrive_pb";
import { playlistMemory } from "../../memory";
import infuseImg from "../../../../../icon/infuse.png";
import potplayerImg from "../../../../../icon/potplayer.png";
import dandanplayImg from "../../../../../icon/弹弹play.png";

const PLAYER_CONFIG = {
  web: { label: "网页播放", iconUrl: null, fallbackText: "🌐" },
  artplayer: { label: "ArtPlayer", iconUrl: null, fallbackText: "🎬" },
  potplayer: { label: "PotPlayer", iconUrl: potplayerImg, fallbackText: "🎬" },
  dandanplay: { label: "弹弹Play", iconUrl: dandanplayImg, fallbackText: "📺" },
  infuse: { label: "Infuse", iconUrl: infuseImg, fallbackText: "🔥" },
  vlc: { label: "VLC", iconUrl: null, fallbackText: "🗼" },
  iina: { label: "IINA", iconUrl: null, fallbackText: "🎦" },
} as const;

type PlayerType = keyof typeof PLAYER_CONFIG;

type Row = {
  key: string;
  name: string;
  sizeMB: number;
  url: string;
  status: OfflineFileStatus;
  percendDonePct: number;
  infoHash?: string;
  addTime?: number;
};

const PAGE_SIZE = 30;
const BTIH_RE_SOURCE = "urn:btih:([a-f0-9]{40}|[a-z2-7]{32})";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEX_RE = /^[a-f0-9]{40}$/i;
const BASE32_RE = /^[a-z2-7]{32}$/i;

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
      found.push({
        key: f.infoHash || f.url,
        name: f.name,
        sizeMB: Number(f.size || 0) / (1024 * 1024),
        url: f.url,
        status: f.status,
        percendDonePct: f.percendDone,
        infoHash: f.infoHash,
        addTime: (() => {
          const v = Number(f.addTime || 0);
          if (!v) return undefined;
          return v > 1e12 ? v : v * 1000;
        })(),
      });
      if (foundHashes.size >= pinnedHashes.size) break;
    }
    if (foundHashes.size >= pinnedHashes.size) break;
  }

  return found;
}

export function OfflineTasksTab() {
  const { message, modal } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [quota, setQuota] = useState<{ total: number; used: number; left: number } | null>(null);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [shouldDeleteFiles, setShouldDeleteFiles] = useState(() => getDeleteFiles());
  const [missingTasks, setMissingTasks] = useState<Set<string>>(new Set());
  const [defaultPlayer, setDefaultPlayer] = useState<PlayerType>(
    () =>
      (localStorage.getItem("cd2_default_player") as PlayerType) ||
      "web",
  );
  const reqIdRef = useRef(0);
  /** 最近提交的 btih hash 集合，用于置顶匹配 */
  const pinnedHashesRef = useRef<Set<string>>(new Set());

  // 核心拉取逻辑：showLoading 控制是否显示 loading 动画
  const doFetchAll = useCallback(
    async (showLoading: boolean) => {
      const thisReqId = ++reqIdRef.current;
      if (showLoading) setLoading(true);
      try {
        const [listRes, quotaRes] = await Promise.all([listAllOfflineFiles(page), getOfflineQuotaInfo()]);
        const mapped: Row[] = listRes.offlineFiles.map((f) => ({
          key: f.infoHash || f.url,
          name: f.name,
          sizeMB: Number(f.size || 0) / (1024 * 1024),
          url: f.url,
          status: f.status,
          percendDonePct: f.percendDone,
          infoHash: f.infoHash,
          addTime: (() => {
            const v = Number(f.addTime || 0);
            if (!v) return undefined;
            return v > 1e12 ? v : v * 1000;
          })(),
        }));
        let finalRows = mapped;

        // 置顶排序：匹配 pinnedHashes 的行排在最前面（必要时跨页补齐）
        const pinned = pinnedHashesRef.current;
        if (pinned.size > 0) {
          const top: Row[] = [];
          const rest: Row[] = [];
          const matchedHashes = new Set<string>();

          for (const r of mapped) {
            const hash = getRowHash(r);
            if (hash && pinned.has(hash)) {
              matchedHashes.add(hash);
              top.push(r);
            } else {
              rest.push(r);
            }
          }

          let extraPinned: Row[] = [];
          if (matchedHashes.size < pinned.size) {
            const missingHashes = new Set<string>();
            for (const h of pinned) {
              if (!matchedHashes.has(h)) missingHashes.add(h);
            }
            extraPinned = await findPinnedRows(missingHashes, listRes.pageCount, page);
          }

          if (thisReqId !== reqIdRef.current) return;

          const merged: Row[] = [];
          const seenHashes = new Set<string>();
          const pushDedup = (r: Row) => {
            const hash = getRowHash(r);
            if (hash && seenHashes.has(hash)) return;
            if (hash) seenHashes.add(hash);
            merged.push(r);
          };

          for (const r of top) pushDedup(r);
          for (const r of extraPinned) pushDedup(r);
          for (const r of rest) pushDedup(r);
          finalRows = merged.slice(0, PAGE_SIZE);
        }

        const tasksToCheck = finalRows.filter((r) => {
          const hash = getRowHash(r);
          return r.status === OfflineFileStatus.OFFLINE_FINISHED && (showLoading || !!(hash && pinned.has(hash)));
        });
        if (tasksToCheck.length > 0) {
          const missing = new Set<string>();
          const present = new Set<string>();
          const cfg = getConfig();
          const parentPath = cfg.offlineDestPath || "/";
          await Promise.all(
            tasksToCheck.map(async (r) => {
              try {
                const f = await findFileByPath(parentPath, r.name);
                if (!f)
                  missing.add(r.key); // file is missing
                else present.add(r.key); // file is present
              } catch {
                missing.add(r.key);
              }
            }),
          );
          if (thisReqId !== reqIdRef.current) return;
          setMissingTasks((prev) => {
            const next = new Set(prev);
            for (const k of missing) next.add(k);
            for (const k of present) next.delete(k);
            return next;
          });
        }

        if (thisReqId === reqIdRef.current) {
          setRows(finalRows);
          setTotal(listRes.totalCount);
          setQuota(quotaRes);
        }
      } catch (err) {
        if (showLoading) message.error((err as Error)?.message || "加载失败");
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [message, page],
  );

  /** 手动刷新（带 loading 动画，清除置顶） */
  const fetchAll = useCallback(() => {
    pinnedHashesRef.current = new Set();
    return doFetchAll(true);
  }, [doFetchAll]);
  /** 静默刷新（无 loading 动画，用于事件驱动） */
  const fetchAllSilent = useCallback(() => doFetchAll(false), [doFetchAll]);

  // 初始加载
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // 监听事件驱动刷新：任务提交 / 任务删除 → 静默刷新
  useEffect(() => {
    const onSubmitted = (e: Event) => {
      const urlsStr = (e as CustomEvent)?.detail?.urls as string | undefined;
      if (urlsStr) {
        const hashes = extractPinnedHashes(urlsStr);
        if (hashes.size > 0) pinnedHashesRef.current = hashes;
      }
      fetchAllSilent();
    };
    const onDeleted = () => fetchAllSilent();
    window.addEventListener("cd2-task-submitted", onSubmitted);
    window.addEventListener("cd2-task-deleted", onDeleted);
    return () => {
      window.removeEventListener("cd2-task-submitted", onSubmitted);
      window.removeEventListener("cd2-task-deleted", onDeleted);
    };
  }, [fetchAllSilent]);

  // 监听 artplayer 的 URL 解析请求（用于分集切换）


  // 是否有活跃（未完成）的离线任务
  const hasActiveTask = useMemo(
    () =>
      rows.some(
        (r) => r.status === OfflineFileStatus.OFFLINE_INIT || r.status === OfflineFileStatus.OFFLINE_DOWNLOADING,
      ),
    [rows],
  );

  // 自适应轮询：存在活跃任务 + 页面可见时自动静默刷新
  useEffect(() => {
    if (!hasActiveTask) return;

    const POLL_MIN = 2_000;
    const POLL_MAX = 15_000;
    const POLL_STEP = 1_000;
    let delay = POLL_MIN;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      if (document.hidden) return; // 页面不可见时暂停
      timerId = setTimeout(async () => {
        if (stopped) return;
        await fetchAllSilent();
        delay = Math.min(delay + POLL_STEP, POLL_MAX);
        schedule();
      }, delay);
    };

    // 页面重新可见时恢复轮询
    const onVisChange = () => {
      if (!document.hidden && !stopped) {
        delay = POLL_MIN; // 重新可见时重置间隔
        if (!timerId) schedule();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);

    schedule();

    return () => {
      stopped = true;
      if (timerId) clearTimeout(timerId);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [hasActiveTask, fetchAllSilent]);

  // PushMessage 事件驱动（可选增强）：如果原生 fetch 能连通 CD2 服务端，会额外提供实时推送
  useEffect(() => {
    const ac = new AbortController();
    subscribePushMessage(() => fetchAllSilent(), ac.signal);
    return () => ac.abort();
  }, [fetchAllSilent]);

  // 同步记忆"删除文件"选项
  const toggleDeleteFiles = useCallback((checked: boolean) => {
    setShouldDeleteFiles(checked);
    setDeleteFiles(checked);
  }, []);

  const formatBytes = useCallback((bytesInMB: number): string => {
    const bytes = bytesInMB * 1024 * 1024;
    if (!bytes || bytes <= 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    return `${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)} ${units[idx]}`;
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
        setSelected((prev) => prev.filter((k) => !keys.includes(k as string)));
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

          window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: row.url } }));
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

  const removeSelected = useCallback(() => {
    if (selected.length === 0) return;
    modal.confirm({
      title: `删除/取消 ${selected.length} 个任务？`,
      content: (
        <Checkbox defaultChecked={shouldDeleteFiles} onChange={(e) => toggleDeleteFiles(e.target.checked)}>
          同时删除已下载文件
        </Checkbox>
      ),
      okText: "确认",
      cancelText: "关闭",
      onOk: () => doRemove(selected as string[], shouldDeleteFiles),
    });
  }, [doRemove, modal, selected, shouldDeleteFiles, toggleDeleteFiles]);

  const locateFile = useCallback(
    async (row: Row) => {
      try {
        const cfg = getConfig();
        const parentPath = cfg.offlineDestPath || "/";
        const file = await findFileByPath(parentPath, row.name);
        if (!file) {
          message.warning("未找到文件，可能位于子目录或已被移动");
          return;
        }
        const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
        const webUrl = `${baseUrl}/?page=files&path=${encodeURIComponent(file.fullPathName)}`;
        window.open(webUrl, "_blank");
      } catch (e) {
        message.error(`定位失败：${(e as Error).message}`);
      }
    },
    [message],
  );

  /** 公共：解析目标文件（含文件夹穿透，支持蓝光目录BFS广搜） */
  const resolveTargetFile = useCallback(async (row: Row) => {
    const cfg = getConfig();
    const parentPath = cfg.offlineDestPath || "/";
    const rootFile = await findFileByPath(parentPath, row.name);
    if (!rootFile) return undefined;
    if (!rootFile.isDirectory) return rootFile;

    const mediaExts = [".mp4", ".mkv", ".avi", ".rmvb", ".mov", ".flv", ".ts", ".m2ts", ".iso"];
    const isMedia = (f: { name: string; isDirectory?: boolean }) =>
      !f.isDirectory && mediaExts.some((ext) => f.name.toLowerCase().endsWith(ext));

    let largestMediaFile: typeof rootFile | undefined;
    let maxMediaSize = -1;
    const allMedia: (typeof rootFile)[] = [];
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
            allMedia.push(f);
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
      allMedia.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      const mem = playlistMemory.get(row.name);
      if (mem && mem.filePath) {
        const memObj = allMedia.find((f) => f.fullPathName === mem.filePath);
        if (memObj) return memObj;
      }
      return allMedia[0];
    }
  }, []);

  /** 扫描文件夹内所有媒体文件，返回播放列表 */
  const resolvePlaylist = useCallback(async (row: Row): Promise<{ fileName: string; filePath: string }[]> => {
    const cfg = getConfig();
    const parentPath = cfg.offlineDestPath || "/";
    const rootFile = await findFileByPath(parentPath, row.name);
    if (!rootFile?.isDirectory) return [];

    const mediaExts = [".mp4", ".mkv", ".avi", ".rmvb", ".mov", ".flv", ".ts", ".m2ts"];
    const isMedia = (f: { name: string; isDirectory?: boolean }) =>
      !f.isDirectory && mediaExts.some((ext) => f.name.toLowerCase().endsWith(ext));

    const allMedia: { fileName: string; filePath: string }[] = [];
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
          if (isMedia(f)) allMedia.push({ fileName: f.name, filePath: f.fullPathName });
        }
        if (depth < MAX_DEPTH) {
          const subDirs = subFiles.filter((f) => f.isDirectory);
          for (const d of subDirs) queue.push({ path: d.fullPathName, depth: depth + 1 });
        }
      } catch (e) {
        console.warn(`[cd2] resolvePlaylist scan failed for ${path}`, e);
      }
    }

    return allMedia.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' }));
  }, []);

  /** 扫描视频文件所在目录的字幕文件 */
  const resolveSubtitles = useCallback(async (videoFilePath: string): Promise<{ fileName: string; filePath: string }[]> => {
    const subtitleExts = [".srt", ".ass", ".ssa", ".vtt"];
    const isSubtitle = (f: { name: string; isDirectory?: boolean }) =>
      !f.isDirectory && subtitleExts.some((ext) => f.name.toLowerCase().endsWith(ext));

    // 获取视频文件所在目录路径
    const lastSlash = Math.max(videoFilePath.lastIndexOf("/"), videoFilePath.lastIndexOf("\\"));
    if (lastSlash < 0) return [];
    const parentDir = videoFilePath.substring(0, lastSlash);

    try {
      const files = await listSubFiles(parentDir);
      return files
        .filter(isSubtitle)
        .map((f) => ({ fileName: f.name, filePath: f.fullPathName }))
        .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' }));
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
          })
        );
      } catch (err) {
        realWindow.dispatchEvent(
          new CustomEvent("cd2-video-url-resolved", {
            detail: { requestId: detail.requestId, error: (err as Error).message },
          })
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
        // 为每个字幕文件获取 URL
        const subsWithUrl = await Promise.all(
          subs.map(async (s) => {
            try {
              const urlInfo = await getDownloadUrlPath(s.filePath, true);
              return { fileName: s.fileName, filePath: s.filePath, url: buildVideoUrl(urlInfo) };
            } catch {
              return null;
            }
          })
        );
        realWindow2.dispatchEvent(
          new CustomEvent("cd2-subtitles-resolved", {
            detail: { requestId: detail.requestId, subtitles: subsWithUrl.filter(Boolean) },
          })
        );
      } catch (err) {
        realWindow2.dispatchEvent(
          new CustomEvent("cd2-subtitles-resolved", {
            detail: { requestId: detail.requestId, subtitles: [], error: (err as Error).message },
          })
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
  }, [buildVideoUrl, resolveSubtitles]);

  /** 播放：支持网页端和本地外部播放器串流 */
  const playFile = useCallback(
    async (row: Row, playerType: PlayerType = "web") => {
      const hide = message.loading(`正在获取${playerType === "web" ? "播放" : "串流"}地址...`, 0);
      try {
        const file = await resolveTargetFile(row);
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

        // ArtPlayer 播放（内嵌弹幕播放器）
        if (playerType === "artplayer" || playerType === "web") {
          const realWindow = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as Window & {
            __cd2ArtplayerReady?: boolean;
          };

          if (realWindow.__cd2ArtplayerReady) {
            // 扫描文件夹构建播放列表和字幕列表
            const [playlist, subtitles] = await Promise.all([
              resolvePlaylist(row),
              resolveSubtitles(file.fullPathName),
            ]);
            const currentIndex = playlist.findIndex((p) => p.filePath === file.fullPathName);

            // 为字幕文件获取 URL
            const subsWithUrl = await Promise.all(
              subtitles.map(async (s) => {
                try {
                  const urlInfo = await getDownloadUrlPath(s.filePath, true);
                  return { fileName: s.fileName, filePath: s.filePath, url: buildVideoUrl(urlInfo) };
                } catch {
                  return null;
                }
              })
            );

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
                },
              }),
            );
            return;
          }

          if (playerType === "artplayer") {
            message.warning("ArtPlayer 油猴脚本未安装，请先安装 clouddrive2-artplayer 脚本。");
            return;
          }

          // web 模式回退：artplayer 未安装时直接打开
          window.open(videoUrl, "_blank");
          return;
        }

        // 外部播放器调用逻辑
        {
          let externalUrl = "";
          const encodedUrl = encodeURIComponent(videoUrl);
          switch (playerType) {
            case "potplayer":
              externalUrl = `potplayer://${videoUrl}`;
              break;
            case "vlc":
              externalUrl = `vlc://${videoUrl}`;
              break;
            case "iina":
              externalUrl = `iina://weblink?url=${encodedUrl}`;
              break;
            case "infuse":
              externalUrl = `infuse://x-callback-url/play?url=${encodedUrl}`;
              break;
            case "dandanplay":
              externalUrl = `ddplay:${encodeURIComponent(`${videoUrl}|filePath=${file.name}`)}`;
              break;
          }
          const a = document.createElement("a");
          a.setAttribute("href", externalUrl);
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => document.body.removeChild(a), 500);
        }
      } catch (e) {
        message.error(`播放失败：${(e as Error).message}`);
      } finally {
        hide();
      }
    },
    [message, resolveTargetFile, buildVideoUrl, resolvePlaylist],
  );

  /** 下载：preview=false，走附件下载模式 */
  const downloadFile = useCallback(
    async (row: Row) => {
      const hide = message.loading("正在获取下载地址...", 0);
      try {
        const file = await resolveTargetFile(row);
        if (!file) {
          message.warning("未找到可下载的文件，请在 CloudDrive2 网页端查看。");
          return;
        }
        const cfg = getConfig();
        const urlInfo = await getDownloadUrlPath(file.fullPathName, false);

        let downloadUrl = "";
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

          if (p.startsWith("http://") || p.startsWith("https://")) {
            downloadUrl = p;
          } else {
            const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
            p = p.startsWith("/") ? p : `/${p}`;
            downloadUrl = `${baseUrl}${p}`;
          }
        } else if (urlInfo.directUrl) {
          downloadUrl = urlInfo.directUrl;
        }

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
    [message, resolveTargetFile],
  );

  const columns: ColumnsType<Row> = useMemo(
    () => [
      {
        title: "名称",
        dataIndex: "name",
        key: "name",
        ellipsis: { showTitle: false },
        render: (name: string) => (
          <Tooltip title={name} placement="topLeft">
            <span>{name}</span>
          </Tooltip>
        ),
      },
      {
        title: "状态",
        key: "info",
        width: 120,
        render: (_: unknown, r: Row) => {
          const isMissing = missingTasks.has(r.key);
          const st = statusText(r.status);
          return (
            <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
              {isMissing ? (
                <Tag color="error" style={{ margin: 0 }}>
                  文件已转移/删除
                </Tag>
              ) : (
                <Tag color={st.color} style={{ margin: 0 }}>
                  {st.text} {r.percendDonePct}%
                </Tag>
              )}
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {formatBytes(r.sizeMB)}
              </Typography.Text>
            </Space>
          );
        },
      },
      {
        title: "操作",
        key: "actions",
        width: 210,
        render: (_: unknown, r: Row) => {
          const isMissing = missingTasks.has(r.key);
          return (
            <Space size={2}>
              {r.status === OfflineFileStatus.OFFLINE_FINISHED &&
                (isMissing ? (
                  <Tooltip title="重新下载此任务">
                    <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => reDownload(r)} />
                  </Tooltip>
                ) : (
                  <>
                    <Tooltip title="定位">
                      <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => locateFile(r)} />
                    </Tooltip>

                    <Dropdown
                      key={defaultPlayer}
                      trigger={["contextMenu"]}
                      menu={{
                        items: Object.entries(PLAYER_CONFIG).map(([key, item]) => ({
                          key,
                          label: item.label,
                          icon: item.iconUrl ? (
                            <img src={item.iconUrl} alt={key} style={{ width: 16, height: 16 }} />
                          ) : (
                            <span>{item.fallbackText}</span>
                          ),
                        })),
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation();
                          setDefaultPlayer(key as PlayerType);
                          localStorage.setItem("cd2_default_player", key);
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
                        icon={
                          PLAYER_CONFIG[defaultPlayer].iconUrl ? (
                            <img
                              src={PLAYER_CONFIG[defaultPlayer].iconUrl}
                              alt="player"
                              style={{ width: 16, height: 16, objectFit: "contain" }}
                            />
                          ) : (
                            <span>{PLAYER_CONFIG[defaultPlayer].fallbackText}</span>
                          )
                        }
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
      formatBytes,
      removeOne,
      statusText,
      locateFile,
      playFile,
      downloadFile,
      defaultPlayer,
      missingTasks,
      reDownload,
    ],
  );

  const rowSelection = {
    selectedRowKeys: selected,
    onChange: (keys: React.Key[]) => setSelected(keys),
  };

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={4}>
      <Flex align="center" justify="space-between" gap={8}>
        <Space size={4}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchAll()} loading={loading}>
            刷新
          </Button>
          {selected.length > 0 && (
            <Button size="small" danger onClick={removeSelected}>
              删除所选({selected.length})
            </Button>
          )}
        </Space>
        {quota ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            配额：{quota.left}/{quota.total}
          </Typography.Text>
        ) : null}
      </Flex>

      <Table<Row>
        size="small"
        key={`table_${defaultPlayer}`}
        rowKey={(r) => r.key}
        rowClassName={(r) => {
          const hash = getRowHash(r);
          return hash && pinnedHashesRef.current.has(hash) ? "cd2-row-highlight" : "";
        }}
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowSelection={rowSelection}
        scroll={{ y: 275 }}
        pagination={{
          current: page,
          total,
          pageSize: PAGE_SIZE,
          size: "small",
          showSizeChanger: false,
          onChange: (p) => setPage(p),
        }}
      />
    </Space>
  );
}
