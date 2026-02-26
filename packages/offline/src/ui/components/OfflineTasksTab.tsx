import { CopyOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, FolderOpenOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Checkbox, Flex, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getConfig, getDeleteFiles, setDeleteFiles } from "@/config";
import { getOfflineQuotaInfo, listAllOfflineFiles, removeOfflineFilesBulk, findFileByPath, getDownloadUrlPath, listSubFiles, subscribePushMessage } from "@/grpc/client";
import { OfflineFileStatus } from "@/proto/clouddrive_pb";

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

export function OfflineTasksTab() {
  const { message, modal } = AntdApp.useApp();
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [quota, setQuota] = useState<{ total: number; used: number; left: number } | null>(null);
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [shouldDeleteFiles, setShouldDeleteFiles] = useState(() => getDeleteFiles());
  const reqIdRef = useRef(0);
  /** 最近提交的 btih hash 集合，用于置顶匹配 */
  const pinnedHashesRef = useRef<Set<string>>(new Set());

  // 核心拉取逻辑：showLoading 控制是否显示 loading 动画
  const doFetchAll = useCallback(async (showLoading: boolean) => {
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
      if (thisReqId === reqIdRef.current) {
        // 置顶排序：匹配 pinnedHashes 的行排在最前面
        const pinned = pinnedHashesRef.current;
        if (pinned.size > 0) {
          const top: Row[] = [];
          const rest: Row[] = [];
          for (const r of mapped) {
            if (r.infoHash && pinned.has(r.infoHash.toLowerCase())) {
              top.push(r);
            } else {
              rest.push(r);
            }
          }
          setRows([...top, ...rest]);
        } else {
          setRows(mapped);
        }
        setTotal(listRes.totalCount);
        setQuota(quotaRes);
      }
    } catch (err) {
      if (showLoading) message.error((err as Error)?.message || "加载失败");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [message, page]);

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
    const BTIH_RE = /urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/gi;
    const onSubmitted = (e: Event) => {
      const urlsStr = (e as CustomEvent)?.detail?.urls as string | undefined;
      if (urlsStr) {
        const hashes = new Set<string>();
        for (const m of urlsStr.matchAll(BTIH_RE)) {
          hashes.add(m[1].toLowerCase());
        }
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

  // 是否有活跃（未完成）的离线任务
  const hasActiveTask = useMemo(
    () => rows.some((r) => r.status === OfflineFileStatus.OFFLINE_INIT || r.status === OfflineFileStatus.OFFLINE_DOWNLOADING),
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

  const removeOne = useCallback(
    (row: Row) => {
      modal.confirm({
        title: "删除/取消任务？",
        content: (
          <Checkbox
            defaultChecked={shouldDeleteFiles}
            onChange={(e) => toggleDeleteFiles(e.target.checked)}
          >
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
        <Checkbox
          defaultChecked={shouldDeleteFiles}
          onChange={(e) => toggleDeleteFiles(e.target.checked)}
        >
          同时删除已下载文件
        </Checkbox>
      ),
      okText: "确认",
      cancelText: "关闭",
      onOk: () => doRemove(selected as string[], shouldDeleteFiles),
    });
  }, [doRemove, modal, selected, shouldDeleteFiles, toggleDeleteFiles]);

  const locateFile = useCallback(async (row: Row) => {
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
  }, [message]);

  /** 公共：解析目标文件（含文件夹穿透） */
  const resolveTargetFile = useCallback(async (row: Row) => {
    const cfg = getConfig();
    const parentPath = cfg.offlineDestPath || "/";
    let file = await findFileByPath(parentPath, row.name);
    if (!file) return undefined;
    if (file.isDirectory) {
      const subFiles = await listSubFiles(file.fullPathName);
      const mediaExts = [".mp4", ".mkv", ".avi", ".rmvb", ".mov", ".flv", ".ts"];
      const mediaFiles = subFiles.filter(f => !f.isDirectory && mediaExts.some(ext => f.name.toLowerCase().endsWith(ext)));
      if (mediaFiles.length > 0) {
        file = mediaFiles.reduce((prev, cur) => (Number(prev.size || 0) > Number(cur.size || 0) ? prev : cur));
      } else {
        return undefined;
      }
    }
    return file;
  }, []);

  /** 播放：优先使用 artplayer 脚本（如已安装），否则新标签页打开 */
  const playFile = useCallback(async (row: Row) => {
    const hide = message.loading("正在获取播放地址...", 0);
    try {
      const file = await resolveTargetFile(row);
      if (!file) {
        message.warning("未找到可播放的媒体文件，请在 CloudDrive2 网页端查看。");
        return;
      }
      const cfg = getConfig();
      const urlInfo = await getDownloadUrlPath(file.fullPathName, true);

      let videoUrl = "";
      if (urlInfo.downloadUrlPath) {
        const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
        const p = urlInfo.downloadUrlPath.startsWith("/") ? urlInfo.downloadUrlPath : `/${urlInfo.downloadUrlPath}`;
        videoUrl = `${baseUrl}${p}`;
      } else if (urlInfo.directUrl) {
        videoUrl = urlInfo.directUrl;
      }

      if (!videoUrl) {
        message.error("获取播放地址失败");
        return;
      }

      // 使用 unsafeWindow 跨沙箱通信
      const realWindow = (typeof unsafeWindow !== "undefined" ? unsafeWindow : window) as any;

      if (realWindow.__cd2ArtplayerReady) {
        // artplayer 脚本已加载，通过事件播放
        realWindow.dispatchEvent(new CustomEvent("cd2-play-video", {
          detail: {
            fileName: file.name,
            filePath: file.fullPathName,
            videoUrl,
            grpcBaseUrl: cfg.grpcBaseUrl,
            apiToken: cfg.apiToken,
          },
        }));
      } else {
        // artplayer 未安装，回退到新标签页打开
        window.open(videoUrl, "_blank");
      }
    } catch (e) {
      message.error(`播放失败：${(e as Error).message}`);
    } finally {
      hide();
    }
  }, [message, resolveTargetFile]);

  /** 下载：preview=false，走附件下载模式 */
  const downloadFile = useCallback(async (row: Row) => {
    const hide = message.loading("正在获取下载地址...", 0);
    try {
      const file = await resolveTargetFile(row);
      if (!file) {
        message.warning("未找到可下载的文件，请在 CloudDrive2 网页端查看。");
        return;
      }
      const cfg = getConfig();
      const urlInfo = await getDownloadUrlPath(file.fullPathName, false);
      if (urlInfo.downloadUrlPath) {
        const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
        const p = urlInfo.downloadUrlPath.startsWith("/") ? urlInfo.downloadUrlPath : `/${urlInfo.downloadUrlPath}`;
        window.open(`${baseUrl}${p}`, "_blank");
      } else if (urlInfo.directUrl) {
        window.open(urlInfo.directUrl, "_blank");
      } else {
        message.error("获取下载地址失败");
      }
    } catch (e) {
      message.error(`下载失败：${(e as Error).message}`);
    } finally {
      hide();
    }
  }, [message, resolveTargetFile]);


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
          const st = statusText(r.status);
          return (
            <Space direction="vertical" size={0} style={{ lineHeight: 1.3 }}>
              <Tag color={st.color} style={{ margin: 0 }}>
                {st.text} {r.percendDonePct}%
              </Tag>
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
        width: 140,
        render: (_: unknown, r: Row) => (
          <Space size={2}>
            {r.status === OfflineFileStatus.OFFLINE_FINISHED && (
              <>
                <Tooltip title="定位">
                  <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => locateFile(r)} />
                </Tooltip>
                <Tooltip title="播放">
                  <Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={() => playFile(r)} />
                </Tooltip>
                <Tooltip title="下载">
                  <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => downloadFile(r)} />
                </Tooltip>
              </>
            )}
            <Tooltip title="复制链接">
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copyUrl(r.url)} />
            </Tooltip>
            <Tooltip title="删除/取消">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeOne(r)} />
            </Tooltip>
          </Space>
        ),
      },
    ],
    [copyUrl, formatBytes, removeOne, statusText, locateFile, playFile, downloadFile],
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
        rowKey={(r) => r.key}
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowSelection={rowSelection}
        scroll={{ y: 275 }}
        pagination={{
          current: page,
          total,
          pageSize: 30,
          size: "small",
          showSizeChanger: false,
          onChange: (p) => setPage(p),
        }}
      />
    </Space>
  );
}
