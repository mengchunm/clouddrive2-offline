import { App as AntdApp, ConfigProvider, theme } from "antd";
import { useCallback, useEffect, useState } from "react";
import { GM_registerMenuCommand } from "vite-plugin-monkey/dist/client";
import { getShowPanel, setShowPanel } from "@/config";
import { FloatingPanel } from "./FloatingPanel";
import { SettingsModal } from "./SettingsModal";
import "./styles.less";

declare const __CD2_EXTENSION_BUILD__: boolean;

export interface AppProps {
  hasMagnet: boolean;
}

async function openExtensionSettings(): Promise<boolean> {
  const isExtensionBuild = typeof __CD2_EXTENSION_BUILD__ !== "undefined" && __CD2_EXTENSION_BUILD__;
  if (!isExtensionBuild) return false;

  const runtime = (
    globalThis as typeof globalThis & {
      chrome?: {
        runtime?: {
          sendMessage?: (message: { type: string }) => Promise<{ ok?: boolean; error?: string }>;
        };
      };
    }
  ).chrome?.runtime;
  if (!runtime?.sendMessage) return false;
  try {
    const response = await runtime.sendMessage({ type: "cd2-open-options" });
    if (response?.ok) return true;
    console.warn("[cd2-extension] 后台未能打开扩展设置页", response?.error);
  } catch (error) {
    console.warn("[cd2-extension] 无法打开扩展设置页", error);
  }
  return false;
}

export function App({ hasMagnet }: AppProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panelVisible, setPanelVisible] = useState(() => getShowPanel());

  const openSettings = useCallback(async () => {
    // The extension options page is the canonical settings UI. The embedded
    // modal remains available to the standalone userscript build.
    if (!(await openExtensionSettings())) setSettingsOpen(true);
  }, []);

  const togglePanel = () => {
    setPanelVisible((prev) => {
      const next = !prev;
      setShowPanel(next);
      return next;
    });
  };

  useEffect(() => {
    GM_registerMenuCommand("CloudDrive2 配置", openSettings);
  }, [openSettings]);

  useEffect(() => {
    const syncPanelVisibility = () => setPanelVisible(getShowPanel());
    window.addEventListener("focus", syncPanelVisibility);
    document.addEventListener("visibilitychange", syncPanelVisibility);
    return () => {
      window.removeEventListener("focus", syncPanelVisibility);
      document.removeEventListener("visibilitychange", syncPanelVisibility);
    };
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
        {hasMagnet && panelVisible && <FloatingPanel onOpenSettings={openSettings} />}
      </AntdApp>
    </ConfigProvider>
  );
}
