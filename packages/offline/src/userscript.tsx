/*
  Entry of the userscript bundle.
  We mount a React app into the target page and expose minimal GM usage with types.

  磁力链接广域检测策略：
  - 覆盖 href、value、data-* 属性以及文本节点中的 magnet: URI
  - 单个磁力：在元素旁注入图标按钮
  - 批量磁力：当存在关联 checkbox 时，就近注入批量按钮
  - 性能优化：首次全量扫描 + MutationObserver 增量扫描
*/
import "@ant-design/v5-patch-for-react-19";
import { notification } from "antd";
import { createRoot } from "react-dom/client";
import { getConfig } from "@/config";
import { submitOffline } from "@/grpc/client";
import { CD2_ICON_BASE64 } from "@/icon";
import { App } from "./ui/App";

// ─── 兼容处理 (Trusted Types) ──────────────────────────
// 仅在 cd2 自身容器内应用 policy，不再全局重写 innerHTML，
// 避免与 Gemini / AI Studio 等网站的 Trusted Types 冲突。

// biome-ignore lint/suspicious/noExplicitAny: TrustedHTML polyfill requires any
const w = window as any;
let cd2Policy: { createHTML: (s: string) => string } | null = null;
if (w.trustedTypes?.createPolicy) {
  try {
    cd2Policy = w.trustedTypes.createPolicy("cd2-offline-policy", {
      createHTML: (s: string) => s,
      createScript: (s: string) => s,
      createScriptURL: (s: string) => s,
    });
  } catch (_e) {
    console.warn("[cd2-offline] 无法创建 TrustedTypes policy, 可能受 CSP 限制", _e);
  }
}

/**
 * 安全设置元素 innerHTML（仅用于 cd2 自己创建的 DOM）。
 * 如果当前环境需要 Trusted Types，使用 cd2 的 policy 包装。
 */
function safeSetInnerHTML(el: HTMLElement, html: string) {
  if (cd2Policy) {
    // biome-ignore lint/suspicious/noExplicitAny: TrustedHTML requires any
    (el as any).innerHTML = cd2Policy.createHTML(html);
  } else {
    el.innerHTML = html;
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

/**
 * 属性值磁力匹配：匹配 magnet:? 开头（用 ^）
 */
const MAGNET_ATTR_RE = /^magnet:\?/i;

/**
 * 文本内容磁力提取：从文本中提取完整的磁力链接
 * 支持 btih 和 btmh 两种类型，hash 长度 32（Base32）或 40（hex）
 */
const MAGNET_TEXT_RE = /magnet:\?xt=urn:bt[im]h:[a-zA-Z0-9]{32,}/g;

/**
 * 从任意 HTML 元素中提取磁力链接。
 * 依次检查：href → value → data-* 属性 → textContent（仅短文本元素）
 */
function extractMagnetUrl(el: HTMLElement): string | null {
  // 1. <a href="magnet:...">
  if (el instanceof HTMLAnchorElement && MAGNET_ATTR_RE.test(el.href)) {
    return el.href;
  }
  // 2. <input value="magnet:..."> / <textarea>
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && MAGNET_ATTR_RE.test(el.value)) {
    return el.value;
  }
  // 3. 任意 data-* 属性
  for (const attr of el.attributes) {
    if (attr.name.startsWith("data-") && MAGNET_ATTR_RE.test(attr.value)) {
      return attr.value;
    }
  }
  // 4. 文本节点检测（仅对已知可能包含磁力的短文本元素）
  //    避免在大段落/文章上执行正则造成性能问题
  if (isTextContainer(el)) {
    const text = el.textContent || "";
    if (text.length < 2000) {
      MAGNET_TEXT_RE.lastIndex = 0;
      const match = MAGNET_TEXT_RE.exec(text);
      if (match) return match[0];
    }
  }
  return null;
}

/**
 * 判断元素是否是可能直接包含磁力文本的容器
 * （排除 body/html 等顶层元素和大段结构性元素）
 */
function isTextContainer(el: HTMLElement): boolean {
  const tag = el.tagName;
  // 仅对这些标签做文本扫描
  return (
    tag === "TD" ||
    tag === "TH" ||
    tag === "SPAN" ||
    tag === "CODE" ||
    tag === "PRE" ||
    tag === "P" ||
    tag === "LI" ||
    tag === "DD" ||
    tag === "DT" ||
    tag === "LABEL" ||
    tag === "SMALL" ||
    tag === "EM" ||
    tag === "STRONG" ||
    tag === "B" ||
    tag === "I"
  );
}

// ─── 收集函数 ──────────────────────────────────────────

/**
 * CSS 选择器集合：覆盖常见的磁力存放位置
 */
const MAGNET_SELECTORS = [
  'a[href^="magnet:"]',
  'input[value^="magnet:"]',
  '[data-clipboard-text^="magnet:"]',
  '[data-magnet^="magnet:"]',
  '[data-href^="magnet:"]',
  '[data-url^="magnet:"]',
  '[data-link^="magnet:"]',
  '[data-value^="magnet:"]',
].join(", ");

/**
 * 文本节点扫描选择器：可能在文本中包含磁力链接的元素
 */
const TEXT_SCAN_SELECTORS = "td, th, span, code, pre, p, li, dd, dt, label";

/**
 * 广域收集所有包含磁力链接的可见元素。
 * 返回去重后的 { el, magnetUrl } 列表。
 * 过滤掉 checkbox/radio（用于批量流程单独处理）。
 *
 * @param root 扫描范围，默认为 document
 */
function collectSingleMagnetElements(root: ParentNode = document): { el: HTMLElement; magnetUrl: string }[] {
  const results: { el: HTMLElement; magnetUrl: string }[] = [];
  const seen = new Set<HTMLElement>();

  // 快速路径：通过属性选择器直接匹配
  root.querySelectorAll<HTMLElement>(MAGNET_SELECTORS).forEach((el) => {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return;
    if (seen.has(el)) return;
    seen.add(el);
    const url = extractMagnetUrl(el);
    if (url) results.push({ el, magnetUrl: url });
  });

  // 慢速路径：扫描文本节点中的磁力链接
  root.querySelectorAll<HTMLElement>(TEXT_SCAN_SELECTORS).forEach((el) => {
    if (seen.has(el)) return;
    // 跳过已注入的 cd2 元素
    if (el.closest(".cd2-offline-btn, .cd2-batch-btn, #cd2-userscript-root")) return;
    const text = el.textContent || "";
    if (text.length > 2000 || text.length < 40) return; // 磁力链接最短约 60 字符
    MAGNET_TEXT_RE.lastIndex = 0;
    if (MAGNET_TEXT_RE.test(text)) {
      seen.add(el);
      MAGNET_TEXT_RE.lastIndex = 0;
      const match = MAGNET_TEXT_RE.exec(text);
      if (match) results.push({ el, magnetUrl: match[0] });
    }
  });

  return results;
}

/**
 * 广域收集所有携带磁力链接的 checkbox。
 * 返回 { checkbox, magnetUrl } 列表。
 *
 * @param root 扫描范围，默认为 document
 */
function collectMagnetCheckboxes(root: ParentNode = document): { checkbox: HTMLInputElement; magnetUrl: string }[] {
  const results: { checkbox: HTMLInputElement; magnetUrl: string }[] = [];
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
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
      const spanLabel = batchBtn.querySelector("span");
      if (spanLabel) spanLabel.textContent = count > 0 ? ` 离线选中(${count})` : " 离线选中";
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

// ─── 增量扫描辅助 ──────────────────────────────────────

/**
 * 从 MutationObserver 的 addedNodes 中提取需要扫描的根节点，
 * 过滤掉 cd2 自己注入的元素和非 Element 节点。
 */
function extractScanRoots(mutations: MutationRecord[]): HTMLElement[] {
  const roots: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      // 跳过 cd2 自己注入的元素
      if (
        node.classList.contains("cd2-offline-btn") ||
        node.classList.contains("cd2-batch-btn") ||
        node.id === "cd2-userscript-root"
      ) {
        continue;
      }
      if (seen.has(node)) continue;
      seen.add(node);
      roots.push(node);
    }
  }
  return roots;
}

