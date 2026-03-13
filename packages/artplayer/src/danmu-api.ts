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

/** 弹弹Play公开代理地址（直连，无需认证） */
const DANDANPLAY_PROXY = "https://api.danmaku.weeblify.app/ddp/v1";
/** 直连请求超时（毫秒） */
const DIRECT_TIMEOUT_MS = 8000;

export function getApiUrl(): string {
	return (GM_getValue(CONFIG_KEY_API_URL, DEFAULT_API_URL) as string).trim().replace(/\/+$/, "");
}

export function setApiUrl(v: string) {
	GM_setValue(CONFIG_KEY_API_URL, v.trim().replace(/\/+$/, ""));
}

export function hasApiUrl(): boolean {
	return getApiUrl().length > 0;
}

// ─── 匹配模式 ───────────────────────────────────────────

/** 弹幕匹配模式: auto=直连优先自动回退 | direct=仅直连 | api=仅API */
export type DanmuMode = "auto" | "direct" | "api";

const CONFIG_KEY_DANMU_MODE = "danmu_mode";

const MODE_LABELS: Record<DanmuMode, string> = {
	auto: "自动（直连优先）",
	direct: "仅直连",
	api: "仅API",
};

export function getDanmuMode(): DanmuMode {
	const v = GM_getValue(CONFIG_KEY_DANMU_MODE, "auto") as string;
	if (v === "direct" || v === "api") return v;
	return "auto";
}

export function setDanmuMode(mode: DanmuMode) {
	GM_setValue(CONFIG_KEY_DANMU_MODE, mode);
}

export function getDanmuModeLabel(mode?: DanmuMode): string {
	return MODE_LABELS[mode ?? getDanmuMode()];
}

/** 循环切换到下一个模式 */
export function cycleDanmuMode(): DanmuMode {
	const order: DanmuMode[] = ["auto", "direct", "api"];
	const cur = getDanmuMode();
	const next = order[(order.indexOf(cur) + 1) % order.length];
	setDanmuMode(next);
	return next;
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
		timeout?: number;
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
			timeout: options.timeout,
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
			ontimeout() {
				reject(new Error("请求超时"));
			},
		});
	});
}

/** 
 * 提供给 @cryguy/mkv-subtitle-extractor 等第三方库使用的标准 fetch 适配器
 * 拦截请求交由 GM_xmlhttpRequest 处理以避开 CORS 限制，支持 ArrayBuffer 返回
 */
export function gmFetchAdapter(url: string | URL | Request, options?: RequestInit): Promise<Response> {
	const targetUrl = typeof url === 'string' ? url : (url as URL).href || (url as Request).url;
	return new Promise((resolve, reject) => {
		// 转换传入的 headers (可能是 Headers 对象，或者是 Record)
		const reqHeaders: Record<string, string> = {};
		if (options?.headers) {
			if (options.headers instanceof Headers) {
				options.headers.forEach((value, key) => {
					reqHeaders[key] = value;
				});
			} else {
				Object.assign(reqHeaders, options.headers);
			}
		}

		console.log(`[cd2-gmFetchAdapter] 发起请求: ${targetUrl}`, reqHeaders);

		GM_xmlhttpRequest({
			method: (options?.method || "GET") as any,
			url: targetUrl,
			headers: reqHeaders,
			data: options?.body as any,
			responseType: "arraybuffer",
			onload(res) {
				const responseHeaders = new Headers();
				let hasContentRange = false;
				let contentLength = -1;
				
				if (res.responseHeaders) {
					// GM_xmlhttpRequest 的 responseHeaders 通常是 \r\n 分隔的纯文本
					res.responseHeaders.split(/\r?\n/).forEach(line => {
						if (!line.trim()) return;
						const index = line.indexOf(":");
						if (index > 0) {
							const key = line.substring(0, index).trim();
							const val = line.substring(index + 1).trim();
							responseHeaders.append(key, val);
							if (key.toLowerCase() === 'content-range') hasContentRange = true;
							if (key.toLowerCase() === 'content-length') contentLength = parseInt(val, 10);
						}
					});
				}

				let buf = res.response as ArrayBuffer;
				if (buf && contentLength !== -1 && buf.byteLength > contentLength) {
					// 如果浏览器自动解压或读取了多余的 Buffer，强制截断
					buf = buf.slice(0, contentLength);
				}

				console.log(`[cd2-gmFetchAdapter] 收到响应: ${res.status} byteLength=${buf ? buf.byteLength : 0} Content-Range=${hasContentRange}`);

				// 重要：mkv-subtitle-extractor 严格要求 206 状态码才认为支持 Range
				// 阿里云盘/网盘直链有时候返回 200 但其实带了 Content-Range，我们强制重置为 206
				const status = (hasContentRange && res.status === 200) ? 206 : res.status;

				const response = new Response(buf, {
					status: status,
					statusText: res.statusText,
					headers: responseHeaders,
				});
				resolve(response);
			},
			onerror(err) {
				reject(new Error(`Fetch error: ${err.error}`));
			},
			ontimeout() {
				reject(new Error("Fetch timeout"));
			}
		});
	});
}

// ═══════════════════════════════════════════════════════════
// danmu_api 服务 API 方法（通过自部署服务，后备方案）
// ═══════════════════════════════════════════════════════════

/**
 * 通过文件名匹配番剧信息（danmu_api服务）
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
 * 通过关键词搜索剧集（danmu_api服务）
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
 * 获取指定 episodeId 的弹幕（danmu_api服务）
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
 * 完整弹幕加载流程：匹配 → 获取弹幕 → 转换格式（danmu_api服务）
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

// ═══════════════════════════════════════════════════════════
// 直连弹弹Play代理 API 方法（优先方案，无需自部署服务）
// ═══════════════════════════════════════════════════════════

/** 弹弹Play代理返回的包裹结构 */
interface DandanProxyResponse<T> {
	data: T;
}

/**
 * 直连弹弹Play代理：通过文件名匹配番剧信息
 */
export async function directMatchVideo(fileName: string): Promise<MatchResult> {
	const body = JSON.stringify({
		fileName,
		fileHash: "",
		fileSize: 0,
		videoDuration: 0,
		matchMode: "hashAndFileName",
	});
	// 弹弹Play match 是 POST 接口，代理使用 path 参数
	const resp = await gmFetch<MatchResult>(
		`${DANDANPLAY_PROXY}?path=/v2/match`,
		{
			method: "POST",
			body,
			timeout: DIRECT_TIMEOUT_MS,
		},
	);
	return resp;
}

/**
 * 直连弹弹Play代理：通过关键词搜索剧集
 */
export async function directSearchEpisodes(
	keyword: string,
): Promise<SearchEpisodeResult> {
	const resp = await gmFetch<SearchEpisodeResult>(
		`${DANDANPLAY_PROXY}?path=/v2/search/episodes?anime=${encodeURIComponent(keyword)}`,
		{ timeout: DIRECT_TIMEOUT_MS },
	);
	return resp;
}

/**
 * 直连弹弹Play代理：获取指定 episodeId 的弹幕
 */
export async function directFetchComments(
	episodeId: number,
	withRelated = true,
): Promise<CommentResponse> {
	const resp = await gmFetch<CommentResponse>(
		`${DANDANPLAY_PROXY}?path=/v2/comment/${episodeId}?from=0&withRelated=${withRelated}&chConvert=0`,
		{ timeout: DIRECT_TIMEOUT_MS },
	);
	return resp;
}
