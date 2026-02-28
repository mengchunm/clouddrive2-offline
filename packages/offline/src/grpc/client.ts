import { create } from "@bufbuild/protobuf";
import { EmptySchema } from "@bufbuild/protobuf/wkt";
import { type Client, createClient, type Interceptor } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { getConfig } from "@/config";
import {
  AddOfflineFileRequestSchema,
  type CloudAPI,
  type CloudDriveFile,
  CloudDriveFileSrv,
  CloudDrivePushMessage_MessageType,
  type DownloadUrlPathInfo,
  type FileOperationResult,
  FindFileByPathRequestSchema,
  GetDownloadUrlPathRequestSchema,
  ListSubFileRequestSchema,
  OfflineFileListAllRequestSchema,
  type OfflineFileListAllResult,
  type OfflineQuotaInfo,
  OfflineQuotaRequestSchema,
  RemoveOfflineFilesRequestSchema,
} from "@/proto/clouddrive_pb";
import gmFetch from "./gmFetch";

function getCloudDriveClient(): Client<typeof CloudDriveFileSrv> {
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
    // Use GM-based fetch to bypass page CSP when available
    fetch: (input, init) => gmFetch(input, init),
  });

  return createClient(CloudDriveFileSrv, transport);
}

/** 提交离线下载任务
 * @param urls 支持多个 URL, 用换行符分隔
 * @param destPath 目标路径
 */
export async function addOffline(urls: string, destPath: string): Promise<FileOperationResult> {
  const cfg = getConfig();
  const toFolder = destPath && destPath.length > 0 ? destPath : cfg.offlineDestPath;

  const req = create(AddOfflineFileRequestSchema, {
    urls: urls,
    toFolder,
  });

  const client = getCloudDriveClient();
  const res = await client.addOfflineFiles(req);
  return res;
}

export type SubmitOfflineResult = {
  ok: boolean;
  alreadyExists?: boolean;
  errorMessage?: string;
  error?: unknown;
};

export async function submitOffline(urls: string, destPath: string): Promise<SubmitOfflineResult> {
  try {
    await addOffline(urls, destPath);
    return { ok: true };
  } catch (err) {
    const errMsg = (err as Error)?.message || "";
    if (errMsg.includes("任务已存在")) {
      return { ok: false, alreadyExists: true, errorMessage: errMsg, error: err };
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
async function resolveCloudContext(
  pathOverride?: string,
): Promise<{ cloudName: string; cloudAccountId: string; path?: string }> {
  const cfg = getConfig();
  const folderPath = pathOverride ?? cfg.offlineDestPath;
  const api = await getFolderCloudAPI(folderPath);
  if (!api) {
    throw new Error("无法获取云盘信息，请先在设置中正确配置“离线下载路径”");
  }
  return { cloudName: api.name, cloudAccountId: api.userName, path: folderPath };
}

/** 列出全局离线任务（分页） */
export async function listAllOfflineFiles(page = 1, pathOverride?: string): Promise<OfflineFileListAllResult> {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(OfflineFileListAllRequestSchema, { cloudName, cloudAccountId, page, path });
  return await client.listAllOfflineFiles(req);
}

/** 获取离线任务配额信息 */
export async function getOfflineQuotaInfo(pathOverride?: string): Promise<OfflineQuotaInfo> {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(OfflineQuotaRequestSchema, { cloudName, cloudAccountId, path });
  return await client.getOfflineQuotaInfo(req);
}

/** 批量删除/取消离线任务 */
export async function removeOfflineFilesBulk(infoHashes: string[], deleteFiles: boolean, pathOverride?: string) {
  const client = getCloudDriveClient();
  const { cloudName, cloudAccountId, path } = await resolveCloudContext(pathOverride);
  const req = create(RemoveOfflineFilesRequestSchema, { cloudName, cloudAccountId, deleteFiles, infoHashes, path });
  return await client.removeOfflineFiles(req);
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
export async function listSubFiles(path: string, forceRefresh: boolean = false): Promise<CloudDriveFile[]> {
  const client = getCloudDriveClient();
  const req = create(ListSubFileRequestSchema, { path, forceRefresh });
  const files: CloudDriveFile[] = [];
  try {
    for await (const res of client.getSubFiles(req)) {
      if (res.subFiles) {
        files.push(...res.subFiles);
      }
    }
  } catch (err) {
    console.error("ListSubFiles Error:", err);
  }
  return files;
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
export function subscribePushMessage(onRefresh: () => void, signal: AbortSignal): void {
  const client = getStreamingClient();

  const connect = async () => {
    if (signal.aborted) return;
    try {
      for await (const msg of client.pushMessage(create(EmptySchema, {}), { signal })) {
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
