/*
  Entry of the userscript bundle.
  We mount a React app into the target page and expose minimal GM usage with types.

  磁力链接广域检测策略：
  - 覆盖任意 data-* 属性中的 magnet: URI
  - 单个磁力：在元素旁注入图标按钮
  - 批量磁力：当存在关联 checkbox 时，就近注入批量按钮
*/
import "@ant-design/v5-patch-for-react-19";
import { notification } from "antd";
import { createRoot } from "react-dom/client";
import { getConfig } from "@/config";
import { submitOffline } from "@/grpc/client";
import { CD2_ICON_BASE64 } from "@/icon";
import { App } from "./ui/App";

// ─── 兼容处理 (Trusted Types) ──────────────────────────
// 解决在 Google Gemini / AI Studio 等开启了核心严苛 CSP 的网站上，
// React/Antd 插入包含内联样式的 DOM 时触发 TrustedHTML 报错的问题。
const w = window as any;
if (typeof w.trustedTypes !== "undefined" && w.trustedTypes.createPolicy) {
  try {
    const cd2Policy = w.trustedTypes.createPolicy("cd2-offline-policy", {
      createHTML: (s: string) => s,
      createScript: (s: string) => s,
      createScriptURL: (s: string) => s,
    });
    const origInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    const origSet = origInnerHTML?.set;
    if (origInnerHTML && origSet) {
      Object.defineProperty(Element.prototype, "innerHTML", {
        set(value) {
          if (typeof value === "string") {
            try {
              origSet.call(this, cd2Policy.createHTML(value));
            } catch {
              origSet.call(this, value);
            }
          } else {
            origSet.call(this, value);
          }
        },
        get: origInnerHTML.get,
        enumerable: true,
        configurable: true,
      });
    }
  } catch (_e) {
    console.warn("[cd2-offline] 无法创建或应用 TrustedTypes policy, 可能受 CSP 限制", _e);
  }
}

// ─── 工具函数 ──────────────────────────────────────────

function ensureContainer(id = "cd2-userscript-root") {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

const MAGNET_RE = /^magnet:\?/i;

/**
 * 从任意 HTML 元素中提取磁力链接。
 * 检查 href、value 以及所有 data-* 属性。
 */
function extractMagnetUrl(el: HTMLElement): string | null {
  // 1. <a href="magnet:...">
  if (el instanceof HTMLAnchorElement && MAGNET_RE.test(el.href)) {
    return el.href;
  }
  // 2. <input value="magnet:...">
  if (el instanceof HTMLInputElement && MAGNET_RE.test(el.value)) {
    return el.value;
  }
  // 3. 任意 data-* 属性
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-") && MAGNET_RE.test(attr.value)) {
      return attr.value;
    }
  }
  return null;
}

/**
 * 广域收集所有包含磁力链接的可见元素。
 * 返回去重后的 { el, magnetUrl } 列表。
 * 过滤掉 checkbox/radio（用于批量流程单独处理）。
 */
function collectSingleMagnetElements(): { el: HTMLElement; magnetUrl: string }[] {
  const results: { el: HTMLElement; magnetUrl: string }[] = [];
  const seen = new Set<HTMLElement>();

  // 快速路径：常见选择器
  const selectors = [
    'a[href^="magnet:"]',
    '[data-clipboard-text^="magnet:"]',
    '[data-magnet^="magnet:"]',
    '[data-href^="magnet:"]',
    '[data-url^="magnet:"]',
    '[data-link^="magnet:"]',
    '[data-value^="magnet:"]',
  ].join(", ");

  document.querySelectorAll<HTMLElement>(selectors).forEach((el) => {
    // 跳过 checkbox / radio（用批量处理）
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return;
    if (seen.has(el)) return;
    seen.add(el);
    const url = extractMagnetUrl(el);
    if (url) results.push({ el, magnetUrl: url });
  });

  return results;
}

