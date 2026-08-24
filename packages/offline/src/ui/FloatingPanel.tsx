import { App as AntdApp, Button, Card, Input, Space, Tabs, Typography } from "antd";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FloatingPanelPosition,
  type FloatingPanelPositions,
  type FloatingPanelSize,
  getConfig,
  getFloatingPanelExpanded,
  getFloatingPanelPositions,
  getFloatingPanelSize,
  setFloatingPanelExpanded,
  setFloatingPanelPositions,
  setFloatingPanelSize,
} from "@/config";
import { submitOffline } from "@/grpc/client";
import { CD2_ICON_BASE64 } from "@/icon";
import { OfflineTasksTab, prefetchOfflineTaskPage } from "./components/OfflineTasksTab";

export interface FloatingPanelProps {
  onOpenSettings?: () => void;
}

type DragState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startBottom: number;
  moved: boolean;
  captureTarget: HTMLElement;
};

type ResizeMode = "width" | "height" | "both";

type ResizeState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
  minimumWidth: number;
  mode: ResizeMode;
  captureTarget: HTMLElement;
};

const VIEWPORT_MARGIN = 8;
const PANEL_DRAG_EXCLUDED_SELECTOR =
  "button, input, textarea, select, option, a, label, [role='button'], [role='checkbox'], [role='combobox'], [role='tab'], [contenteditable='true'], .ant-tabs-tab";

