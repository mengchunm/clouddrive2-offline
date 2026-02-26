import { GM_getValue, GM_setValue } from "vite-plugin-monkey/dist/client";
export type AppConfig = {
  grpcBaseUrl: string;
  apiToken: string; // Bearer token or api token
  offlineDestPath: string; // default path for offline download
};

const KEY = "cd2_config_v1";
const SHOW_PANEL_KEY = "cd2_show_panel";

export function getConfig(): AppConfig {
  const v = (typeof GM_getValue !== "undefined" ? GM_getValue(KEY, null) : null) as AppConfig | null;
  if (v && typeof v === "object") return v;
  return {
    grpcBaseUrl: "http://localhost:8080",
    apiToken: "",
    offlineDestPath: "/",
  };
}

export function setConfig(cfg: AppConfig) {
  if (typeof GM_setValue !== "undefined") {
    GM_setValue(KEY, cfg);
    console.log("Config saved:", cfg);
  }
}

export function getShowPanel(): boolean {
  if (typeof GM_getValue !== "undefined") {
    return GM_getValue(SHOW_PANEL_KEY, true) as boolean;
  }
  return true;
}

export function setShowPanel(v: boolean) {
  if (typeof GM_setValue !== "undefined") {
    GM_setValue(SHOW_PANEL_KEY, v);
  }
}

const DELETE_FILES_KEY = "cd2_delete_files";

export function getDeleteFiles(): boolean {
  if (typeof GM_getValue !== "undefined") {
    return GM_getValue(DELETE_FILES_KEY, false) as boolean;
  }
  return false;
}

export function setDeleteFiles(v: boolean) {
  if (typeof GM_setValue !== "undefined") {
    GM_setValue(DELETE_FILES_KEY, v);
  }
}
