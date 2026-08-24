/**
 * clouddrive2-artplayer 油猴脚本入口
 *
 * 监听来自 clouddrive2-offline 的播放事件，
 * 打开 ArtPlayer 播放器并自动加载弹幕。
 *
 * 弹幕源：danmu_api (https://github.com/huangxd-/danmu_api)
 *
 * 通信协议：
 * - 事件名: cd2-play-video
 * - detail: { fileName, filePath, videoUrl, grpcBaseUrl, apiToken }
 */

import {
	GM_registerMenuCommand,
	unsafeWindow,
} from "vite-plugin-monkey/dist/client";
import {
	cycleDanmuMode,
	getApiUrl,
	getDanmuModeLabel,
	hasApiUrl,
	setApiUrl,
} from "./danmu-api";
import {
	destroyPlayer,
	openPlayer,
	preloadPlayerAudio,
	restorePlayerAfterReload,
} from "./player";

// ─── 播放事件类型定义 ────────────────────────────────────

export interface PlaylistItem {
	fileName: string;
	filePath: string;
}

export interface SubtitleFile {
	fileName: string;
	filePath: string;
	url: string;
}

export interface PlayVideoDetail {
	folderName?: string;
	fileName: string;
	filePath?: string;
	videoUrl: string;
	grpcBaseUrl?: string;
	apiToken?: string;
	playlist?: PlaylistItem[];
	currentIndex?: number;
	subtitles?: SubtitleFile[];
	fileSize?: number;
}

interface PreloadVideoAudioDetail {
	videoUrl: string;
	fileSize?: number;
	filePath?: string;
	fileName?: string;
}

// ─── 事件监听 ────────────────────────────────────────────

function handlePlayVideo(e: CustomEvent<PlayVideoDetail>) {
	const detail = e.detail;
	if (!detail?.fileName || !detail?.videoUrl) {
		console.warn("[cd2-artplayer] 播放事件缺少 fileName 或 videoUrl");
		return;
	}

	console.log("[cd2-artplayer] 收到播放请求:", detail.fileName);

	openPlayer(
		detail.videoUrl,
		detail.fileName,
		detail.filePath,
		undefined,
		detail.playlist,
		detail.currentIndex,
		detail.folderName,
		detail.subtitles,
		undefined,
		detail.fileSize,
	).catch((err) => {
		console.error("[cd2-artplayer] 播放失败:", err);
	});
}

function handlePreloadVideoAudio(e: CustomEvent<PreloadVideoAudioDetail>) {
	const detail = e.detail;
	if (!detail?.videoUrl) return;
	preloadPlayerAudio(
		detail.videoUrl,
		detail.fileSize,
		detail.filePath,
		detail.fileName,
	);
}

// ─── 菜单对话框与状态通知 ───────────────────────────────

const COMMAND_UI_STYLE_ID = "cd2-command-ui-styles";

