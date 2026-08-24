import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { type Client, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { GM_getValue, GM_setValue } from "vite-plugin-monkey/dist/client";
import { type AppConfig, getConfig } from "@/config";
import {
  AddOfflineFileRequestSchema,
  type CloudAPI,
  type CloudDriveFile,
  CloudDriveFileSrv,
  CloudDrivePushMessage_MessageType,
  type DownloadUrlPathInfo,
  type FileOperationResult,
  FileRequestSchema,
  FindFileByPathRequestSchema,
  GetDownloadUrlPathRequestSchema,
  ListSubFileRequestSchema,
  type MountPoint,
  MultiFileRequestSchema,
  OfflineFileListAllRequestSchema,
  type OfflineFileListAllResult,
  type OfflineQuotaInfo,
  OfflineQuotaRequestSchema,
  RemoveOfflineFilesRequestSchema,
} from "@/proto/clouddrive_pb";
import { assertFileOperationSuccess } from "./fileOperation";
import gmFetch from "./gmFetch";

type CloudContext = {
  cloudName: string;
  cloudAccountId: string;
  path?: string;
};
type StoredCloudContext = CloudContext & { scope: string };
const CLOUD_CONTEXT_CACHE_KEY = "cd2_cloud_context_v1";
const SUBFILE_CACHE_TTL = 2_000;
const SUBFILE_CACHE_MAX = 256;
type CloudDriveClient = Client<typeof CloudDriveFileSrv>;
type SubFileCacheEntry = {
  files: CloudDriveFile[];
  expiresAt: number;
};
type SubFileRequest = {
  forceRefresh: boolean;
  generation: number;
  promise: Promise<CloudDriveFile[]>;
};
let cloudContextCache: StoredCloudContext | undefined;
let cloudContextRequest: { scope: string; promise: Promise<CloudContext> } | undefined;
let cloudDriveClientCache: { scope: string; client: CloudDriveClient } | undefined;
let subFileCacheGeneration = 0;
const subFileCache = new Map<string, SubFileCacheEntry>();
const subFileRequests = new Map<string, SubFileRequest>();

function clearSubFileCache(): void {
  subFileCacheGeneration++;
  subFileCache.clear();
  subFileRequests.clear();
}

function getCloudContextScope(path: string): string {
  const cfg = getConfig();
  return `${cfg.grpcBaseUrl}\n${cfg.apiToken}\n${path}`;
}

function getCloudDriveClient(configOverride?: AppConfig): CloudDriveClient {
  const cfg = configOverride ?? getConfig();
  const scope = `${cfg.grpcBaseUrl}\n${cfg.apiToken}`;
  if (cloudDriveClientCache?.scope === scope) return cloudDriveClientCache.client;

  const authInterceptor: Interceptor = (next) => async (req) => {
    const token = cfg.apiToken;
    if (token) {
      req.header.set("Authorization", token.startsWith("Bearer ") ? token : `Bearer ${token}`);
    }
    return await next(req);
  };

  const transport = createGrpcWebTransport({
    baseUrl: cfg.grpcBaseUrl,
    interceptors: [authInterceptor],
    // Use GM-based fetch to bypass page CSP when available
    fetch: (input, init) => gmFetch(input, init),
  });

  const client = createClient(CloudDriveFileSrv, transport);
  cloudDriveClientCache = { scope, client };
  return client;
}

/** 提交离线下载任务
 * @param urls 支持多个 URL, 用换行符分隔
 * @param destPath 目标路径
 */
export async function addOffline(
  urls: string,
  destPath: string,
  configOverride?: AppConfig,
): Promise<FileOperationResult> {
  const cfg = configOverride ?? getConfig();
  const toFolder = destPath && destPath.length > 0 ? destPath : cfg.offlineDestPath;

  const req = create(AddOfflineFileRequestSchema, {
    urls: urls,
    toFolder,
  });

  const client = getCloudDriveClient(cfg);
  const res = await client.addOfflineFiles(req);
  const result = assertFileOperationSuccess(res, "CloudDrive2 添加离线任务失败");
  clearSubFileCache();
  return result;
}

export type SubmitOfflineResult = {
  ok: boolean;
  alreadyExists?: boolean;
  errorMessage?: string;
  error?: unknown;
};

export async function submitOffline(
  urls: string,
  destPath: string,
  configOverride?: AppConfig,
): Promise<SubmitOfflineResult> {
  try {
    await addOffline(urls, destPath, configOverride);
    return { ok: true };
  } catch (err) {
    const errMsg = (err as Error)?.message || "";
    if (errMsg.includes("任务已存在")) {
      return {
        ok: false,
        alreadyExists: true,
        errorMessage: errMsg,
        error: err,
      };
    }
    return { ok: false, errorMessage: errMsg, error: err };
  }
}

/**
 * Resolve CloudAPI info for a folder.
 */
export async function getFolderCloudAPI(p: string): Promise<CloudAPI | undefined> {
  const client = getCloudDriveClient();
  const req = create(FindFileByPathRequestSchema, { parentPath: p, path: "." });
  try {
    const file = await client.findFileByPath(req);
    return file.CloudAPI;
  } catch {
    return undefined;
  }
}

/**
 * Resolve cloudName/cloudAccountId from a configured path (default to cfg.offlineDestPath)
 */
async function resolveCloudContext(pathOverride?: string): Promise<CloudContext> {
  const cfg = getConfig();
  const folderPath = pathOverride ?? cfg.offlineDestPath;
  const scope = getCloudContextScope(folderPath);
  if (cloudContextCache?.scope === scope) return cloudContextCache;
  const stored = GM_getValue<StoredCloudContext | null>(CLOUD_CONTEXT_CACHE_KEY, null);
  if (stored?.scope === scope && stored.cloudName && stored.cloudAccountId) cloudContextCache = stored;
  if (cloudContextRequest?.scope === scope) return cloudContextRequest.promise;

  const promise = (async (): Promise<CloudContext> => {
    // Directory metadata can be temporarily unavailable while CloudDrive2 is
    // refreshing the destination. Retry once, then reuse the last successful
    // identity for the exact same server/token/path scope.
    for (let attempt = 0; attempt < 2; attempt++) {
      const api = await getFolderCloudAPI(folderPath);
      if (api?.name && api.userName) {
        const resolved: StoredCloudContext = {
          scope,
          cloudName: api.name,
          cloudAccountId: api.userName,
          path: folderPath,
        };
        cloudContextCache = resolved;
        GM_setValue(CLOUD_CONTEXT_CACHE_KEY, resolved);
        return resolved;
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (cloudContextCache?.scope === scope) return cloudContextCache;
    throw new Error("无法获取云盘信息，请检查 CloudDrive2 连接和“离线下载路径”设置");
  })();
  cloudContextRequest = { scope, promise };
  try {
    return await promise;
  } finally {
    if (cloudContextRequest?.promise === promise) cloudContextRequest = undefined;
  }
}

/** 列出全局离线任务（分页） */
export async function listAllOfflineFiles(page = 1, pathOverride?: string): Promise<OfflineFileListAllResult> {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(OfflineFileListAllRequestSchema, {
    cloudName,
    cloudAccountId,
    page,
    path,
  });
  return await client.listAllOfflineFiles(req);
}

/** 获取离线任务配额信息 */
export async function getOfflineQuotaInfo(pathOverride?: string): Promise<OfflineQuotaInfo> {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(OfflineQuotaRequestSchema, {
    cloudName,
    cloudAccountId,
    path,
  });
  return await client.getOfflineQuotaInfo(req);
}

/** 获取 CloudDrive2 服务端当前配置的挂载点。 */
export async function getMountPoints(): Promise<MountPoint[]> {
  const client = getCloudDriveClient();
  const result = await client.getMountPoints(create(EmptySchema, {}));
  return result.mountPoints;
}

/** 批量删除/取消离线任务 */
export async function removeOfflineFilesBulk(infoHashes: string[], deleteFiles: boolean, pathOverride?: string) {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(RemoveOfflineFilesRequestSchema, {
    cloudName,
    cloudAccountId,
    deleteFiles,
    infoHashes,
    path,
  });
  const result = await client.removeOfflineFiles(req);
  const checkedResult = assertFileOperationSuccess(result, "CloudDrive2 删除离线任务失败");
  clearSubFileCache();
  return checkedResult;
}

/** 通过 CloudDrive2 删除一个或多个云端文件/目录（进入对应云盘回收站）。 */
export async function deleteCloudFiles(paths: string[]): Promise<FileOperationResult> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) throw new Error("没有可删除的文件");
  const client = getCloudDriveClient();
  const result =
    uniquePaths.length === 1
      ? await client.deleteFile(create(FileRequestSchema, { path: uniquePaths[0] }))
      : await client.deleteFiles(create(MultiFileRequestSchema, { path: uniquePaths }));
  const checkedResult = assertFileOperationSuccess(result, "CloudDrive2 删除文件失败");
  clearSubFileCache();
  return checkedResult;
}

/**
 * 通过路径查找文件
 * @param parentPath 父目录路径（如 "/" 或配置文件中配置的路径）
 * @param path 目标文件或文件夹名
 */
export async function findFileByPath(parentPath: string, path: string): Promise<CloudDriveFile | undefined> {
  const client = getCloudDriveClient();
  const req = create(FindFileByPathRequestSchema, { parentPath, path });
  try {
    return await client.findFileByPath(req);
  } catch (_err) {
    return undefined;
  }
}

/**
 * 获取文件真实下载或播放地址信息
 * @param path 文件的完整路径
 * @param preview 是否为预览/播放模式（规避 attachment 下载触发）
 */
export async function getDownloadUrlPath(path: string, preview: boolean = false): Promise<DownloadUrlPathInfo> {
  const client = getCloudDriveClient();
  const req = create(GetDownloadUrlPathRequestSchema, {
    path,
    preview,
    lazyRead: false,
    getDirectUrl: true, // 仍然尝试获取直链配置，但 UI 优先走本地
  });
  return await client.getDownloadUrlPath(req);
}

/**
 * 获取文件夹下的所有子文件
 * @param path 文件夹路径
 * @param forceRefresh 是否强制刷新目录缓存
 */
export async function listSubFiles(
  path: string,
  forceRefresh: boolean = false,
  throwOnError: boolean = false,
): Promise<CloudDriveFile[]> {
  const cfg = getConfig();
  const cacheKey = `${cfg.grpcBaseUrl}\n${cfg.apiToken}\n${path}`;
  if (forceRefresh) {
    subFileCache.delete(cacheKey);
  } else {
    const cached = subFileCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        subFileCache.delete(cacheKey);
        subFileCache.set(cacheKey, cached);
        return cached.files.slice();
      }
      subFileCache.delete(cacheKey);
    }
  }

  let requestEntry = subFileRequests.get(cacheKey);
  if (!requestEntry || (forceRefresh && !requestEntry.forceRefresh)) {
    requestEntry = {
      forceRefresh,
      generation: subFileCacheGeneration,
      promise: (async () => {
        const client = getCloudDriveClient(cfg);
        const req = create(ListSubFileRequestSchema, { path, forceRefresh });
        const files: CloudDriveFile[] = [];
        for await (const res of client.getSubFiles(req)) {
          if (res.subFiles) files.push(...res.subFiles);
        }
        return files;
      })(),
    };
    subFileRequests.set(cacheKey, requestEntry);
  }
  const request = requestEntry.promise;

  try {
    const files = await request;
    const isCurrentRequest = subFileRequests.get(cacheKey)?.promise === request;
    if (isCurrentRequest) subFileRequests.delete(cacheKey);
    if (isCurrentRequest && requestEntry.generation === subFileCacheGeneration) {
      subFileCache.delete(cacheKey);
      subFileCache.set(cacheKey, { files, expiresAt: Date.now() + SUBFILE_CACHE_TTL });
    }
    while (subFileCache.size > SUBFILE_CACHE_MAX) {
      const oldestKey = subFileCache.keys().next().value;
      if (oldestKey === undefined) break;
      subFileCache.delete(oldestKey);
    }
    return files.slice();
  } catch (err) {
    if (subFileRequests.get(cacheKey)?.promise === request) subFileRequests.delete(cacheKey);
    console.error("ListSubFiles Error:", err);
    if (throwOnError) throw err;
    return [];
  }
}

