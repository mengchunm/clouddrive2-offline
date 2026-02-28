import { App as AntdApp, ConfigProvider, theme } from "antd";
import { useEffect, useState } from "react";
import { GM_registerMenuCommand } from "vite-plugin-monkey/dist/client";
import { getShowPanel, setShowPanel } from "@/config";
import { FloatingPanel } from "./FloatingPanel";
import { SettingsModal } from "./SettingsModal";
import "./styles.less";

export interface AppProps {
  hasMagnet: boolean;
}

export function App({ hasMagnet }: AppProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelVisible, setPanelVisible] = useState(() => getShowPanel());

  const togglePanel = () => {
    setPanelVisible((prev) => {
      const next = !prev;
      setShowPanel(next);
      return next;
    });
  };

  useEffect(() => {
    GM_registerMenuCommand("CloudDrive2 配置", () => setSettingsOpen(true));
  }, []);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          zIndexPopupBase: 1_000_000,
        },
      }}
    >
      <AntdApp>
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          panelVisible={panelVisible}
          onTogglePanel={togglePanel}
        />
        {hasMagnet && panelVisible && <FloatingPanel onOpenSettings={() => setSettingsOpen(true)} />}
      </AntdApp>
    </ConfigProvider>
  );
}