/**
 * 广域收集所有携带磁力链接的 checkbox。
 * 返回 { checkbox, magnetUrl } 列表。
 */
function collectMagnetCheckboxes(): { checkbox: HTMLInputElement; magnetUrl: string }[] {
  const results: { checkbox: HTMLInputElement; magnetUrl: string }[] = [];
  // 选择所有 checkbox
  document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    const url = extractMagnetUrl(cb);
    if (url) {
      results.push({ checkbox: cb, magnetUrl: url });
    }
  });
  return results;
}

// ─── 按钮创建 ──────────────────────────────────────────

function createIconBtn(magnetUrl: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "cd2-offline-btn";
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-label", "提交离线下载");
  btn.title = "提交到 CloudDrive 离线下载";
  btn.style.marginLeft = "6px";

  const icon = document.createElement("img");
  icon.src = CD2_ICON_BASE64;
  icon.width = 20;
  icon.height = 20;
  icon.style.verticalAlign = "middle";
  icon.alt = "CD2";
  btn.appendChild(icon);

  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const cfg = getConfig();
    btn.disabled = true;
    btn.style.opacity = "0.5";
    try {
      const res = await submitOffline(magnetUrl, cfg.offlineDestPath);
      if (res.ok) {
        notification.success({ message: "已提交离线下载任务" });
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: magnetUrl } }));
      } else if (res.alreadyExists) {
        notification.info({ message: "任务已存在，已置顶显示" });
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: magnetUrl } }));
      } else {
        notification.error({ message: `提交失败: ${res.errorMessage || "未知错误"}` });
      }
    } finally {
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  };
  return btn;
}

function createBatchBtn(getUrls: () => string[]): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "cd2-batch-btn";
  btn.setAttribute("type", "button");
  btn.title = "批量添加选中磁链到 CloudDrive 离线下载";

  const icon = document.createElement("img");
  icon.src = CD2_ICON_BASE64;
  icon.width = 16;
  icon.height = 16;
  icon.style.verticalAlign = "middle";
  icon.alt = "CD2";
  btn.appendChild(icon);

  const label = document.createElement("span");
  label.textContent = " 离线选中";
  label.style.verticalAlign = "middle";
  btn.appendChild(label);

  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const urls = getUrls();
    if (urls.length === 0) {
      notification.warning({ message: "未选中任何磁力链接" });
      return;
    }
    const combined = urls.join("\n");
    const cfg = getConfig();
    btn.disabled = true;
    btn.style.opacity = "0.5";
    label.textContent = ` 提交中(${urls.length})…`;
    try {
      const res = await submitOffline(combined, cfg.offlineDestPath);
      if (res.ok) {
        notification.success({ message: `已提交 ${urls.length} 个离线下载任务` });
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: combined } }));
      } else if (res.alreadyExists) {
        notification.info({ message: "任务已存在，已置顶显示" });
        window.dispatchEvent(new CustomEvent("cd2-task-submitted", { detail: { urls: combined } }));
      } else {
        notification.error({ message: `提交失败: ${res.errorMessage || "未知错误"}` });
      }
    } finally {
      btn.disabled = false;
      btn.style.opacity = "1";
      label.textContent = " 离线选中";
    }
  };
  return btn;
}

// ─── 注入逻辑 ──────────────────────────────────────────

const CD2_MARK = "cd2Injected";
const CD2_BATCH_MARK = "cd2BatchInjected";

/** 为单个磁力元素注入图标按钮 */
function injectSingleButtons(items?: { el: HTMLElement; magnetUrl: string }[]) {
  const list = items ?? collectSingleMagnetElements();
  list.forEach(({ el, magnetUrl }) => {
    if (el.dataset[CD2_MARK] === "1") return;
    el.dataset[CD2_MARK] = "1";
    el.insertAdjacentElement("afterend", createIconBtn(magnetUrl));
  });
}

