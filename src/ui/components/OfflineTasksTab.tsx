import { CopyOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, FolderOpenOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { App as AntdApp, Button, Checkbox, Flex, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getConfig, getDeleteFiles, setDeleteFiles } from "@/config";
import { getOfflineQuotaInfo, listAllOfflineFiles, removeOfflineFilesBulk, findFileByPath, getDownloadUrlPath, listSubFiles } from "@/grpc/client";
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

  const fetchAll = useCallback(async () => {
    const thisReqId = ++reqIdRef.current;
    setLoading(true);
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
        setRows(mapped);
        setTotal(listRes.totalCount);
        setQuota(quotaRes);
      }
    } catch (err) {
      message.error((err as Error)?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [message, page]);

  // 初始加载
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // 监听事件驱动刷新：任务提交 / 任务删除
  useEffect(() => {
    const onRefresh = () => {
      setTimeout(fetchAll, 1000);
    };
    window.addEventListener("cd2-task-submitted", onRefresh);
    window.addEventListener("cd2-task-deleted", onRefresh);
    return () => {
      window.removeEventListener("cd2-task-submitted", onRefresh);
      window.removeEventListener("cd2-task-deleted", onRefresh);
    };
  }, [fetchAll]);

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

  /** 播放：preview=true，走流媒体模式 */
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
      if (urlInfo.downloadUrlPath) {
        const baseUrl = cfg.grpcBaseUrl.replace(/\/$/, "");
        const p = urlInfo.downloadUrlPath.startsWith("/") ? urlInfo.downloadUrlPath : `/${urlInfo.downloadUrlPath}`;
        window.open(`${baseUrl}${p}`, "_blank");
      } else if (urlInfo.directUrl) {
        window.open(urlInfo.directUrl, "_blank");
      } else {
        message.error("获取播放地址失败");
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
