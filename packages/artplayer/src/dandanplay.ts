/**
 * 弹弹Play 开放平台 API 封装
 * https://api.dandanplay.net
 *
 * 接口列表：
 * - POST /api/v2/match   文件匹配
 * - GET  /api/v2/comment  获取弹幕
 * - GET  /api/v2/search/episodes  搜索剧集
 *
 * 认证方式（2025年起强制）：
 *   请求头须包含 X-AppId / X-Timestamp / X-Signature
 *   X-Signature = base64(sha256(AppId + Timestamp + Path + AppSecret))
 */

import {
	GM_xmlhttpRequest,
	GM_getValue,
	GM_setValue,
} from "vite-plugin-monkey/dist/client";

const API_BASE = "https://api.dandanplay.net";

// ─── 配置 ───────────────────────────────────────────────

const CONFIG_KEY_APPID = "dandanplay_appid";
const CONFIG_KEY_SECRET = "dandanplay_secret";

export function getAppId(): string {
	return (GM_getValue(CONFIG_KEY_APPID, "") as string).trim();
}
export function getAppSecret(): string {
	return (GM_getValue(CONFIG_KEY_SECRET, "") as string).trim();
}
export function setAppId(v: string) {
	GM_setValue(CONFIG_KEY_APPID, v.trim());
}
export function setAppSecret(v: string) {
	GM_setValue(CONFIG_KEY_SECRET, v.trim());
}
export function hasCredentials(): boolean {
	return getAppId().length > 0 && getAppSecret().length > 0;
}

// ─── 签名 ───────────────────────────────────────────────

async function sha256Base64(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(hash);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

async function buildAuthHeaders(path: string): Promise<Record<string, string>> {
	const appId = getAppId();
	const appSecret = getAppSecret();
	if (!appId || !appSecret) return {};

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = await sha256Base64(appId + timestamp + path + appSecret);

	return {
		"X-AppId": appId,
		"X-Timestamp": timestamp,
		"X-Signature": signature,
	};
}

// ─── Types ──────────────────────────────────────────────

export interface MatchResult {
	isMatched: boolean;
	matches: MatchItem[];
}

export interface MatchItem {
	episodeId: number;
	animeId: number;
	animeTitle: string;
	episodeTitle: string;
	type: string;
	typeDescription: string;
	shift: number;
}

export interface DanmakuComment {
	cid: number;
	/** "time,mode,color,uid" */
	p: string;
	m: string;
}

export interface CommentResponse {
	count: number;
	comments: DanmakuComment[];
}

export interface SearchEpisodeResult {
	animes: SearchAnime[];
	hasMore: boolean;
}

export interface SearchAnime {
	animeId: number;
	animeTitle: string;
	type: string;
	typeDescription: string;
	episodes: SearchEpisode[];
}

export interface SearchEpisode {
	episodeId: number;
	episodeTitle: string;
}

// ─── 弹幕格式（ArtPlayer danmuku 插件格式）─────────────

export interface ArtDanmaku {
	text: string;
	time: number;
	color: string;
	border: boolean;
	mode: 0 | 1 | 2; // 0=滚动 1=顶部 2=底部
}

// ─── GM_xmlhttpRequest Promise 封装 ────────────────────

function gmFetch<T>(
	url: string,
	options: {
		method?: string;
		body?: string;
		headers?: Record<string, string>;
	} = {},
): Promise<T> {
	return new Promise((resolve, reject) => {
		GM_xmlhttpRequest({
			method: (options.method || "GET") as "GET" | "POST",
			url,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				...options.headers,
			},
			data: options.body,
			onload(res) {
				if (res.status >= 200 && res.status < 300) {
					try {
						resolve(JSON.parse(res.responseText));
					} catch {
						reject(new Error("JSON解析失败"));
					}
				} else {
					reject(new Error(`HTTP ${res.status}: ${res.statusText}`));
				}
			},
			onerror(err) {
				reject(new Error(`网络错误: ${err.error || "unknown"}`));
			},
		});
	});
}

// ─── API 方法 ───────────────────────────────────────────

/**
 * 通过文件名匹配番剧信息
 */
export async function matchVideo(fileName: string): Promise<MatchResult> {
	const path = "/api/v2/match";
	const authHeaders = await buildAuthHeaders(path);
	return gmFetch<MatchResult>(`${API_BASE}${path}`, {
		method: "POST",
		headers: authHeaders,
		body: JSON.stringify({
			fileName,
			fileHash: "",
			fileSize: 0,
			videoDuration: 0,
			matchMode: "hashAndFileName",
		}),
	});
}

/**
 * 通过关键词搜索剧集
 */
export async function searchEpisodes(
	keyword: string,
): Promise<SearchEpisodeResult> {
	const path = "/api/v2/search/episodes";
	const authHeaders = await buildAuthHeaders(path);
	return gmFetch<SearchEpisodeResult>(
		`${API_BASE}${path}?anime=${encodeURIComponent(keyword)}`,
		{ headers: authHeaders },
	);
}

/**
 * 获取指定 episodeId 的弹幕
 * @param withRelated 是否包含第三方弹幕源
 */
export async function fetchComments(
	episodeId: number,
	withRelated = true,
): Promise<CommentResponse> {
	const path = `/api/v2/comment/${episodeId}`;
	const authHeaders = await buildAuthHeaders(path);
	return gmFetch<CommentResponse>(
		`${API_BASE}${path}?withRelated=${withRelated}`,
		{ headers: authHeaders },
	);
}

/**
 * 将弹弹Play弹幕转换为 ArtPlayer danmuku 插件格式
 */
export function convertToArtDanmaku(comments: DanmakuComment[]): ArtDanmaku[] {
	return comments.map((c) => {
		const parts = c.p.split(",");
		const time = parseFloat(parts[0]) || 0;
		const rawMode = parseInt(parts[1]) || 1;
		const colorNum = parseInt(parts[2]) || 16777215;

		// 弹弹Play mode: 1=普通 4=底部 5=顶部
		let mode: 0 | 1 | 2 = 0;
		if (rawMode === 5) mode = 1;
		else if (rawMode === 4) mode = 2;

		const color = `#${colorNum.toString(16).padStart(6, "0")}`;

		return { text: c.m, time, color, border: false, mode };
	});
}

/**
 * 完整弹幕加载流程：匹配 → 获取弹幕 → 转换格式
 */
export async function loadDanmaku(
	fileName: string,
): Promise<{ danmaku: ArtDanmaku[]; match: MatchItem } | null> {
	try {
		const result = await matchVideo(fileName);

		if (!result.isMatched || result.matches.length === 0) {
			console.log("[cd2-artplayer] 弹弹Play未匹配到结果:", fileName);
			return null;
		}

		const match = result.matches[0];
		console.log(
			`[cd2-artplayer] 匹配成功: ${match.animeTitle} - ${match.episodeTitle} (episodeId: ${match.episodeId})`,
		);

		const comments = await fetchComments(match.episodeId);
		console.log(`[cd2-artplayer] 获取弹幕 ${comments.count} 条`);

		const danmaku = convertToArtDanmaku(comments.comments);
		return { danmaku, match };
	} catch (err) {
		console.error("[cd2-artplayer] 弹幕加载失败:", err);
		return null;
	}
}
