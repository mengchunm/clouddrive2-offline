import { App as AntdApp, Button, Divider, Form, Input, Modal, Space, Switch, Typography } from "antd";
import { useEffect, useState } from "react";
import { getConfig, getShowDanmakuHeatmap, setConfig, setShowDanmakuHeatmap } from "@/config";
import { submitOffline } from "@/grpc/client";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  panelVisible: boolean;
  onTogglePanel: () => void;
}

export function SettingsModal({ open, onClose, panelVisible, onTogglePanel }: SettingsModalProps) {
  const { notification, message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [testingUrl, setTestingUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [draftPanelVisible, setDraftPanelVisible] = useState(panelVisible);
  const [draftDanmakuHeatmap, setDraftDanmakuHeatmap] = useState(getShowDanmakuHeatmap());

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue(getConfig());
    setDraftPanelVisible(panelVisible);
    setDraftDanmakuHeatmap(getShowDanmakuHeatmap());
  }, [form, open, panelVisible]);

  const onSave = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      setConfig(values);
      setShowDanmakuHeatmap(draftDanmakuHeatmap);
      if (draftPanelVisible !== panelVisible) onTogglePanel();
      notification.success({ message: "设置已保存", placement: "topLeft" });
      onClose();
    } catch (error) {
      if (!(error && typeof error === "object" && "errorFields" in error)) {
        message.error((error as Error)?.message || "保存失败");
      }
    } finally {
      setSaving(false);
    }
  };

  const onTestAdd = async () => {
    setTesting(true);
    try {
      const values = await form.validateFields();
      const res = await submitOffline(testingUrl, values.offlineDestPath, values);
      if (res.ok) {
        message.success("已提交离线下载任务");
      } else {
        console.error(res.error ?? res.errorMessage);
        message.error(res.errorMessage || "提交失败");
      }
    } catch (err) {
      console.error(err);
      if (!(err && typeof err === "object" && "errorFields" in err)) {
        message.error((err as Error)?.message || "提交失败");
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      title="CloudDrive2 设置"
      centered
      open={open}
      onCancel={onClose}
      footer={null}
      getContainer={false}
      width={480}
      bodyStyle={{ padding: 16 }}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Form form={form} layout="vertical">
          <Form.Item
            name="grpcBaseUrl"
            label="服务地址"
            extra="CloudDrive2 的 gRPC-Web 服务地址"
            rules={[
              { required: true, message: "请输入服务地址" },
              { type: "url", message: "请输入完整 URL" },
            ]}
          >
            <Input placeholder="http://localhost:19798" />
          </Form.Item>
          <Form.Item name="apiToken" label="API Token" extra="仅保存在当前脚本的安全存储中">
            <Input.Password autoComplete="off" placeholder="Bearer token 或 API token" />
          </Form.Item>
          <Form.Item
            name="offlineDestPath"
            label="离线下载路径"
            rules={[{ required: true, message: "请输入离线下载路径" }]}
          >
            <Input placeholder="/" />
          </Form.Item>
          <Form.Item label="显示悬浮面板" extra="检测到磁力链接时显示 CloudDrive2 入口">
            <Switch aria-label="显示悬浮面板" checked={draftPanelVisible} onChange={setDraftPanelVisible} />
          </Form.Item>
          <Form.Item label="显示弹幕热力图" extra="在播放器进度条上显示弹幕密度">
            <Switch aria-label="显示弹幕热力图" checked={draftDanmakuHeatmap} onChange={setDraftDanmakuHeatmap} />
          </Form.Item>
        </Form>

        <Divider style={{ margin: "12px 0" }} />

        <Typography.Title level={5} style={{ margin: 0 }}>
          提交测试任务
        </Typography.Title>
        <Typography.Text type="secondary">此操作会创建真实离线任务，不是无副作用的连接检测。</Typography.Text>
        <Input
          aria-label="测试任务链接"
          placeholder="粘贴磁力链接或直链 URL"
          value={testingUrl}
          onChange={(e) => setTestingUrl(e.target.value)}
        />
        <Button onClick={onTestAdd} loading={testing} disabled={!testingUrl.trim()}>
          提交测试任务
        </Button>

        <Divider style={{ margin: "12px 0 4px" }} />
        <Space style={{ width: "100%", justifyContent: "flex-end" }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={onSave} loading={saving}>
            保存
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
