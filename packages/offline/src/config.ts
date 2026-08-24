import { GM_getValue, GM_setValue } from "vite-plugin-monkey/dist/client";
import { type AppConfig, normalizeAppConfig } from "@/utils/configSchema";

export type { AppConfig } from "@/utils/configSchema";

export type FloatingPanelPosition = {
  left: number;
  bottom: number;
};

export type FloatingPanelPositions = {
  collapsed: FloatingPanelPosition;
  expanded: FloatingPanelPosition;
};

export type FloatingPanelSize = {
  width: number;
  height: number;
};

export type TaskListViewState = {
  page: number;
  scrollTop: number;
};

export type PreferredPlayer = "web" | "potplayer" | "dandanplay" | "infuse";

const KEY = "cd2_config_v1";
const SHOW_PANEL_KEY = "cd2_show_panel";
export const LOCAL_DIRECTORY_KEY = "cd2_local_directory_enabled";
export const SHOW_DANMAKU_HEATMAP_KEY = "cd2_show_danmaku_heatmap";
const LEGACY_FLOATING_PANEL_POSITION_KEY = "cd2_floating_panel_position_v1";
const FLOATING_PANEL_POSITIONS_KEY = "cd2_floating_panel_positions_v2";
const FLOATING_PANEL_SIZE_KEY = "cd2_floating_panel_size_v1";
const FLOATING_PANEL_EXPANDED_SESSION_KEY = "cd2_floating_panel_expanded_session_v1";
const TASK_LIST_VIEW_STATE_KEY = "cd2_task_list_view_state_v1";
const PREFERRED_PLAYER_KEY = "cd2_default_player";

let floatingPanelExpandedForDocument: boolean | undefined;

export function getConfig(): AppConfig {
  const stored = typeof GM_getValue !== "undefined" ? GM_getValue(KEY, null) : null;
  return normalizeAppConfig(stored);
}

export function setConfig(cfg: AppConfig): void {
  if (typeof GM_setValue !== "undefined") {
    GM_setValue(KEY, normalizeAppConfig(cfg));
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

function isFloatingPanelPosition(value: unknown): value is FloatingPanelPosition {
  if (!value || typeof value !== "object") return false;
  const position = value as Partial<FloatingPanelPosition>;
  return (
    Number.isFinite(position.left) &&
    Number.isFinite(position.bottom) &&
    (position.left ?? -1) >= 0 &&
    (position.bottom ?? -1) >= 0
  );
}

export function getFloatingPanelPositions(): FloatingPanelPositions {
  if (typeof GM_getValue !== "undefined") {
    const value = GM_getValue(FLOATING_PANEL_POSITIONS_KEY, null) as FloatingPanelPositions | null;
    if (value && isFloatingPanelPosition(value.collapsed) && isFloatingPanelPosition(value.expanded)) {
      return value;
    }
    const legacy = GM_getValue(LEGACY_FLOATING_PANEL_POSITION_KEY, null);
    if (isFloatingPanelPosition(legacy)) return { collapsed: legacy, expanded: legacy };
  }
  const defaultPosition = { left: 16, bottom: 16 };
  return { collapsed: defaultPosition, expanded: defaultPosition };
}

export function setFloatingPanelPositions(positions: FloatingPanelPositions): void {
  if (typeof GM_setValue !== "undefined") GM_setValue(FLOATING_PANEL_POSITIONS_KEY, positions);
}

export function getFloatingPanelSize(): FloatingPanelSize {
  if (typeof GM_getValue !== "undefined") {
    const value = GM_getValue(FLOATING_PANEL_SIZE_KEY, null) as FloatingPanelSize | null;
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height)) return value;
  }
  return { width: 640, height: 520 };
}

export function setFloatingPanelSize(size: FloatingPanelSize): void {
  if (typeof GM_setValue !== "undefined") GM_setValue(FLOATING_PANEL_SIZE_KEY, size);
}

export function getFloatingPanelExpanded(): boolean {
  if (floatingPanelExpandedForDocument !== undefined) return floatingPanelExpandedForDocument;

  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const restoreAfterReload = navigation?.type === "reload";
  let expanded = false;
  try {
    expanded = restoreAfterReload && sessionStorage.getItem(FLOATING_PANEL_EXPANDED_SESSION_KEY) === "1";
    // 普通导航和新标签页必须覆盖同源窗口可能复制过来的 sessionStorage。
    sessionStorage.setItem(FLOATING_PANEL_EXPANDED_SESSION_KEY, expanded ? "1" : "0");
  } catch {
    // 某些受限页面禁用 Web Storage，此时安全地回退到折叠状态。
  }
  floatingPanelExpandedForDocument = expanded;
  return expanded;
}

export function setFloatingPanelExpanded(expanded: boolean): void {
  floatingPanelExpandedForDocument = expanded;
  try {
    sessionStorage.setItem(FLOATING_PANEL_EXPANDED_SESSION_KEY, expanded ? "1" : "0");
  } catch {
    // 同上：存储不可用不影响当前文档中的展开和折叠。
  }
}

export function getTaskListViewState(): TaskListViewState {
  if (typeof GM_getValue !== "undefined") {
    const value = GM_getValue(TASK_LIST_VIEW_STATE_KEY, null) as TaskListViewState | null;
    if (
      value &&
      Number.isInteger(value.page) &&
      value.page > 0 &&
      Number.isFinite(value.scrollTop) &&
      value.scrollTop >= 0
    ) {
      return value;
    }
  }
  return { page: 1, scrollTop: 0 };
}

export function setTaskListViewState(state: TaskListViewState): void {
  if (typeof GM_setValue !== "undefined") GM_setValue(TASK_LIST_VIEW_STATE_KEY, state);
}

function isPreferredPlayer(value: unknown): value is PreferredPlayer {
  return value === "web" || value === "potplayer" || value === "dandanplay" || value === "infuse";
}

export function getPreferredPlayer(): PreferredPlayer {
  if (typeof GM_getValue !== "undefined") {
    const stored = GM_getValue<unknown>(PREFERRED_PLAYER_KEY, null);
    if (isPreferredPlayer(stored)) return stored;
  }

  // Migrate the former per-site preference once. Content-script localStorage is
  // scoped to the visited site, so all new writes use the shared GM storage.
  try {
    const legacy = localStorage.getItem(PREFERRED_PLAYER_KEY);
    if (isPreferredPlayer(legacy)) {
      setPreferredPlayer(legacy);
      return legacy;
    }
  } catch {
    // Restricted pages may deny Web Storage access.
  }
  return "web";
}

export function setPreferredPlayer(player: PreferredPlayer): void {
  if (typeof GM_setValue !== "undefined") GM_setValue(PREFERRED_PLAYER_KEY, player);
}

export function getLocalDirectoryEnabled(): boolean {
  if (typeof GM_getValue !== "undefined") return GM_getValue(LOCAL_DIRECTORY_KEY, false) as boolean;
  return false;
}

export function getShowDanmakuHeatmap(): boolean {
  if (typeof GM_getValue !== "undefined") {
    return GM_getValue(SHOW_DANMAKU_HEATMAP_KEY, false) as boolean;
  }
  return false;
}

export function setShowDanmakuHeatmap(v: boolean) {
  if (typeof GM_setValue !== "undefined") {
    GM_setValue(SHOW_DANMAKU_HEATMAP_KEY, v);
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
