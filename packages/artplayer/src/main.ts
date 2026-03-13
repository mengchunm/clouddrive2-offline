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
import { destroyPlayer, openPlayer } from "./player";

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
}

// ─── 事件监听 ────────────────────────────────────────────

function handlePlayVideo(e: CustomEvent<PlayVideoDetail>) {
	const detail = e.detail;
	if (!detail?.fileName || !detail?.videoUrl) {
		console.warn("[cd2-artplayer] 播放事件缺少 fileName 或 videoUrl");
		return;
	}

	console.log("[cd2-artplayer] 收到播放请求:", detail.fileName);

	openPlayer(detail.videoUrl, detail.fileName, undefined, detail.playlist, detail.currentIndex, detail.folderName, detail.subtitles).catch((err) => {
		console.error("[cd2-artplayer] 播放失败:", err);
	});
}

// ─── 弹幕 API 配置对话框 ────────────────────────────────

function showDanmuApiConfig() {
	const currentUrl = getApiUrl();

	const newUrl = prompt(
		"请输入弹幕 API 地址（含 token）：\n\n" +
			"支持自部署的 danmu_api 服务\n" +
			"(https://github.com/huangxd-/danmu_api)\n\n" +
			"格式示例：\n" +
			"  https://your-domain.netlify.app/87654321\n" +
			"  http://192.168.1.7:9321/87654321",
		currentUrl,
	);
	if (newUrl === null) return; // 取消

	setApiUrl(newUrl);

	if (newUrl) {
		alert("✅ 弹幕 API 地址已保存！刷新页面后生效。");
	} else {
		alert("⚠ API 地址为空，弹幕功能将不可用。");
	}
}

// ─── 脚本菜单 ────────────────────────────────────────────

function registerMenuCommands() {
	GM_registerMenuCommand("⚙ 弹幕 API 配置", showDanmuApiConfig);

	GM_registerMenuCommand(`🔄 弹幕模式: ${getDanmuModeLabel()}`, () => {
		const newMode = cycleDanmuMode();
		alert(`弹幕模式已切换为: ${getDanmuModeLabel(newMode)}\n\n下次播放时生效。`);
	});

	GM_registerMenuCommand("关闭播放器", () => {
		destroyPlayer();
	});

	GM_registerMenuCommand("测试播放（输入URL）", () => {
		const url = prompt("请输入视频URL:");
		if (!url) return;
		const fileName =
			prompt("请输入文件名（用于弹幕匹配）:", "test.mp4") || "test.mp4";
		openPlayer(url, fileName);
	});
}

// ─── 入口 ────────────────────────────────────────────────

(function main() {
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
	unsafeWindow.dispatchEvent(new CustomEvent("cd2-artplayer-ready"));
})();
