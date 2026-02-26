import { App as AntdApp, Button, Card, Input, Space, Tabs, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { getConfig } from "@/config";
import { addOffline } from "@/grpc/client";
import { CD2_ICON_BASE64 } from "@/icon";
import { OfflineTasksTab } from "./components/OfflineTasksTab";

export function FloatingPanel() {
    const { message } = AntdApp.useApp();
    const [batchUrls, setBatchUrls] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [collapsed, setCollapsed] = useState(true); // 默认收起

    // 监听任务提交事件 → 自动展开面板
    useEffect(() => {
        const onTaskSubmitted = () => setCollapsed(false);
        window.addEventListener("cd2-task-submitted", onTaskSubmitted);
        return () => window.removeEventListener("cd2-task-submitted", onTaskSubmitted);
    }, []);

    const onBatchAdd = async () => {
        if (!batchUrls.trim()) {
            message.warning("请输入至少一个链接");
            return;
        }
        const cfg = getConfig();
        setSubmitting(true);
        try {
            await addOffline(batchUrls, cfg.offlineDestPath);
            message.success("已提交离线下载任务");
            window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: batchUrls } }));
            setBatchUrls("");
        } catch (err) {
            const errMsg = (err as Error)?.message || "";
            if (errMsg.includes("任务已存在")) {
                message.info("任务已存在，已置顶显示");
                window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: batchUrls } }));
                setBatchUrls("");
            } else {
                console.error(err);
                message.error(errMsg || "提交失败");
            }
        } finally {
            setSubmitting(false);
        }
    };

    const addOfflineNode = (
        <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text type="secondary">每行一个磁力链接或直链 URL</Typography.Text>
            <Input.TextArea
                rows={6}
                placeholder={"magnet:?xt=urn:btih:...\nhttps://example.com/file.zip\n..."}
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
            />
            <Button type="primary" onClick={onBatchAdd} loading={submitting} disabled={!batchUrls.trim()}>
                批量提交
            </Button>
        </Space>
    );

    const items = useMemo(
        () => [
            {
                key: "offline",
                label: "任务列表",
                children: <OfflineTasksTab />,
            },
            { key: "add-offline", label: "添加任务", children: addOfflineNode },
        ],
        [addOfflineNode],
    );

    // 收起状态：仅显示图标悬浮球
    if (collapsed) {
        return (
            <button
                type="button"
                className="cd2-floating-fab"
                onClick={() => setCollapsed(false)}
                title="展开 CloudDrive2 面板"
            >
                <img src={CD2_ICON_BASE64} width={28} height={28} alt="CD2" />
            </button>
        );
    }

    return (
        <div className="cd2-floating-panel">
            <Card
                size="small"
                title={
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <img src={CD2_ICON_BASE64} width={18} height={18} alt="" />
                        CloudDrive2
                    </span>
                }
                extra={
                    <Button size="small" type="text" onClick={() => setCollapsed(true)}>
                        收起
                    </Button>
                }
                bodyStyle={{ padding: 8 }}
                style={{ width: "100%" }}
            >
                <Tabs size="small" items={items} />
            </Card>
        </div>
    );
}