function getStreamingClient(): Client<typeof CloudDriveFileSrv> {
  const cfg = getConfig();
  const authInterceptor: Interceptor = (next) => async (req) => {
    const token = cfg.apiToken;
    if (token) {
      req.header.set("Authorization", token.startsWith("Bearer ") ? token : `Bearer ${token}`);
    }
    return await next(req);
  };

  const transport = createGrpcWebTransport({
    baseUrl: cfg.grpcBaseUrl,
    interceptors: [authInterceptor],
    // Use native fetch for streaming to avoid GM_xmlhttpRequest streaming issues
    fetch: (input, init) => fetch(input, init),
  });

  return createClient(CloudDriveFileSrv, transport);
}

/**
 * 订阅 PushMessage 服务端流式推送。
 * 当收到 DOWNLOADER_COUNT 或 FILE_SYSTEM_CHANGE 事件时回调 onRefresh。
 */
export type TrackedTaskLocation = {
  taskKey: string;
  fileId: string;
  path: string;
  originalPath: string;
  status: "present" | "moved" | "deleted";
};

export function subscribePushMessage(
  onRefresh: () => void,
  signal: AbortSignal,
  onLocations?: (locations: Record<string, TrackedTaskLocation>) => void,
): void {
  const extensionRuntime = (
    globalThis as typeof globalThis & {
      chrome?: {
        runtime?: {
          id?: string;
          connect?: (connectInfo: { name: string }) => {
            disconnect: () => void;
            onMessage: {
              addListener: (
                listener: (message: {
                  type?: string;
                  location?: TrackedTaskLocation;
                  locations?: Record<string, TrackedTaskLocation>;
                }) => void,
              ) => void;
            };
          };
        };
      };
    }
  ).chrome?.runtime;
  if (extensionRuntime?.id && extensionRuntime.connect) {
    const port = extensionRuntime.connect({ name: "cd2-push-events" });
    port.onMessage.addListener((message) => {
      if (message?.type === "cd2-task-state-changed" && !signal.aborted) onRefresh();
      else if (message?.type === "cd2-task-locations" && message.locations) onLocations?.(message.locations);
      else if (message?.type === "cd2-task-location-changed" && message.location) {
        onLocations?.({ [message.location.taskKey]: message.location });
      }
    });
    signal.addEventListener("abort", () => port.disconnect(), { once: true });
    return;
  }
  const client = getStreamingClient();

  const connect = async () => {
    if (signal.aborted) return;
    try {
      for await (const msg of client.pushMessage(create(EmptySchema, {}), {
        signal,
      })) {
        if (
          msg.messageType === CloudDrivePushMessage_MessageType.DOWNLOADER_COUNT ||
          msg.messageType === CloudDrivePushMessage_MessageType.FILE_SYSTEM_CHANGE
        ) {
          onRefresh();
        }
      }
      // Stream ended normally, reconnect if not aborted
      if (!signal.aborted) {
        setTimeout(connect, 3000);
      }
    } catch (err) {
      // AbortError is normal when canceling
      if ((err as Error)?.name !== "AbortError" && !signal.aborted) {
        console.warn("[cd2] PushMessage stream error:", err);
        setTimeout(connect, 3000); // Reconnect on error
      }
    }
  };

  connect();
}

// End of file