function ensureCommandUiStyles() {
	if (document.getElementById(COMMAND_UI_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = COMMAND_UI_STYLE_ID;
	style.textContent = `
    .cd2-command-dialog {
      width: min(440px, calc(100% - 32px)); padding: 20px; border: 1px solid #8c959f;
      border-radius: 14px; background: #fff; color: #1f2937;
      box-shadow: 0 18px 48px rgba(0,0,0,.28); color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .cd2-command-dialog::backdrop { background: rgba(0,0,0,.52); }
    .cd2-command-dialog form { display: grid; gap: 14px; margin: 0; }
    .cd2-command-dialog h2 { margin: 0; font-size: 18px; line-height: 1.35; }
    .cd2-command-dialog p { margin: 0; color: #667085; font-size: 12px; line-height: 1.55; }
    .cd2-command-field { display: grid; gap: 7px; font-size: 12px; font-weight: 600; }
    .cd2-command-field-row { position: relative; }
    .cd2-command-field input {
      box-sizing: border-box; width: 100%; min-height: 40px; padding: 8px 11px;
      border: 1px solid #8c959f; border-radius: 9px; background: #fff; color: #1f2937;
      font: inherit; font-weight: 400;
    }
    .cd2-command-field-row input { padding-right: 64px; }
    .cd2-command-reveal {
      position: absolute; top: 5px; right: 5px; bottom: 5px; min-width: 48px;
      border: 0; border-radius: 6px; background: rgba(37,99,235,.1); color: #2563eb;
      font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .cd2-command-error { min-height: 16px; color: #b42318; font-size: 11px; font-weight: 400; }
    .cd2-command-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .cd2-command-button {
      min-height: 38px; padding: 8px 14px; border: 1px solid #8c959f; border-radius: 9px;
      background: #fff; color: #1f2937; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .cd2-command-button-primary { border-color: #2563eb; background: #2563eb; color: #fff; }
    .cd2-command-dialog button:focus-visible,
    .cd2-command-dialog input:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    .cd2-command-notice {
      position: fixed; z-index: 2147483647; top: 18px; left: 50%; transform: translateX(-50%);
      max-width: min(420px, calc(100% - 32px)); padding: 10px 14px; border: 1px solid #8c959f;
      border-radius: 10px; background: #fff; color: #1f2937; box-shadow: 0 10px 30px rgba(0,0,0,.24);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px;
    }
    .cd2-command-notice[data-tone='warning'] { border-color: #a16207; }
    @media (prefers-color-scheme: dark) {
      .cd2-command-dialog, .cd2-command-notice { background: #1c2028; color: #f2f4f7; border-color: #6e7681; }
      .cd2-command-dialog p { color: #a3aab8; }
      .cd2-command-field input { background: #1c2028; color: #f2f4f7; border-color: #6e7681; }
      .cd2-command-error { color: #ff938b; }
      .cd2-command-reveal { background: rgba(122,162,255,.14); color: #7aa2ff; }
      .cd2-command-button { background: #1c2028; color: #f2f4f7; border-color: #6e7681; }
      .cd2-command-button-primary { border-color: #315fbd; background: #315fbd; color: #fff; }
      .cd2-command-dialog button:focus-visible,
      .cd2-command-dialog input:focus-visible { outline-color: #7aa2ff; }
    }
    @media (prefers-reduced-motion: reduce) {
      .cd2-command-dialog *, .cd2-command-notice { transition: none !important; }
    }
  `;
	document.head.appendChild(style);
}

function showCommandNotice(
	message: string,
	tone: "default" | "warning" = "default",
) {
	ensureCommandUiStyles();
	for (const existing of document.querySelectorAll(".cd2-command-notice"))
		existing.remove();
	const notice = document.createElement("div");
	notice.className = "cd2-command-notice";
	notice.dataset.tone = tone;
	notice.setAttribute("role", "status");
	notice.setAttribute("aria-live", "polite");
	notice.textContent = message;
	document.body.appendChild(notice);
	window.setTimeout(() => notice.remove(), 3200);
}

function createCommandDialog(title: string, description: string) {
	ensureCommandUiStyles();
	const dialog = document.createElement("dialog");
	dialog.className = "cd2-command-dialog";
	const form = document.createElement("form");
	const heading = document.createElement("h2");
	const headingId = `cd2-command-title-${Date.now()}`;
	heading.id = headingId;
	heading.textContent = title;
	dialog.setAttribute("aria-labelledby", headingId);
	const help = document.createElement("p");
	help.textContent = description;
	form.append(heading, help);
	dialog.appendChild(form);
	dialog.addEventListener("close", () => dialog.remove(), { once: true });
	document.body.appendChild(dialog);
	return { dialog, form };
}

function createDialogActions(cancelText: string, confirmText: string) {
	const actions = document.createElement("div");
	actions.className = "cd2-command-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "cd2-command-button";
	cancel.textContent = cancelText;
	const confirm = document.createElement("button");
	confirm.type = "submit";
	confirm.className = "cd2-command-button cd2-command-button-primary";
	confirm.textContent = confirmText;
	actions.append(cancel, confirm);
	return { actions, cancel };
}

function showDanmuApiConfig() {
	const existing = document.querySelector<HTMLDialogElement>(
		"dialog.cd2-command-dialog",
	);
	if (existing) {
		existing.focus();
		return;
	}
	const { dialog, form } = createCommandDialog(
		"弹幕 API 配置",
		"用于直连失败时的后备 danmu_api 服务。地址可能包含访问令牌，请勿公开分享。",
	);
	const label = document.createElement("label");
	label.className = "cd2-command-field";
	label.textContent = "API 地址（可留空）";
	const fieldRow = document.createElement("div");
	fieldRow.className = "cd2-command-field-row";
	const input = document.createElement("input");
	input.type = "password";
	input.inputMode = "url";
	input.autocomplete = "off";
	input.value = getApiUrl();
	input.placeholder = "https://example.com/token";
	const reveal = document.createElement("button");
	reveal.type = "button";
	reveal.className = "cd2-command-reveal";
	reveal.textContent = "显示";
	reveal.setAttribute("aria-label", "显示 API 地址");
	reveal.setAttribute("aria-pressed", "false");
	reveal.onclick = () => {
		const visible = input.type === "password";
		input.type = visible ? "text" : "password";
		reveal.textContent = visible ? "隐藏" : "显示";
		reveal.setAttribute("aria-label", `${visible ? "隐藏" : "显示"} API 地址`);
		reveal.setAttribute("aria-pressed", String(visible));
	};
	fieldRow.append(input, reveal);
	const error = document.createElement("span");
	error.className = "cd2-command-error";
	error.setAttribute("aria-live", "polite");
	label.append(fieldRow, error);
	const { actions, cancel } = createDialogActions("取消", "保存");
	form.append(label, actions);
	cancel.onclick = () => dialog.close("cancel");
	form.onsubmit = (event) => {
		event.preventDefault();
		const value = input.value.trim();
		let validationMessage = "";
		if (value) {
			try {
				const parsed = new URL(value);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
					validationMessage = "仅支持 HTTP 或 HTTPS 地址";
			} catch {
				validationMessage = "请输入完整的 HTTP 或 HTTPS 地址";
			}
		}
		input.setCustomValidity(validationMessage);
		error.textContent = validationMessage;
		if (validationMessage) {
			input.focus();
			input.reportValidity();
			return;
		}
		setApiUrl(value);
		dialog.close("saved");
		showCommandNotice(
			value ? "弹幕 API 地址已保存" : "后备弹幕 API 已关闭",
			value ? "default" : "warning",
		);
	};
	dialog.showModal();
	input.focus();
	input.select();
}

function showTestPlaybackDialog() {
	const existing = document.querySelector<HTMLDialogElement>(
		"dialog.cd2-command-dialog",
	);
	if (existing) {
		existing.focus();
		return;
	}
	const { dialog, form } = createCommandDialog(
		"测试播放",
		"输入可直接访问的视频 URL 和用于弹幕匹配的文件名。",
	);
	const urlLabel = document.createElement("label");
	urlLabel.className = "cd2-command-field";
	urlLabel.textContent = "视频 URL";
	const urlInput = document.createElement("input");
	urlInput.type = "url";
	urlInput.required = true;
	urlInput.placeholder = "https://example.com/video.mp4";
	urlLabel.appendChild(urlInput);
	const nameLabel = document.createElement("label");
	nameLabel.className = "cd2-command-field";
	nameLabel.textContent = "文件名";
	const nameInput = document.createElement("input");
	nameInput.required = true;
	nameInput.value = "test.mp4";
	nameLabel.appendChild(nameInput);
	const { actions, cancel } = createDialogActions("取消", "播放");
	form.append(urlLabel, nameLabel, actions);
	cancel.onclick = () => dialog.close("cancel");
	form.onsubmit = (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		const url = urlInput.value.trim();
		const fileName = nameInput.value.trim() || "test.mp4";
		dialog.close("play");
		window.requestAnimationFrame(() => {
			void openPlayer(url, fileName).catch((error) => {
				showCommandNotice(`播放失败：${(error as Error).message}`, "warning");
			});
		});
	};
	dialog.showModal();
	urlInput.focus();
}

// ─── 脚本菜单 ────────────────────────────────────────────

function registerMenuCommands() {
	GM_registerMenuCommand("⚙ 弹幕 API 配置", showDanmuApiConfig);

	GM_registerMenuCommand(`🔄 弹幕模式: ${getDanmuModeLabel()}`, () => {
		const newMode = cycleDanmuMode();
		showCommandNotice(
			`弹幕模式已切换为“${getDanmuModeLabel(newMode)}”，下次匹配时生效`,
		);
	});

	GM_registerMenuCommand("关闭播放器", () => {
		destroyPlayer();
	});

	GM_registerMenuCommand("测试播放（输入URL）", showTestPlaybackDialog);
}

// ─── 入口 ────────────────────────────────────────────────

export function startArtplayer() {
	console.log("[cd2-artplayer] 脚本已加载");

	// 检查弹幕API配置（直连弹弹Play代理无需配置，此提示仅与后备API相关）
	if (!hasApiUrl()) {
		console.info(
			"[cd2-artplayer] 未配置弹幕 API 地址，将仅使用直连弹弹Play代理获取弹幕。",
		);
	}

	// 标记 artplayer 已就绪（使用 unsafeWindow 跨沙箱通信）
	// biome-ignore lint/suspicious/noExplicitAny: Required for unsafeWindow extension
	(unsafeWindow as any).__cd2ArtplayerReady = true;

	registerMenuCommands();

	unsafeWindow.addEventListener(
		"cd2-play-video",
		handlePlayVideo as EventListener,
	);
	unsafeWindow.addEventListener(
		"cd2-preload-video-audio",
		handlePreloadVideoAudio as EventListener,
	);
	unsafeWindow.dispatchEvent(new CustomEvent("cd2-artplayer-ready"));

	// 给离线任务组件留出挂载事件桥的时间，再恢复刷新前打开的播放器。
	window.setTimeout(() => {
		void restorePlayerAfterReload().catch((error) => {
			console.warn("[cd2-artplayer] 刷新后恢复播放器失败:", error);
		});
	}, 250);
}

const extensionRuntime = (
	globalThis as typeof globalThis & {
		chrome?: { runtime?: { id?: string } };
	}
).chrome?.runtime;
if (!extensionRuntime?.id) {
	startArtplayer();
}
