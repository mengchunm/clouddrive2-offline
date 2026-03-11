/**
 * danmu_api 弹幕服务 API 封装
 * https://github.com/huangxd-/danmu_api
 *
 * 兼容弹弹Play接口规范，聚合多源弹幕（B站/爱奇艺/腾讯/优酷/芒果等）
 *
 * 接口列表：
 * - POST /api/v2/match              文件匹配
 * - GET  /api/v2/search/episodes    搜索剧集
 * - GET  /api/v2/search/anime       搜索番剧
 * - GET  /api/v2/comment/:commentId 获取弹幕
 *
 * 认证方式：API 地址中包含 token（默认 87654321）
 */

import {
	GM_getValue,
	GM_setValue,
	GM_xmlhttpRequest,
} from "vite-plugin-monkey/dist/client";

// ─── 配置 ───────────────────────────────────────────────

const CONFIG_KEY_API_URL = "danmu_api_url";
const DEFAULT_API_URL = "https://clouddrive2.netlify.app/87076677";

export function getApiUrl(): string {
	return (GM_getValue(CONFIG_KEY_API_URL, DEFAULT_API_URL) as string).trim().replace(/\/+$/, "");
}

export function setApiUrl(v: string) {
	GM_setValue(CONFIG_KEY_API_URL, v.trim().replace(/\/+$/, ""));
}

export function hasApiUrl(): boolean {
	return getApiUrl().length > 0;
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
	const apiUrl = getApiUrl();
	return gmFetch<MatchResult>(`${apiUrl}/api/v2/match`, {
		method: "POST",
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
	const apiUrl = getApiUrl();
	return gmFetch<SearchEpisodeResult>(
		`${apiUrl}/api/v2/search/episodes?anime=${encodeURIComponent(keyword)}`,
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
	const apiUrl = getApiUrl();
	return gmFetch<CommentResponse>(
		`${apiUrl}/api/v2/comment/${episodeId}?withRelated=${withRelated}&format=json`,
	);
}

/**
 * 将弹幕转换为 ArtPlayer danmuku 插件格式
 * 弹幕 p 字段格式（兼容弹弹Play）: "time,mode,color,uid"
 * mode: 1=普通滚动 4=底部 5=顶部
 */
export function convertToArtDanmaku(comments: DanmakuComment[]): ArtDanmaku[] {
	return comments.map((c) => {
		const parts = c.p.split(",");
		const time = parseFloat(parts[0]) || 0;
		const rawMode = parseInt(parts[1], 10) || 1;
		const colorNum = parseInt(parts[2], 10) || 16777215;

		// mode: 1=普通 4=底部 5=顶部
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
			console.log("[cd2-artplayer] 弹幕API未匹配到结果:", fileName);
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