/**
 * 对指定的 DOM 子树执行增量磁力扫描和注入。
 */
function processRoots(roots: HTMLElement[]) {
  let hasMagnet = false;
  for (const root of roots) {
    // 扫描 root 自身
    const selfUrl = extractMagnetUrl(root);
    if (selfUrl && !(root instanceof HTMLInputElement && (root.type === "checkbox" || root.type === "radio"))) {
      if (root.dataset[CD2_MARK] !== "1") {
        root.dataset[CD2_MARK] = "1";
        root.insertAdjacentElement("afterend", createIconBtn(selfUrl));
        hasMagnet = true;
      }
    }
    // 扫描 root 的子树
    const single = collectSingleMagnetElements(root);
    const checks = collectMagnetCheckboxes(root);
    if (single.length > 0 || checks.length > 0) {
      hasMagnet = true;
      injectSingleButtons(single);
      injectBatchButtons(checks);
    }
  }
  return hasMagnet;
}

// ─── 入口 ──────────────────────────────────────────────

export function startOffline() {
  const container = ensureContainer();
  const root = createRoot(container);

  // 使用 safeSetInnerHTML 确保 cd2 容器内兼容 Trusted Types
  // （createRoot 会自动管理 DOM，但此函数可用于后续扩展）
  void safeSetInnerHTML;

  let currentHasMagnet = false;

  const renderApp = (hasMagnet: boolean) => {
    if (hasMagnet === currentHasMagnet) return; // 避免不必要的 re-render
    currentHasMagnet = hasMagnet;
    root.render(<App hasMagnet={hasMagnet} />);
  };

  renderApp(false);

  /** 全量扫描 + 注入 */
  const processPage = () => {
    const single = collectSingleMagnetElements();
    const checks = collectMagnetCheckboxes();
    const isLocalhostCD2 = window.location.href.startsWith("http://localhost:19798/");
    const pageHasMagnet = single.length > 0 || checks.length > 0 || isLocalhostCD2;
    renderApp(pageHasMagnet);
    injectSingleButtons(single);
    injectBatchButtons(checks);
  };

  // ─── MutationObserver：增量扫描 ────────────────────

  let pendingMutations: MutationRecord[] = [];
  let rafId: number | null = null;

  const flushMutations = () => {
    rafId = null;
    const mutations = pendingMutations;
    pendingMutations = [];

    const roots = extractScanRoots(mutations);
    if (roots.length === 0) return;

    // 如果新增节点很多（如页面大范围重绘），退化为全量扫描
    if (roots.length > 50) {
      processPage();
      return;
    }

    const found = processRoots(roots);
    if (found && !currentHasMagnet) {
      renderApp(true);
    }
  };

  const onMutation = (mutations: MutationRecord[]) => {
    pendingMutations.push(...mutations);
    if (rafId === null) {
      rafId = requestAnimationFrame(flushMutations);
    }
  };

  // 首次全量扫描
  processPage();

  // 启动 MutationObserver
  const mo = new MutationObserver(onMutation);
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

const extensionRuntime = (globalThis as typeof globalThis & { chrome?: { runtime?: { id?: string } } }).chrome?.runtime;
if (!extensionRuntime?.id) {
  startOffline();
}
