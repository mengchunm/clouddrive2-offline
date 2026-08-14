import { App as AntdApp, Button, Divider, Form, Input, Modal, Space, Switch, Typography } from "antd";
import { useState } from "react";
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
  const [showDanmakuHeatmap, setShowDanmakuHeatmapState] = useState(getShowDanmakuHeatmap());
  const cfg = getConfig();

  const onSave = async () => {
    const values = await form.validateFields();
    setConfig(values);
    notification.success({ message: "设置已保存", placement: "topLeft" });
  };

  const onTestAdd = async () => {
    try {
      const v = form.getFieldsValue();
      setConfig(v);
      const res = await submitOffline(testingUrl, v.offlineDestPath);
      if (res.ok) {
        message.success("已提交离线下载任务");
      } else {
        console.error(res.error ?? res.errorMessage);
        message.error(res.errorMessage || "提交失败");
      }
    } catch (err) {
      console.error(err);
      message.error((err as Error)?.message || "提交失败");
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
        <Form form={form} layout="vertical" initialValues={cfg}>
          <Form.Item name="grpcBaseUrl" label="地址" rules={[{ required: true }]}>
            <Input placeholder="http://localhost:19798" />
          </Form.Item>
          <Form.Item name="apiToken" label="API Token">
            <Input.Password placeholder="Bearer token 或 API token" />
          </Form.Item>
          <Form.Item name="offlineDestPath" label="离线下载路径" rules={[{ required: true }]}>
            <Input placeholder="/" />
          </Form.Item>
          <Form.Item label="显示悬浮面板">
            <Switch checked={panelVisible} onChange={onTogglePanel} />
          </Form.Item>
          <Form.Item label="显示弹幕热力图（进度条上方）">
            <Switch
              checked={showDanmakuHeatmap}
              onChange={(checked) => {
                setShowDanmakuHeatmapState(checked);
                setShowDanmakuHeatmap(checked);
              }}
            />
          </Form.Item>
          <Space>
            <Button onClick={() => form.resetFields()}>重置</Button>
            <Button type="primary" onClick={onSave}>
              保存
            </Button>
          </Space>
        </Form>

        <Divider style={{ margin: "12px 0" }} />

        <Typography.Title level={5} style={{ margin: 0 }}>
          快速测试
        </Typography.Title>
        <Input
          placeholder="粘贴磁力链接或直链 URL"
          value={testingUrl}
          onChange={(e) => setTestingUrl(e.target.value)}
        />
        <Button type="primary" onClick={onTestAdd} disabled={!testingUrl}>
          添加到离线下载
        </Button>
      </Space>
    </Modal>
  );
}