/**
 * 为包含磁力 checkbox 的分组注入批量按钮。
 * 通用策略：
 * 1. 找到所有携带磁力的 checkbox
 * 2. 按最近共同容器分组（table / ul / form / 父级 div）
 * 3. 在每个容器的首个 checkbox 前或容器顶部注入批量按钮
 * 4. 批量按钮的 disabled 状态跟随 checkbox 选中数量
 */
function injectBatchButtons(items?: { checkbox: HTMLInputElement; magnetUrl: string }[]) {
  const checkboxes = items ?? collectMagnetCheckboxes();
  if (checkboxes.length === 0) return;

  // 按容器分组
  const containerMap = new Map<HTMLElement, HTMLInputElement[]>();
  for (const { checkbox } of checkboxes) {
    // 找最近的有意义容器: table, ul, ol, form, 或有多于2个子元素的div
    const container =
      checkbox.closest("table, ul, ol, form, .subgroup-text, .bangumi-subgroup, section, article") ||
      findMeaningfulParent(checkbox);
    if (!container || !(container instanceof HTMLElement)) continue;
    if (!containerMap.has(container)) containerMap.set(container, []);
    containerMap.get(container)?.push(checkbox);
  }

  containerMap.forEach((cbs, container) => {
    if (container.dataset[CD2_BATCH_MARK] === "1") return;
    container.dataset[CD2_BATCH_MARK] = "1";

    const getSelectedUrls = (): string[] => {
      const urls: string[] = [];
      cbs.forEach((cb) => {
        if (cb.checked) {
          const url = extractMagnetUrl(cb);
          if (url) urls.push(url);
        }
      });
      return urls;
    };

    const batchBtn = createBatchBtn(getSelectedUrls);

    // 初始检查和状态同步
    const syncState = () => {
      const count = cbs.filter((cb) => cb.checked).length;
      batchBtn.disabled = count === 0;
      batchBtn.style.opacity = count === 0 ? "0.5" : "1";
      const label = batchBtn.querySelector("span");
      if (label) label.textContent = count > 0 ? ` 离线选中(${count})` : " 离线选中";
    };
    syncState();

    // 监听 checkbox 变化
    container.addEventListener("change", (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") {
        setTimeout(syncState, 30);
      }
    });

    // 插入位置：在容器内第一个 checkbox 的最近行级祖先之前，或容器最前面
    const firstRow = cbs[0].closest("tr, li, .an-ul-li, div") || cbs[0].parentElement;
    if (firstRow && firstRow.parentElement === container) {
      firstRow.insertAdjacentElement("beforebegin", batchBtn);
    } else {
      container.insertAdjacentElement("afterbegin", batchBtn);
    }
  });
}

/** 向上查找有意义的容器（至少包含2+个直接子元素的div） */
function findMeaningfulParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  for (let i = 0; i < 5 && parent; i++) {
    if (parent.children.length >= 2) return parent;
    parent = parent.parentElement;
  }
  return parent || document.body;
}

// ─── 入口 ──────────────────────────────────────────────

(function main() {
  const container = ensureContainer();
  const root = createRoot(container);

  const renderApp = (hasMagnet: boolean) => {
    root.render(<App hasMagnet={hasMagnet} />);
  };

  renderApp(false);

  const processPage = () => {
    const single = collectSingleMagnetElements();
    const checks = collectMagnetCheckboxes();
    const isLocalhostCD2 = window.location.href.startsWith("http://localhost:19798/");
    const pageHasMagnet = single.length > 0 || checks.length > 0 || isLocalhostCD2;
    renderApp(pageHasMagnet);
    injectSingleButtons(single);
    injectBatchButtons(checks);
  };

  let debounceTimer: number | null = null;
  const processPageDebounced = () => {
    if (debounceTimer) {
      window.clearTimeout(debounceTimer);
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      processPage();
    }, 150);
  };

  processPage();
  const mo = new MutationObserver(() => processPageDebounced());
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