export function FloatingPanel({ onOpenSettings }: FloatingPanelProps) {
  const { message } = AntdApp.useApp();
  const [batchUrls, setBatchUrls] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState(() => !getFloatingPanelExpanded());
  const [positions, setPositions] = useState<FloatingPanelPositions>(() => getFloatingPanelPositions());
  const [panelSize, setPanelSize] = useState<FloatingPanelSize>(() => getFloatingPanelSize());
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef(positions);
  const panelSizeRef = useRef(panelSize);
  const preferredPanelSizeRef = useRef(panelSize);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const suppressClickRef = useRef(false);

  const updateCollapsed = useCallback((nextCollapsed: boolean) => {
    setCollapsed(nextCollapsed);
    setFloatingPanelExpanded(!nextCollapsed);
  }, []);

  const getMinimumPanelWidth = useCallback(() => {
    const panel = panelRef.current;
    const table = panel?.querySelector<HTMLElement>(".cd2-task-table");
    const tableBody = table?.querySelector<HTMLElement>(".ant-table-body");
    if (!panel || !table || !tableBody || tableBody.clientWidth === 0 || !tableBody.offsetParent) {
      return 480;
    }
    const panelChromeWidth = Math.max(0, panel.getBoundingClientRect().width - tableBody.clientWidth);
    if (panelChromeWidth > 100) return 480;
    return Math.max(480, Math.ceil(panelChromeWidth + 32 + 140 + 90 + 180));
  }, []);

  const clampPosition = useCallback((candidate: FloatingPanelPosition, element: HTMLElement | null) => {
    const width = element?.offsetWidth ?? 36;
    const height = element?.offsetHeight ?? 36;
    return {
      left: Math.min(
        Math.max(VIEWPORT_MARGIN, candidate.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      ),
      bottom: Math.min(
        Math.max(VIEWPORT_MARGIN, candidate.bottom),
        Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
      ),
    };
  }, []);

  const clampPositionForSize = useCallback((candidate: FloatingPanelPosition, size: FloatingPanelSize) => {
    return {
      left: Math.min(
        Math.max(VIEWPORT_MARGIN, candidate.left),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - size.width - VIEWPORT_MARGIN),
      ),
      bottom: Math.min(
        Math.max(VIEWPORT_MARGIN, candidate.bottom),
        Math.max(VIEWPORT_MARGIN, window.innerHeight - size.height - VIEWPORT_MARGIN),
      ),
    };
  }, []);

  const applyPosition = useCallback((element: HTMLElement | null, next: FloatingPanelPosition) => {
    if (!element) return;
    element.style.left = `${next.left}px`;
    element.style.bottom = `${next.bottom}px`;
  }, []);

  const clampPanelSize = useCallback((candidate: FloatingPanelSize, requestedMinimumWidth = 480): FloatingPanelSize => {
    const maxWidth = Math.max(1, window.innerWidth - VIEWPORT_MARGIN * 2);
    const maxHeight = Math.max(1, window.innerHeight - VIEWPORT_MARGIN * 2);
    const minWidth = Math.min(Math.max(480, requestedMinimumWidth), maxWidth);
    const minHeight = Math.min(360, maxHeight);
    return {
      width: Math.min(maxWidth, Math.max(minWidth, candidate.width)),
      height: Math.min(maxHeight, Math.max(minHeight, candidate.height)),
    };
  }, []);

  const applyPanelSize = useCallback((element: HTMLElement | null, next: FloatingPanelSize) => {
    if (!element) return;
    element.style.width = `${next.width}px`;
    element.style.height = `${next.height}px`;
  }, []);

  const commitPanelSize = useCallback((next: FloatingPanelSize) => {
    preferredPanelSizeRef.current = next;
    panelSizeRef.current = next;
    setPanelSize(next);
    setFloatingPanelSize(next);
  }, []);

  const commitPosition = useCallback(
    (next: FloatingPanelPosition) => {
      const key = collapsed ? "collapsed" : "expanded";
      const nextPositions = { ...positionsRef.current, [key]: next };
      positionsRef.current = nextPositions;
      setPositions(nextPositions);
      setFloatingPanelPositions(nextPositions);
    },
    [collapsed],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      const element = collapsed ? fabRef.current : panelRef.current;
      const key = collapsed ? "collapsed" : "expanded";
      const startPosition = clampPosition(positionsRef.current[key], element);
      applyPosition(element, startPosition);
      positionsRef.current = { ...positionsRef.current, [key]: startPosition };
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startLeft: startPosition.left,
        startBottom: startPosition.bottom,
        moved: false,
        captureTarget: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      setDragging(true);
    },
    [applyPosition, clampPosition, collapsed],
  );

  const startPanelDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.target instanceof Element) {
        if (event.target.closest(PANEL_DRAG_EXCLUDED_SELECTOR)) return;
        const scrollable = event.target.closest<HTMLElement>(".ant-table-body");
        if (scrollable) {
          const bounds = scrollable.getBoundingClientRect();
          const verticalScrollbarWidth = scrollable.offsetWidth - scrollable.clientWidth;
          const horizontalScrollbarHeight = scrollable.offsetHeight - scrollable.clientHeight;
          const inVerticalScrollbar =
            verticalScrollbarWidth > 0 && event.clientX >= bounds.right - verticalScrollbarWidth;
          const inHorizontalScrollbar =
            horizontalScrollbarHeight > 0 && event.clientY >= bounds.bottom - horizontalScrollbarHeight;
          if (inVerticalScrollbar || inHorizontalScrollbar) return;
        }
      }
      startDrag(event);
    },
    [startDrag],
  );

  const startResize = useCallback(
    (mode: ResizeMode) => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary || collapsed) return;
      const element = panelRef.current;
      const minimumWidth = getMinimumPanelWidth();
      const startSize = clampPanelSize(
        {
          width: element?.offsetWidth ?? panelSizeRef.current.width,
          height: element?.offsetHeight ?? panelSizeRef.current.height,
        },
        minimumWidth,
      );
      panelSizeRef.current = startSize;
      resizeRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: startSize.width,
        startHeight: startSize.height,
        minimumWidth,
        mode,
        captureTarget: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
      setResizing(true);
    },
    [clampPanelSize, collapsed, getMinimumPanelWidth],
  );

  useEffect(() => {
    if (!dragging) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) >= 4) drag.moved = true;
      const element = collapsed ? fabRef.current : panelRef.current;
      const key = collapsed ? "collapsed" : "expanded";
      const next = clampPosition({ left: drag.startLeft + deltaX, bottom: drag.startBottom - deltaY }, element);
      positionsRef.current = { ...positionsRef.current, [key]: next };
      applyPosition(element, next);
      if (drag.moved) event.preventDefault();
    };

    const finishDrag = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.captureTarget.hasPointerCapture(event.pointerId)) {
        drag.captureTarget.releasePointerCapture(event.pointerId);
      }
      const moved = drag.moved;
      dragRef.current = null;
      setDragging(false);
      const key = collapsed ? "collapsed" : "expanded";
      commitPosition(positionsRef.current[key]);

      if (collapsed && event.type === "pointerup" && !moved) {
        updateCollapsed(false);
      } else if (collapsed && moved) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, [applyPosition, clampPosition, collapsed, commitPosition, dragging, updateCollapsed]);

  useEffect(() => {
    if (!resizing) return;
    let pendingClientX = resizeRef.current?.startClientX ?? 0;
    let pendingClientY = resizeRef.current?.startClientY ?? 0;
    let frameId: number | null = null;

    const applyPendingResize = () => {
      frameId = null;
      const resize = resizeRef.current;
      if (!resize) return;
      const deltaX = pendingClientX - resize.startClientX;
      const deltaY = pendingClientY - resize.startClientY;
      const next = clampPanelSize(
        {
          width: resize.mode === "height" ? resize.startWidth : resize.startWidth + deltaX,
          height: resize.mode === "width" ? resize.startHeight : resize.startHeight - deltaY,
        },
        resize.minimumWidth,
      );
      panelSizeRef.current = next;
      applyPanelSize(panelRef.current, next);

      const nextPosition = clampPositionForSize(positionsRef.current.expanded, next);
      positionsRef.current = { ...positionsRef.current, expanded: nextPosition };
      applyPosition(panelRef.current, nextPosition);
    };

    const onPointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      pendingClientX = event.clientX;
      pendingClientY = event.clientY;
      if (frameId === null) frameId = window.requestAnimationFrame(applyPendingResize);
      event.preventDefault();
    };

    const finishResize = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;
      if (event.type === "pointerup") {
        pendingClientX = event.clientX;
        pendingClientY = event.clientY;
      }
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      applyPendingResize();
      if (resize.captureTarget.hasPointerCapture(event.pointerId)) {
        resize.captureTarget.releasePointerCapture(event.pointerId);
      }
      resizeRef.current = null;
      setResizing(false);
      commitPanelSize(panelSizeRef.current);
      commitPosition(positionsRef.current.expanded);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [applyPanelSize, applyPosition, clampPanelSize, clampPositionForSize, commitPanelSize, commitPosition, resizing]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = collapsed ? fabRef.current : panelRef.current;
      if (!collapsed) {
        const nextSize = clampPanelSize(preferredPanelSizeRef.current, getMinimumPanelWidth());
        applyPanelSize(element, nextSize);
        if (nextSize.width !== panelSizeRef.current.width || nextSize.height !== panelSizeRef.current.height) {
          panelSizeRef.current = nextSize;
          setPanelSize(nextSize);
        }
      }
      const key = collapsed ? "collapsed" : "expanded";
      const current = positionsRef.current[key];
      const next = clampPosition(current, element);
      applyPosition(element, next);
      if (next.left !== current.left || next.bottom !== current.bottom) commitPosition(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [applyPanelSize, applyPosition, clampPanelSize, clampPosition, collapsed, commitPosition, getMinimumPanelWidth]);

  useEffect(() => {
    let frameId: number | null = null;

    const onResize = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        const element = collapsed ? fabRef.current : panelRef.current;
        if (!collapsed) {
          const nextSize = clampPanelSize(preferredPanelSizeRef.current, getMinimumPanelWidth());
          applyPanelSize(element, nextSize);
          panelSizeRef.current = nextSize;
          setPanelSize((current) =>
            current.width === nextSize.width && current.height === nextSize.height ? current : nextSize,
          );
        }
        const key = collapsed ? "collapsed" : "expanded";
        const next = clampPosition(positionsRef.current[key], element);
        applyPosition(element, next);
        commitPosition(next);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", onResize);
    };
  }, [applyPanelSize, applyPosition, clampPanelSize, clampPosition, collapsed, commitPosition, getMinimumPanelWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => void prefetchOfflineTaskPage(), 600);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!collapsed) {
      window.dispatchEvent(new CustomEvent("cd2-audio-fallback-warmup"));
    }
  }, [collapsed]);

  // 监听任务提交事件 → 自动展开面板
  useEffect(() => {
    const onTaskSubmitted = () => updateCollapsed(false);
    window.addEventListener("cd2-task-submitted", onTaskSubmitted);
    return () => window.removeEventListener("cd2-task-submitted", onTaskSubmitted);
  }, [updateCollapsed]);

  const onBatchAdd = async () => {
    if (!batchUrls.trim()) {
      message.warning("请输入至少一个链接");
      return;
    }
    const cfg = getConfig();
    setSubmitting(true);
    try {
      const res = await submitOffline(batchUrls, cfg.offlineDestPath);
      if (res.ok) {
        message.success("已提交离线下载任务");
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: batchUrls } }));
        setBatchUrls("");
      } else if (res.alreadyExists) {
        message.info("任务已存在，已置顶显示");
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: batchUrls } }));
        setBatchUrls("");
      } else {
        console.error(res.error ?? res.errorMessage);
        message.error(res.errorMessage || "提交失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const linkCount = useMemo(() => {
    return batchUrls
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean).length;
  }, [batchUrls]);

  const addOfflineNode = (
    <div className="cd2-add-task-layout">
      <div className="cd2-add-task-header">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          支持磁力链接（magnet:?xt=...）或 HTTP/HTTPS 直链，每行一个
        </Typography.Text>
      </div>
      <div className="cd2-add-task-body">
        <Input.TextArea
          className="cd2-add-task-textarea"
          placeholder={"magnet:?xt=urn:btih:...\nhttps://example.com/file.zip\n..."}
          value={batchUrls}
          onChange={(e) => setBatchUrls(e.target.value)}
          autoSize={false}
        />
      </div>
      <div className="cd2-add-task-footer">
        <div className="cd2-add-task-status">
          {linkCount > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              已输入{" "}
              <Typography.Text strong style={{ fontSize: 12 }}>
                {linkCount}
              </Typography.Text>{" "}
              个任务
            </Typography.Text>
          )}
        </div>
        <Space size={8}>
          {batchUrls.trim() && (
            <Button size="small" onClick={() => setBatchUrls("")} disabled={submitting}>
              清空
            </Button>
          )}
          <Button type="primary" size="small" onClick={onBatchAdd} loading={submitting} disabled={!batchUrls.trim()}>
            批量提交{linkCount > 1 ? ` (${linkCount})` : ""}
          </Button>
        </Space>
      </div>
    </div>
  );

  const items = [
    {
      key: "offline",
      label: "任务列表",
      children: <OfflineTasksTab />,
    },
    { key: "add-offline", label: "添加任务", children: addOfflineNode },
  ];
  const activePosition = collapsed ? positions.collapsed : positions.expanded;

  // 收起状态：仅显示图标悬浮球
  if (collapsed) {
    return (
      <button
        ref={fabRef}
        type="button"
        className={`cd2-floating-fab${dragging ? " cd2-is-dragging" : ""}`}
        style={{ left: activePosition.left, bottom: activePosition.bottom }}
        onPointerDown={startDrag}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          updateCollapsed(false);
        }}
        title="点击展开，拖动调整位置"
      >
        <img
          src={CD2_ICON_BASE64}
          width={28}
          height={28}
          alt="CD2"
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
        />
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      className={`cd2-floating-panel${dragging ? " cd2-is-dragging" : ""}${resizing ? " cd2-is-resizing" : ""}`}
      onPointerDown={startPanelDrag}
      style={{
        left: activePosition.left,
        bottom: activePosition.bottom,
        width: panelSize.width,
        height: panelSize.height,
      }}
    >
      <div className="cd2-panel-resize-edge cd2-panel-resize-edge-right" onPointerDown={startResize("width")} />
      <div className="cd2-panel-resize-edge cd2-panel-resize-edge-top" onPointerDown={startResize("height")} />
      <div className="cd2-panel-resize-corner" onPointerDown={startResize("both")} title="拖动调整窗口大小" />
      <Card
        size="small"
        title={
          <span
            className="cd2-panel-drag-handle"
            style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}
            title="拖动面板"
          >
            <img src={CD2_ICON_BASE64} width={18} height={18} alt="" draggable={false} />
            CloudDrive2
          </span>
        }
        extra={
          <Space>
            {onOpenSettings && (
              <Button size="small" type="text" onClick={onOpenSettings}>
                设置
              </Button>
            )}
            <Button size="small" type="text" onClick={() => updateCollapsed(true)}>
              收起
            </Button>
          </Space>
        }
        bodyStyle={{ padding: 8 }}
        style={{ width: "100%" }}
      >
        <Tabs size="small" items={items} />
      </Card>
    </div>
  );
}
