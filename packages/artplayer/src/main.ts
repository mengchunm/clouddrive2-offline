/**
 * clouddrive2-artplayer 油猴脚本入口
 *
 * 监听来自 clouddrive2-offline 的播放事件，
 * 打开 ArtPlayer 播放器并自动加载弹弹Play弹幕。
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
	getAppId,
	getAppSecret,
	hasCredentials,
	setAppId,
	setAppSecret,
} from "./dandanplay";
import { destroyPlayer, openPlayer } from "./player";

// ─── 播放事件类型定义 ────────────────────────────────────

export interface PlayVideoDetail {
	fileName: string;
	filePath?: string;
	videoUrl: string;
	grpcBaseUrl?: string;
	apiToken?: string;
}

// ─── 事件监听 ────────────────────────────────────────────

function handlePlayVideo(e: CustomEvent<PlayVideoDetail>) {
	const detail = e.detail;
	if (!detail?.fileName || !detail?.videoUrl) {
		console.warn("[cd2-artplayer] 播放事件缺少 fileName 或 videoUrl");
		return;
	}

	console.log("[cd2-artplayer] 收到播放请求:", detail.fileName);

	openPlayer(detail.videoUrl, detail.fileName).catch((err) => {
		console.error("[cd2-artplayer] 播放失败:", err);
	});
}

// ─── 弹弹Play 配置对话框 ────────────────────────────────

function showDandanPlayConfig() {
	const currentAppId = getAppId();
	const currentSecret = getAppSecret();

	const newAppId = prompt(
		"请输入弹弹Play AppId：\n\n" +
			"（需要先向 kaedei@dandanplay.net 发邮件申请）\n" +
			"邮件主题：弹弹play开放平台申请\n" +
			"邮件内容需包含：应用名称、应用描述、联系方式",
		currentAppId,
	);
	if (newAppId === null) return; // 取消

	const newSecret = prompt("请输入弹弹Play AppSecret：", currentSecret);
	if (newSecret === null) return;

	setAppId(newAppId);
	setAppSecret(newSecret);

	if (newAppId && newSecret) {
		alert("✅ 弹弹Play 配置已保存！刷新页面后生效。");
	} else {
		alert("⚠ AppId 或 AppSecret 为空，弹幕功能将不可用。");
	}
}

// ─── 脚本菜单 ────────────────────────────────────────────

function registerMenuCommands() {
	GM_registerMenuCommand("⚙ 弹弹Play API 配置", showDandanPlayConfig);

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

	// 检查弹弹Play配置
	if (!hasCredentials()) {
		console.warn(
			"[cd2-artplayer] 未配置弹弹Play AppId/AppSecret，弹幕功能不可用。请通过油猴菜单配置。",
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
