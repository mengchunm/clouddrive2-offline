/**
 * ArtPlayer 播放器模块
 * 弹幕搜索集成到 ArtPlayer 控制栏
 */

import {
	extractSubtitles,
	type TrackResult,
} from "@cryguy/mkv-subtitle-extractor";
import Artplayer from "artplayer";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import artplayerPluginAss from "artplayer-plugin-libass";
import { GM_getValue, GM_setValue } from "vite-plugin-monkey/dist/client";
import {
	BrowserAudioFallback,
	preloadBrowserAudioFallback,
	takeBrowserAudioFallbackPreparation,
} from "./audioFallback";
import {
	type ArtDanmaku,
	convertToArtDanmaku,
	cycleDanmuMode,
	directFetchComments,
	directMatchVideo,
	directSearchEpisodes,
	fetchComments,
	getDanmuMode,
	getDanmuModeLabel,
	gmFetchAdapter,
	hasApiUrl,
	type MatchItem,
	matchVideo,
	type SearchAnime,
	searchEpisodes,
} from "./danmu-api";
import { playlistMemory, subtitleMemory, videoMemory } from "./memory";
import { assToWebVtt } from "./utils/assToVtt";
import { extractKeyword, findBestEpisode } from "./utils/danmuMatch";
import { getMediaIdentity, isMkvMedia } from "./utils/mediaIdentity";
import { readMkvSubtitleTracks } from "./utils/mkvMetadata";
import { extractMp4Subtitle } from "./utils/mp4Parser";

// ─── 共享状态与常量 ──────────────────────────────────────────

let currentPlayer: Artplayer | null = null;
let overlayEl: HTMLDivElement | null = null;
let _focusBeforePlayer: HTMLElement | null = null;
let _saveProgressBeforeDestroy: (() => void) | null = null;
let _cleanupBeforeDestroy: (() => void) | null = null;
let _cleanupFloatingWindow: (() => void) | null = null;
let _getCurrentPlayerWindowLayout: (() => PlayerWindowLayout) | null = null;

const Win = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

/** userscript 使用 CDN；扩展使用随包分发的 worker/WASM/字体，避免远程代码与页面 CSP。 */
const LIBASS_CDN_BASE =
	"https://fastly.jsdelivr.net/npm/libass-wasm@4.1.0/dist";
const extensionRuntime = (
	globalThis as typeof globalThis & {
		chrome?: {
			runtime?: {
				id?: string;
				getURL?: (path: string) => string;
				sendMessage?: <TResponse>(message: unknown) => Promise<TResponse>;
			};
		};
	}
).chrome?.runtime;
declare const __CD2_EXTENSION_BUILD__: boolean;
const isExtensionBuild =
	typeof __CD2_EXTENSION_BUILD__ !== "undefined" && __CD2_EXTENSION_BUILD__;

function isCanceledExtensionRequest(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /extension context invalidated|扩展上下文已失效|message channel closed|asynchronous response|operation canceled/i.test(
		message,
	);
}

const extensionAsset = (path: string, fallback: string) =>
	isExtensionBuild ? (extensionRuntime?.getURL?.(path) ?? path) : fallback;
const LIBASS_WORKER_SCRIPT_URL = extensionAsset(
	"libass/subtitles-octopus-worker.js",
	`${LIBASS_CDN_BASE}/js/subtitles-octopus-worker.js`,
);
const LIBASS_WASM_URL = extensionAsset(
	"libass/subtitles-octopus-worker.wasm",
	`${LIBASS_CDN_BASE}/js/subtitles-octopus-worker.wasm`,
);
const LIBASS_FALLBACK_FONT = extensionAsset(
	"libass/NotoSansSC-VF.ttf",
	"https://fastly.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf",
);

const SUBTITLE_ICON =
	'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6H20C21.1 6 22 6.9 22 8V16C22 17.1 21.1 18 20 18H4C2.9 18 2 17.1 2 16V8C2 6.9 2.9 6 4 6ZM4 16H20V8H4V16ZM7 11H9V13H7V11ZM11 11H17V13H11V11Z" fill="currentColor"/></svg>';

export interface SubtitleItem {
	url: string;
	fileName: string;
	isLocal?: boolean; // 如果是外挂字幕则为 true
	ext?: string;
	mkvTrackId?: number; // MKV 轨道 ID
	mkvSubtitleIndex?: number; // MKV 字幕轨道在字幕流中的顺序
	isDeferred?: boolean; // 是否是延迟加载（内嵌字幕）
	isDefault?: boolean;
	isForced?: boolean;
}

interface AssPluginLike {
	hide?(): void;
	show?(): void;
	readonly rendered?: boolean;
	ready?(): Promise<void>;
	switch?(url: string, content?: string): void | Promise<void>;
}

interface DanmukuPluginLike {
	config(
		options: { danmuku?: ArtDanmaku[] } & Partial<DanmakuPreferences>,
	): void;
	load(): void;
	option?: DanmakuPreferences;
}

interface SubtitleSelectorItem {
	html: string;
	url: string;
	ext?: string;
	isNativeType?: boolean;
	mkvTrackId?: number;
	mkvSubtitleIndex?: number;
	isDeferred?: boolean;
	isDefault?: boolean;
	isForced?: boolean;
}

interface PlaylistSelectorItem {
	html: string;
	fileName: string;
	filePath: string;
}

interface VideoDecoderSelectorItem {
	html: string;
	mode: VideoDecoderMode;
}

interface AudioTrackSelectorItem {
	html: string;
	index: number;
}

interface AudioTrackLike {
	id?: string;
	label?: string;
	language?: string;
	enabled: boolean;
}

interface AudioTrackListLike {
	length: number;
	[index: number]: AudioTrackLike;
}

let _currentSubtitles: SubtitleItem[] = [];
let _mkvExtractedSubs: SubtitleItem[] = [];
const _blobUrlExtCache = new Map<string, string>();
const _externalSubtitleBlobUrls = new Map<string, string>();
const _assSubtitleContentCache = new Map<string, string>();
const _assFallbackBlobUrls = new Map<string, string>();
let _mkvExtractionPromise: Promise<TrackResult[]> | null = null;
let _playerSessionNonce = 0;
let _activeLibavExtractRequestId: string | null = null;
let _currentSubtitleVideoKey = "";
let _currentSubtitleIdentity: string | null = null;
let _pendingSubtitleIdentity: string | null = null;
let _autoSubtitleActivationBarrier: Promise<void> = Promise.resolve();

interface ActiveLibavSubtitle {
	player: Artplayer;
	sessionNonce: number;
	subtitleIndex: number;
	format: "ass" | "vtt";
	item: SubtitleSelectorItem;
	url: string;
	content: string;
	ranges: Array<{ start: number; end: number }>;
	loading: boolean;
	requestNonce: number;
}

let _activeLibavSubtitle: ActiveLibavSubtitle | null = null;

const CONTAINER_ID = "cd2-artplayer-container";
const OVERLAY_ID = "cd2-artplayer-overlay";
const OVERLAY_TITLE_ID = "cd2-artplayer-title";
const NETWORK_SPEED_ID = "cd2-player-network-speed";
const DANMAKU_PANEL_ID = "cd2-danmaku-panel";
const DANMAKU_PANEL_TITLE_ID = "cd2-danmaku-panel-title";
const SHOW_DANMAKU_HEATMAP_KEY = "cd2_show_danmaku_heatmap";
const DANMAKU_PREFERENCES_KEY = "cd2_danmaku_preferences_v1";
const PLAYER_PREFERENCES_KEY = "cd2_player_preferences_v1";
const PLAYER_WINDOW_LAYOUT_KEY = "cd2_player_window_layout_v2";
const PLAYER_RELOAD_SESSION_KEY = "cd2_player_reload_session_v1";
const PLAYER_WINDOW_MARGIN = 12;
const DEFAULT_PLAYER_ASPECT_RATIO = 16 / 9;
const MIN_PLAYER_WINDOW_WIDTH = 480;
const MIN_PLAYER_WINDOW_HEIGHT = 270;
const NETWORK_SPEED_SAMPLE_INTERVAL_MS = 200;
const NETWORK_SPEED_SAMPLE_WINDOW_MS = 2000;
const NETWORK_SPEED_MIN_SAMPLE_ELAPSED_MS = 200;
const NETWORK_SPEED_STALE_AFTER_MS = 1000;

function queryRequired<T extends Element>(
	root: ParentNode,
	selector: string,
): T {
	const element = root.querySelector<T>(selector);
	if (!element) throw new Error(`播放器界面缺少元素: ${selector}`);
	return element;
}

function subtitleIdentity(item: SubtitleSelectorItem): string {
	if (!item.url && !item.mkvTrackId) return "off";
	if (item.mkvTrackId !== undefined) return `mkv:${item.mkvTrackId}`;
	if (item.isNativeType) return `native:${item.html}`;
	return `external:${item.html}`;
}

function isForcedSubtitle(item: SubtitleSelectorItem): boolean {
	return item.isForced === true || /forced|强制/i.test(item.html);
}

function autoSubtitleScore(item: SubtitleSelectorItem): number {
	let score = 0;
	if (!item.mkvTrackId && !item.isNativeType) score += 500;
	if (item.isDefault) score += 120;
	if (/中文|简体|繁体|\b(?:chi|zho|zh|chs|cht|sc|tc)\b/i.test(item.html))
		score += 80;
	else if (/\beng(?:lish)?\b/i.test(item.html)) score += 40;
	if (/\bcc\b|sdh/i.test(item.html)) score -= 10;
	if (isForcedSubtitle(item)) score -= 1000;
	return score;
}

function settleWithin(
	promise: Promise<unknown>,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutId);
			resolve();
		};
		const timeoutId = window.setTimeout(settle, timeoutMs);
		void promise.then(settle, settle);
	});
}

interface PlayerWindowLayout {
	left: number;
	top: number;
	width: number;
	height: number;
}

function clampPlayerWindowLayout(
	layout: Partial<PlayerWindowLayout>,
	aspectRatio = DEFAULT_PLAYER_ASPECT_RATIO,
): PlayerWindowLayout {
	const ratio =
		Number.isFinite(aspectRatio) && aspectRatio > 0
			? aspectRatio
			: DEFAULT_PLAYER_ASPECT_RATIO;
	const availableWidth = Math.max(
		1,
		window.innerWidth - PLAYER_WINDOW_MARGIN * 2,
	);
	const availableHeight = Math.max(
		1,
		window.innerHeight - PLAYER_WINDOW_MARGIN * 2,
	);
	const maxWidth = availableWidth;
	const maxHeight = availableHeight;
	const preferredWidth = Number.isFinite(layout.width)
		? (layout.width ?? 720)
		: Number.isFinite(layout.height)
			? (layout.height ?? 405) * ratio
			: 720;
	const preferredHeight = Number.isFinite(layout.height)
		? (layout.height ?? 405)
		: preferredWidth / ratio;
	const minWidth = Math.min(maxWidth, MIN_PLAYER_WINDOW_WIDTH);
	const minHeight = Math.min(maxHeight, MIN_PLAYER_WINDOW_HEIGHT);
	const width = Math.min(maxWidth, Math.max(minWidth, preferredWidth));
	const height = Math.min(maxHeight, Math.max(minHeight, preferredHeight));
	return {
		left: Math.min(
			Math.max(
				PLAYER_WINDOW_MARGIN,
				Number.isFinite(layout.left) ? (layout.left ?? 0) : 0,
			),
			Math.max(
				PLAYER_WINDOW_MARGIN,
				window.innerWidth - width - PLAYER_WINDOW_MARGIN,
			),
		),
		top: Math.min(
			Math.max(
				PLAYER_WINDOW_MARGIN,
				Number.isFinite(layout.top) ? (layout.top ?? 0) : 0,
			),
			Math.max(
				PLAYER_WINDOW_MARGIN,
				window.innerHeight - height - PLAYER_WINDOW_MARGIN,
			),
		),
		width,
		height,
	};
}

function getPlayerWindowLayout(
	aspectRatio = DEFAULT_PLAYER_ASPECT_RATIO,
): PlayerWindowLayout {
	const availableWidth = Math.max(
		1,
		window.innerWidth - PLAYER_WINDOW_MARGIN * 2,
	);
	const availableHeight = Math.max(
		1,
		window.innerHeight - PLAYER_WINDOW_MARGIN * 2,
	);
	const width = Math.min(720, availableWidth, availableHeight * aspectRatio);
	const height = Math.min(availableHeight, width / aspectRatio);
	const fallback = {
		left: window.innerWidth - width - PLAYER_WINDOW_MARGIN,
		top: window.innerHeight - height - PLAYER_WINDOW_MARGIN,
		width,
		height,
	};
	const stored = GM_getValue<Partial<PlayerWindowLayout> | null>(
		PLAYER_WINDOW_LAYOUT_KEY,
		null,
	);
	return clampPlayerWindowLayout(
		stored && typeof stored === "object" ? stored : fallback,
		aspectRatio,
	);
}

function savePlayerWindowLayout(layout: PlayerWindowLayout): void {
	GM_setValue(PLAYER_WINDOW_LAYOUT_KEY, layout);
}

interface DanmakuPreferences {
	speed: number;
	opacity: number;
	fontSize: number | `${number}%`;
	margin: [number | `${number}%`, number | `${number}%`];
	antiOverlap: boolean;
	synchronousPlayback: boolean;
	modes: Array<0 | 1 | 2>;
	visible: boolean;
	color: string;
	mode: 0 | 1 | 2;
}

type VideoDecoderMode = "native" | "software" | "hardware";

interface PlayerPreferences {
	volume: number;
	muted: boolean;
	playbackRate: number;
	aspectRatio: "default" | `${number}:${number}`;
	videoDecoder: VideoDecoderMode;
}

interface PlayerRestoreState {
	time: number;
	wasPlaying: boolean;
	volume?: number;
	muted?: boolean;
	playbackRate?: number;
	aspectRatio?: PlayerPreferences["aspectRatio"];
	windowLayout?: PlayerWindowLayout;
}

interface PlayerReloadSession extends PlayerRestoreState {
	version: 1;
	pageUrl: string;
	updatedAt: number;
	url: string;
	fileName: string;
	filePath?: string;
	title?: string;
	playlist?: { fileName: string; filePath: string }[];
	currentIndex?: number;
	folderName?: string;
	subtitles?: SubtitleItem[];
	fileSize?: number;
}

let _activePlayerReloadSession: PlayerReloadSession | null = null;

function clearPlayerReloadSession(): void {
	_activePlayerReloadSession = null;
	try {
		Win.sessionStorage.removeItem(PLAYER_RELOAD_SESSION_KEY);
	} catch {
		// 某些受限页面不允许访问 sessionStorage；不影响正常播放。
	}
}

function writePlayerReloadSession(session: PlayerReloadSession): void {
	_activePlayerReloadSession = session;
	try {
		Win.sessionStorage.setItem(
			PLAYER_RELOAD_SESSION_KEY,
			JSON.stringify(session),
		);
	} catch {
		// 播放列表过大时退化为保存当前文件，仍可恢复窗口和播放进度。
		const minimalSession: PlayerReloadSession = {
			version: 1,
			pageUrl: session.pageUrl,
			updatedAt: session.updatedAt,
			url: session.url,
			fileName: session.fileName,
			filePath: session.filePath,
			title: session.title,
			time: session.time,
			wasPlaying: session.wasPlaying,
			volume: session.volume,
			muted: session.muted,
			playbackRate: session.playbackRate,
			aspectRatio: session.aspectRatio,
			windowLayout: session.windowLayout,
		};
		_activePlayerReloadSession = minimalSession;
		try {
			Win.sessionStorage.setItem(
				PLAYER_RELOAD_SESSION_KEY,
				JSON.stringify(minimalSession),
			);
		} catch {
			// ignore
		}
	}
}

function persistActivePlayerReloadSession(): void {
	if (!_activePlayerReloadSession) return;
	const time = currentPlayer?.currentTime;
	writePlayerReloadSession({
		..._activePlayerReloadSession,
		updatedAt: Date.now(),
		time:
			typeof time === "number" && Number.isFinite(time) && time >= 0
				? time
				: _activePlayerReloadSession.time,
		wasPlaying: currentPlayer
			? !currentPlayer.video.paused
			: _activePlayerReloadSession.wasPlaying,
		volume: currentPlayer?.volume ?? _activePlayerReloadSession.volume,
		muted: currentPlayer?.muted ?? _activePlayerReloadSession.muted,
		playbackRate:
			currentPlayer?.playbackRate ?? _activePlayerReloadSession.playbackRate,
		aspectRatio:
			(currentPlayer?.aspectRatio as
				| PlayerPreferences["aspectRatio"]
				| undefined) ?? _activePlayerReloadSession.aspectRatio,
		windowLayout:
			_getCurrentPlayerWindowLayout?.() ??
			_activePlayerReloadSession.windowLayout,
	});
}

function readPlayerReloadSession(): PlayerReloadSession | null {
	try {
		const raw = Win.sessionStorage.getItem(PLAYER_RELOAD_SESSION_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<PlayerReloadSession>;
		if (
			value.version !== 1 ||
			typeof value.pageUrl !== "string" ||
			typeof value.url !== "string" ||
			typeof value.fileName !== "string" ||
			typeof value.time !== "number" ||
			typeof value.wasPlaying !== "boolean"
		) {
			clearPlayerReloadSession();
			return null;
		}
		return value as PlayerReloadSession;
	} catch {
		clearPlayerReloadSession();
		return null;
	}
}

const DEFAULT_DANMAKU_PREFERENCES: DanmakuPreferences = {
	speed: 5,
	opacity: 1,
	fontSize: 25,
	margin: [10, "25%"],
	antiOverlap: true,
	synchronousPlayback: false,
	modes: [0, 1, 2],
	visible: true,
	color: "#FFFFFF",
	mode: 0,
};

function getDanmakuPreferences(): DanmakuPreferences {
	const stored = GM_getValue<Partial<DanmakuPreferences> | null>(
		DANMAKU_PREFERENCES_KEY,
		null,
	);
	if (!stored || typeof stored !== "object") {
		return { ...DEFAULT_DANMAKU_PREFERENCES };
	}
	const result = { ...DEFAULT_DANMAKU_PREFERENCES };
	if (
		typeof stored.speed === "number" &&
		stored.speed >= 1 &&
		stored.speed <= 10
	)
		result.speed = stored.speed;
	if (
		typeof stored.opacity === "number" &&
		stored.opacity >= 0 &&
		stored.opacity <= 1
	)
		result.opacity = stored.opacity;
	if (
		typeof stored.fontSize === "number" ||
		(typeof stored.fontSize === "string" && stored.fontSize.endsWith("%"))
	)
		result.fontSize = stored.fontSize;
	if (Array.isArray(stored.margin) && stored.margin.length === 2)
		result.margin = stored.margin;
	if (typeof stored.antiOverlap === "boolean")
		result.antiOverlap = stored.antiOverlap;
	if (typeof stored.synchronousPlayback === "boolean")
		result.synchronousPlayback = stored.synchronousPlayback;
	if (Array.isArray(stored.modes)) {
		const modes = stored.modes.filter(
			(mode): mode is 0 | 1 | 2 => mode === 0 || mode === 1 || mode === 2,
		);
		if (modes.length > 0) result.modes = modes;
	}
	if (typeof stored.visible === "boolean") result.visible = stored.visible;
	if (typeof stored.color === "string") result.color = stored.color;
	if (stored.mode === 0 || stored.mode === 1 || stored.mode === 2)
		result.mode = stored.mode;
	return result;
}

function saveDanmakuPreferences(option: unknown): void {
	if (!option || typeof option !== "object") return;
	const value = option as Partial<DanmakuPreferences>;
	const current = getDanmakuPreferences();
	GM_setValue(DANMAKU_PREFERENCES_KEY, {
		speed: value.speed ?? current.speed,
		opacity: value.opacity ?? current.opacity,
		fontSize: value.fontSize ?? current.fontSize,
		margin: value.margin ?? current.margin,
		antiOverlap: value.antiOverlap ?? current.antiOverlap,
		synchronousPlayback:
			value.synchronousPlayback ?? current.synchronousPlayback,
		modes: value.modes ?? current.modes,
		visible: value.visible ?? current.visible,
		color: value.color ?? current.color,
		mode: value.mode ?? current.mode,
	} satisfies DanmakuPreferences);
}

function getPlayerPreferences(): PlayerPreferences {
	const stored = GM_getValue<Partial<PlayerPreferences> | null>(
		PLAYER_PREFERENCES_KEY,
		null,
	);
	const videoDecoder: VideoDecoderMode =
		stored?.videoDecoder === "native" ||
		stored?.videoDecoder === "hardware" ||
		stored?.videoDecoder === "software"
			? stored.videoDecoder
			: "software";
	return {
		volume:
			typeof stored?.volume === "number" &&
			stored.volume >= 0 &&
			stored.volume <= 1
				? stored.volume
				: 0.8,
		muted: typeof stored?.muted === "boolean" ? stored.muted : false,
		playbackRate:
			typeof stored?.playbackRate === "number" && stored.playbackRate > 0
				? stored.playbackRate
				: 1,
		aspectRatio:
			typeof stored?.aspectRatio === "string" &&
			/^(?:default|\d+(?:[.]\d+)?:\d+(?:[.]\d+)?)$/.test(stored.aspectRatio)
				? (stored.aspectRatio as PlayerPreferences["aspectRatio"])
				: "default",
		videoDecoder,
	};
}

// ─── 样式 ────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById("cd2-artplayer-styles")) return;
	const style = document.createElement("style");
	style.id = "cd2-artplayer-styles";
	style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; z-index: 2147483647;
      display: block; overflow: hidden;
      background: #000; border: 1px solid rgba(255,255,255,0.18);
      box-shadow: 0 16px 48px rgba(0,0,0,0.48), 0 2px 10px rgba(0,0,0,0.35);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    #${OVERLAY_ID} .cd2-player-header {
      position: absolute; top: 0; left: 0; right: 0; height: 40px; min-width: 0;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 0 18px; z-index: 115;
      background: linear-gradient(180deg, rgba(0,0,0,0.82), rgba(0,0,0,0));
      cursor: grab; user-select: none; touch-action: none;
      opacity: 0; transform: translateY(-8px); pointer-events: none;
      transition: opacity .2s ease, transform .2s ease;
    }
    #${OVERLAY_ID} .cd2-player-header.cd2-player-header-visible,
    #${OVERLAY_ID} .cd2-player-header:focus-within {
      opacity: 1; transform: translateY(0); pointer-events: auto;
    }
    #${OVERLAY_ID}.cd2-player-window-dragging .cd2-player-header { cursor: grabbing; }
    #${OVERLAY_ID} .cd2-player-title {
      flex: 1; min-width: 0; font-size: 13px; opacity: 0.9;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${OVERLAY_ID} .cd2-player-close {
      width: 28px; height: 28px; display: grid; place-items: center;
      background: none; border: none; border-radius: 5px; color: #fff; font-size: 18px;
      cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.2s, background 0.2s; flex-shrink: 0;
    }
    #${OVERLAY_ID} .cd2-player-close:hover { opacity: 1; background: rgba(255,255,255,0.12); }
    #${OVERLAY_ID} .cd2-player-close:focus-visible {
      opacity: 1; outline: 2px solid #58a6ff; outline-offset: 2px;
    }
    #${CONTAINER_ID} { width: 100%; height: 100%; min-height: 0; }
    #${CONTAINER_ID} .art-loading { flex-direction: column; gap: 8px; }
    #${CONTAINER_ID} .cd2-player-network-speed {
      display: none; color: rgba(255,255,255,.9); font-size: 12px;
      line-height: 1.35; font-variant-numeric: tabular-nums;
      pointer-events: none; user-select: none;
    }
    #${CONTAINER_ID} .cd2-player-network-speed.cd2-player-network-speed-visible {
      display: block;
    }
    #${CONTAINER_ID} .art-video-player { container-type: inline-size; }
    #${OVERLAY_ID} .cd2-player-resize-handle { position: absolute; z-index: 130; touch-action: none; }
    #${OVERLAY_ID} .cd2-player-resize-edge { z-index: 129; }
    #${OVERLAY_ID} .cd2-player-resize-top { top: 0; left: 18px; right: 18px; height: 8px; cursor: ns-resize; }
    #${OVERLAY_ID} .cd2-player-resize-right { top: 18px; right: 0; bottom: 18px; width: 8px; cursor: ew-resize; }
    #${OVERLAY_ID} .cd2-player-resize-bottom { right: 18px; bottom: 0; left: 18px; height: 8px; cursor: ns-resize; }
    #${OVERLAY_ID} .cd2-player-resize-left { top: 18px; bottom: 18px; left: 0; width: 8px; cursor: ew-resize; }
    #${OVERLAY_ID} .cd2-player-resize-corner { width: 18px; height: 18px; }
    #${OVERLAY_ID} .cd2-player-resize-top-left { top: 0; left: 0; cursor: nwse-resize; }
    #${OVERLAY_ID} .cd2-player-resize-top-right { top: 0; right: 0; cursor: nesw-resize; }
    #${OVERLAY_ID} .cd2-player-resize-bottom-left { bottom: 0; left: 0; cursor: nesw-resize; }
    #${OVERLAY_ID} .cd2-player-resize-bottom-right { right: 0; bottom: 0; cursor: nwse-resize; }

    @container (max-width: 900px) {
      #${CONTAINER_ID} .art-controls-center {
        display: flex !important; flex: 0 0 auto; min-width: 0; padding: 0 4px;
      }
      #${CONTAINER_ID} .art-controls-center .artplayer-plugin-danmuku {
        width: auto; gap: 8px;
      }
      #${CONTAINER_ID} .art-controls-center .apd-toggle,
      #${CONTAINER_ID} .art-controls-center .apd-config { flex: 0 0 auto; }
    }
    @container (max-width: 640px) {
      #${CONTAINER_ID} .art-video-player > * {
        --art-padding: 6px; --art-control-height: 38px;
        --art-control-icon-size: 30px; --art-control-icon-scale: 1;
      }
      #${CONTAINER_ID} .art-controls .art-control { min-width: 38px; }
    }

    /* 弹幕搜索浮层（在播放器内部） */
    .cd2-dm-panel {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      z-index: 110; background: rgba(0,0,0,0.96); border: 1px solid rgba(255,255,255,0.32);
      border-radius: 10px; width: 450px; max-width: 90%; max-height: 70%;
      display: none; flex-direction: column; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.7); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    .cd2-dm-panel.cd2-show { display: flex; }
    .cd2-dm-panel .cd2-dm-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.08);
      font-size: 14px; font-weight: 600;
    }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-close-panel {
      min-width: 32px; min-height: 32px; background: none; border: none;
      color: #fff; opacity: 0.5; cursor: pointer; font-size: 18px;
    }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-close-panel:hover { opacity: 1; }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-mode-badge {
      font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
      background: rgba(88,166,255,0.18); color: #58a6ff; border: 1px solid rgba(88,166,255,0.48);
      transition: all 0.15s; white-space: nowrap; user-select: none; font-family: inherit;
    }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-mode-badge:hover {
      background: rgba(88,166,255,0.28); border-color: rgba(88,166,255,0.72);
    }
    .cd2-dm-panel .cd2-dm-search {
      display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .cd2-dm-panel .cd2-dm-search input {
      flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.46);
      border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none;
    }
    .cd2-dm-panel .cd2-dm-search input::placeholder { color: rgba(255,255,255,0.56); }
    .cd2-dm-panel .cd2-dm-search input:focus { border-color: #58a6ff; }
    .cd2-dm-panel .cd2-dm-search button {
      background: #0969da; border: none; border-radius: 6px; padding: 8px 16px;
      color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; font-weight: 500;
    }
    .cd2-dm-panel .cd2-dm-search button:hover { background: #1f6feb; }
    .cd2-dm-panel .cd2-dm-body { overflow-y: auto; padding: 6px 0; flex: 1; }
    .cd2-dm-panel .cd2-dm-body::-webkit-scrollbar { width: 4px; }
    .cd2-dm-panel .cd2-dm-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
    .cd2-dm-panel .cd2-dm-group { padding: 0 16px; margin-bottom: 6px; }
    .cd2-dm-panel .cd2-dm-group-title {
      font-size: 13px; font-weight: 600; padding: 8px 0 4px; color: #58a6ff;
    }
    .cd2-dm-panel .cd2-dm-ep {
      display: block; width: 100%; font: inherit; font-size: 12px; text-align: left;
      padding: 7px 10px; margin: 2px 0; border: 0; border-radius: 6px;
      background: transparent; cursor: pointer; transition: all 0.15s; color: rgba(255,255,255,0.75);
    }
    .cd2-dm-panel .cd2-dm-ep:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .cd2-dm-panel .cd2-dm-ep.cd2-active { background: rgba(88,166,255,0.2); color: #58a6ff; font-weight: 500; }
    .cd2-dm-panel .cd2-dm-status {
      padding: 20px 16px; text-align: center; font-size: 12px; color: rgba(255,255,255,0.56);
      white-space: pre-line;
    }
    .cd2-dm-panel button:focus-visible,
    .cd2-dm-panel input:focus-visible {
      outline: 2px solid #45cbe7; outline-offset: 2px;
    }
  `;
	document.head.appendChild(style);
}

interface VideoNetworkSpeedTracker {
	destroy(): void;
}

function formatNetworkSpeed(bytesPerSecond: number): string {
	const units = ["B/s", "KB/s", "MB/s", "GB/s"];
	let value = bytesPerSecond;
	let unitIndex = 0;
	while (value >= 1000 && unitIndex < units.length - 1) {
		value /= 1000;
		unitIndex += 1;
	}
	const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
	return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function getBufferedDuration(video: HTMLVideoElement): number {
	let duration = 0;
	try {
		for (let index = 0; index < video.buffered.length; index += 1) {
			const start = video.buffered.start(index);
			const end = video.buffered.end(index);
			if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
				duration += end - start;
			}
		}
	} catch {
		// The media element may change its buffered ranges while they are read.
	}
	return duration;
}

function getResourceTimingBytes(sourceUrl: string): number | null {
	if (!sourceUrl || typeof performance.getEntriesByName !== "function") {
		return null;
	}
	let bytes = 0;
	for (const entry of performance.getEntriesByName(sourceUrl, "resource")) {
		const resource = entry as PerformanceResourceTiming;
		bytes = Math.max(
			bytes,
			resource.transferSize || 0,
			resource.encodedBodySize || 0,
		);
	}
	return bytes > 0 ? bytes : null;
}

/**
 * Estimates the native video download rate from the growth of its buffered
 * ranges. Native media requests do not expose a byte-progress callback, so a
 * known file size is mapped to buffered duration; Resource Timing is used as a
 * best-effort fallback when the browser exposes media byte counts.
 */
function createVideoNetworkSpeedTracker(
	video: HTMLVideoElement,
	sourceUrl: string,
	fileSize: number | undefined,
	indicator: HTMLElement,
): VideoNetworkSpeedTracker {
	const knownFileSize =
		typeof fileSize === "number" && Number.isFinite(fileSize) && fileSize > 0
			? fileSize
			: undefined;
	const samples: Array<{ time: number; bytes: number }> = [];
	let latestSpeed: number | null = null;
	let lastBytesAt = 0;
	let hideTimer = 0;
	let updateTimer = 0;
	let visible = true;
	let buffering = true;
	let destroyed = false;

	const renderIndicator = () => {
		const speed = latestSpeed;
		const hasSpeed = speed !== null && speed > 0;
		indicator.textContent = hasSpeed ? formatNetworkSpeed(speed) : "";
		const shouldShow = visible && hasSpeed;
		indicator.classList.toggle("cd2-player-network-speed-visible", shouldShow);
		indicator.setAttribute("aria-hidden", String(!shouldShow));
	};
	const setIndicatorVisibility = (nextVisible: boolean) => {
		visible = nextVisible;
		renderIndicator();
	};

	const readLoadedBytes = (): number | null => {
		if (
			knownFileSize !== undefined &&
			Number.isFinite(video.duration) &&
			video.duration > 0
		) {
			const bufferedDuration = getBufferedDuration(video);
			if (bufferedDuration > 0) {
				return Math.min(
					knownFileSize,
					(bufferedDuration / video.duration) * knownFileSize,
				);
			}
		}
		return getResourceTimingBytes(video.currentSrc || sourceUrl);
	};

	const update = () => {
		if (destroyed) return;
		const now = performance.now();
		const loadedBytes = readLoadedBytes();
		if (loadedBytes !== null && Number.isFinite(loadedBytes)) {
			const previous = samples[samples.length - 1];
			if (previous && loadedBytes + 1 < previous.bytes) {
				samples.length = 0;
				latestSpeed = null;
				lastBytesAt = 0;
			}
			samples.push({ time: now, bytes: loadedBytes });
			while (
				samples.length > 1 &&
				now - samples[0].time > NETWORK_SPEED_SAMPLE_WINDOW_MS
			) {
				samples.shift();
			}
			const first = samples[0];
			const elapsed = first ? now - first.time : 0;
			const delta = first ? loadedBytes - first.bytes : 0;
			if (
				first &&
				elapsed >= NETWORK_SPEED_MIN_SAMPLE_ELAPSED_MS &&
				delta > 0
			) {
				latestSpeed = (delta * 1000) / elapsed;
				lastBytesAt = now;
			} else if (
				lastBytesAt > 0 &&
				now - lastBytesAt > NETWORK_SPEED_STALE_AFTER_MS
			) {
				latestSpeed = null;
			}
		}

		renderIndicator();
	};

	const startUpdateTimer = () => {
		if (updateTimer !== 0) return;
		updateTimer = window.setInterval(update, NETWORK_SPEED_SAMPLE_INTERVAL_MS);
	};
	const stopUpdateTimer = () => {
		if (updateTimer === 0) return;
		window.clearInterval(updateTimer);
		updateTimer = 0;
	};

	const show = () => {
		window.clearTimeout(hideTimer);
		setIndicatorVisibility(true);
		startUpdateTimer();
		update();
	};
	const hideSoon = () => {
		window.clearTimeout(hideTimer);
		hideTimer = window.setTimeout(() => {
			if (!buffering && video.readyState >= 3) {
				setIndicatorVisibility(false);
				stopUpdateTimer();
			}
		}, 1200);
	};
	const reset = () => {
		samples.length = 0;
		latestSpeed = null;
		lastBytesAt = 0;
		show();
	};
	const onLoadStart = () => {
		buffering = true;
		reset();
	};
	const onProgress = () => {
		buffering = video.readyState < 3;
		show();
		if (!buffering) hideSoon();
	};
	const onWaiting = () => {
		buffering = true;
		show();
	};
	const onStalled = () => {
		buffering = true;
		show();
	};
	const onReady = () => {
		buffering = false;
		update();
		hideSoon();
	};
	const onSeeking = () => {
		buffering = true;
		reset();
	};
	const onSeeked = () => {
		if (video.readyState >= 3) {
			buffering = false;
			hideSoon();
		}
	};
	const onEmptied = () => {
		buffering = true;
		reset();
	};
	const onMetadata = () => {
		if (visible) update();
	};

	video.addEventListener("loadstart", onLoadStart);
	video.addEventListener("progress", onProgress);
	video.addEventListener("waiting", onWaiting);
	video.addEventListener("stalled", onStalled);
	video.addEventListener("canplay", onReady);
	video.addEventListener("canplaythrough", onReady);
	video.addEventListener("playing", onReady);
	video.addEventListener("suspend", onReady);
	video.addEventListener("seeking", onSeeking);
	video.addEventListener("seeked", onSeeked);
	video.addEventListener("emptied", onEmptied);
	video.addEventListener("loadedmetadata", onMetadata);
	video.addEventListener("durationchange", onMetadata);
	show();
	if (video.readyState >= 3) {
		buffering = false;
		hideSoon();
	}

	return {
		destroy() {
			if (destroyed) return;
			destroyed = true;
			window.clearTimeout(hideTimer);
			stopUpdateTimer();
			video.removeEventListener("loadstart", onLoadStart);
			video.removeEventListener("progress", onProgress);
			video.removeEventListener("waiting", onWaiting);
			video.removeEventListener("stalled", onStalled);
			video.removeEventListener("canplay", onReady);
			video.removeEventListener("canplaythrough", onReady);
			video.removeEventListener("playing", onReady);
			video.removeEventListener("suspend", onReady);
			video.removeEventListener("seeking", onSeeking);
			video.removeEventListener("seeked", onSeeked);
			video.removeEventListener("emptied", onEmptied);
			video.removeEventListener("loadedmetadata", onMetadata);
			video.removeEventListener("durationchange", onMetadata);
		},
	};
}

// ─── 弹幕面板 ───────────────────────────────────────────

function createDanmakuPanel(playerContainer: HTMLDivElement) {
	const panel = document.createElement("div");
	panel.id = DANMAKU_PANEL_ID;
	panel.className = "cd2-dm-panel";
	panel.tabIndex = -1;
	panel.setAttribute("role", "dialog");
	panel.setAttribute("aria-modal", "false");
	panel.setAttribute("aria-labelledby", DANMAKU_PANEL_TITLE_ID);
	panel.innerHTML = `
    <div class="cd2-dm-header">
      <span id="${DANMAKU_PANEL_TITLE_ID}">弹幕搜索</span>
      <button class="cd2-dm-mode-badge" type="button" title="点击切换匹配模式" aria-label="切换弹幕匹配模式">${getDanmuModeLabel()}</button>
      <button class="cd2-dm-close-panel" type="button" aria-label="关闭弹幕搜索">✕</button>
    </div>
    <div class="cd2-dm-search">
      <input type="text" aria-label="番剧名称" placeholder="输入番剧名搜索..." />
      <button type="button" aria-label="搜索弹幕">搜索</button>
    </div>
    <div class="cd2-dm-body">
      <div class="cd2-dm-status" role="status">等待自动匹配...</div>
    </div>
  `;

	// 放在播放器容器的父级（overlay），而不是 artplayer 内部
	playerContainer.parentElement?.appendChild(panel);

	const input = queryRequired<HTMLInputElement>(panel, ".cd2-dm-search input");
	const searchBtn = queryRequired<HTMLButtonElement>(
		panel,
		".cd2-dm-search button",
	);
	const body = queryRequired<HTMLDivElement>(panel, ".cd2-dm-body");
	const closeBtn = queryRequired<HTMLButtonElement>(
		panel,
		".cd2-dm-close-panel",
	);
	const modeBadge = queryRequired<HTMLButtonElement>(
		panel,
		".cd2-dm-mode-badge",
	);
	let returnFocus: HTMLElement | null = null;

	const show = (trigger?: HTMLElement) => {
		returnFocus =
			trigger ??
			(document.activeElement instanceof HTMLElement
				? document.activeElement
				: null);
		panel.classList.add("cd2-show");
		returnFocus?.setAttribute("aria-expanded", "true");
		window.requestAnimationFrame(() => {
			if (panel.classList.contains("cd2-show"))
				input.focus({ preventScroll: true });
		});
	};
	const hide = () => {
		if (!panel.classList.contains("cd2-show")) return;
		panel.classList.remove("cd2-show");
		const focusTarget = returnFocus;
		returnFocus?.setAttribute("aria-expanded", "false");
		returnFocus = null;
		window.requestAnimationFrame(() => {
			if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
		});
	};
	const toggle = (trigger?: HTMLElement) => {
		if (panel.classList.contains("cd2-show")) hide();
		else show(trigger);
	};

	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			hide();
		}
		event.stopPropagation();
	});
	// 阻止点击关闭面板传播到播放器
	panel.addEventListener("click", (event) => event.stopPropagation());
	closeBtn.onclick = hide;

	modeBadge.onclick = () => {
		const newMode = cycleDanmuMode();
		modeBadge.textContent = getDanmuModeLabel(newMode);
		if (currentPlayer)
			currentPlayer.notice.show = `弹幕模式已切换为: ${getDanmuModeLabel(newMode)}`;
	};

	return { panel, input, searchBtn, body, modeBadge, toggle, hide };
}

// ─── 渲染结果 ───────────────────────────────────────────

function renderStatus(body: HTMLDivElement, message: string): void {
	body.replaceChildren();
	const status = document.createElement("div");
	status.className = "cd2-dm-status";
	status.setAttribute("role", "status");
	status.textContent = message;
	body.appendChild(status);
}

function renderMatches(
	body: HTMLDivElement,
	matches: MatchItem[],
	onSelect: (id: number, label: string) => void,
	activeId?: number,
) {
	body.replaceChildren();
	if (matches.length === 0) {
		renderStatus(body, "无匹配结果");
		return;
	}
	const groups = new Map<string, MatchItem[]>();
	for (const m of matches) {
		let group = groups.get(m.animeTitle);
		if (!group) {
			group = [];
			groups.set(m.animeTitle, group);
		}
		group.push(m);
	}
	for (const [title, items] of groups) {
		const g = document.createElement("div");
		g.className = "cd2-dm-group";
		const groupTitle = document.createElement("div");
		groupTitle.className = "cd2-dm-group-title";
		groupTitle.textContent = title;
		g.appendChild(groupTitle);
		for (const item of items) {
			const el = document.createElement("button");
			el.type = "button";
			el.className = `cd2-dm-ep${item.episodeId === activeId ? " cd2-active" : ""}`;
			el.textContent = item.episodeTitle;
			el.onclick = () => onSelect(item.episodeId, item.episodeTitle);
			g.appendChild(el);
		}
		body.appendChild(g);
	}
}

function renderAnimes(
	body: HTMLDivElement,
	animes: SearchAnime[],
	onSelect: (id: number, label: string) => void,
	activeId?: number,
) {
	body.replaceChildren();
	if (animes.length === 0) {
		renderStatus(body, "无搜索结果，换个关键词试试");
		return;
	}
	for (const anime of animes) {
		const g = document.createElement("div");
		g.className = "cd2-dm-group";
		const groupTitle = document.createElement("div");
		groupTitle.className = "cd2-dm-group-title";
		groupTitle.textContent = `${anime.animeTitle}（${anime.typeDescription}）`;
		g.appendChild(groupTitle);
		for (const ep of anime.episodes) {
			const el = document.createElement("button");
			el.type = "button";
			el.className = `cd2-dm-ep${ep.episodeId === activeId ? " cd2-active" : ""}`;
			el.textContent = ep.episodeTitle;
			el.onclick = () => onSelect(ep.episodeId, ep.episodeTitle);
			g.appendChild(el);
		}
		body.appendChild(g);
	}
}

// ─── 覆盖层 ─────────────────────────────────────────────

function createOverlay(title: string) {
	const activeElement =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const focusCandidate =
		activeElement &&
		activeElement !== document.body &&
		activeElement !== document.documentElement &&
		!overlayEl?.contains(activeElement)
			? activeElement
			: _focusBeforePlayer;
	destroyPlayer(false);
	_focusBeforePlayer = focusCandidate?.isConnected ? focusCandidate : null;
	injectStyles();

	const overlay = document.createElement("div");
	overlay.id = OVERLAY_ID;
	overlay.tabIndex = -1;
	overlay.setAttribute("role", "dialog");
	overlay.setAttribute("aria-labelledby", OVERLAY_TITLE_ID);

	const header = document.createElement("div");
	header.className = "cd2-player-header";

	const titleEl = document.createElement("span");
	titleEl.id = OVERLAY_TITLE_ID;
	titleEl.className = "cd2-player-title";
	titleEl.textContent = title;

	const closeBtn = document.createElement("button");
	closeBtn.className = "cd2-player-close";
	closeBtn.type = "button";
	closeBtn.textContent = "✕";
	closeBtn.title = "关闭播放器";
	closeBtn.setAttribute("aria-label", "关闭播放器");
	closeBtn.onclick = () => destroyPlayer();

	header.append(titleEl, closeBtn);

	const container = document.createElement("div");
	container.id = CONTAINER_ID;

	const resizeTop = document.createElement("div");
	resizeTop.className =
		"cd2-player-resize-handle cd2-player-resize-edge cd2-player-resize-top";
	const resizeRight = document.createElement("div");
	resizeRight.className =
		"cd2-player-resize-handle cd2-player-resize-edge cd2-player-resize-right";
	const resizeBottom = document.createElement("div");
	resizeBottom.className =
		"cd2-player-resize-handle cd2-player-resize-edge cd2-player-resize-bottom";
	const resizeLeft = document.createElement("div");
	resizeLeft.className =
		"cd2-player-resize-handle cd2-player-resize-edge cd2-player-resize-left";
	const resizeTopLeft = document.createElement("div");
	resizeTopLeft.className =
		"cd2-player-resize-handle cd2-player-resize-corner cd2-player-resize-top-left";
	const resizeTopRight = document.createElement("div");
	resizeTopRight.className =
		"cd2-player-resize-handle cd2-player-resize-corner cd2-player-resize-top-right";
	const resizeBottomLeft = document.createElement("div");
	resizeBottomLeft.className =
		"cd2-player-resize-handle cd2-player-resize-corner cd2-player-resize-bottom-left";
	const resizeBottomRight = document.createElement("div");
	resizeBottomRight.className =
		"cd2-player-resize-handle cd2-player-resize-corner cd2-player-resize-bottom-right";
	for (const handle of [
		resizeTop,
		resizeRight,
		resizeBottom,
		resizeLeft,
		resizeTopLeft,
		resizeTopRight,
		resizeBottomLeft,
		resizeBottomRight,
	]) {
		handle.setAttribute("aria-hidden", "true");
	}

	overlay.append(
		container,
		header,
		resizeTop,
		resizeRight,
		resizeBottom,
		resizeLeft,
		resizeTopLeft,
		resizeTopRight,
		resizeBottomLeft,
		resizeBottomRight,
	);
	document.body.appendChild(overlay);
	overlayEl = overlay;

	let layout = getPlayerWindowLayout();
	const getCurrentWindowLayout = () => ({ ...layout });
	_getCurrentPlayerWindowLayout = getCurrentWindowLayout;
	const applyLayout = () => {
		overlay.style.left = `${layout.left}px`;
		overlay.style.top = `${layout.top}px`;
		overlay.style.width = `${layout.width}px`;
		overlay.style.height = `${layout.height}px`;
	};
	applyLayout();

	type PointerOperation = {
		pointerId: number;
		mode:
			| "drag"
			| "top"
			| "right"
			| "bottom"
			| "left"
			| "top-left"
			| "top-right"
			| "bottom-left"
			| "bottom-right";
		startX: number;
		startY: number;
		startLayout: PlayerWindowLayout;
		target: HTMLElement;
	};
	let operation: PointerOperation | null = null;
	let frameId: number | null = null;
	let pendingX = 0;
	let pendingY = 0;

	const applyPointerOperation = () => {
		frameId = null;
		if (!operation) return;
		const deltaX = pendingX - operation.startX;
		const deltaY = pendingY - operation.startY;
		const next = { ...operation.startLayout };
		if (operation.mode === "drag") {
			next.left += deltaX;
			next.top += deltaY;
			layout = clampPlayerWindowLayout(next);
		} else {
			const resizeFromLeft = operation.mode.includes("left");
			const resizeFromRight = operation.mode.includes("right");
			const resizeFromTop = operation.mode.includes("top");
			const resizeFromBottom = operation.mode.includes("bottom");
			const resizeHorizontally = resizeFromLeft || resizeFromRight;
			const resizeVertically = resizeFromTop || resizeFromBottom;
			const requestedWidth = resizeHorizontally
				? operation.startLayout.width + deltaX * (resizeFromLeft ? -1 : 1)
				: operation.startLayout.width;
			const requestedHeight = resizeVertically
				? operation.startLayout.height + deltaY * (resizeFromTop ? -1 : 1)
				: operation.startLayout.height;
			const fixedRight =
				operation.startLayout.left + operation.startLayout.width;
			const fixedBottom =
				operation.startLayout.top + operation.startLayout.height;
			const maxWidth = resizeFromLeft
				? fixedRight - PLAYER_WINDOW_MARGIN
				: resizeFromRight
					? window.innerWidth -
						operation.startLayout.left -
						PLAYER_WINDOW_MARGIN
					: operation.startLayout.width;
			const maxHeight = resizeFromTop
				? fixedBottom - PLAYER_WINDOW_MARGIN
				: resizeFromBottom
					? window.innerHeight -
						operation.startLayout.top -
						PLAYER_WINDOW_MARGIN
					: operation.startLayout.height;
			const minWidth = Math.min(Math.max(1, maxWidth), MIN_PLAYER_WINDOW_WIDTH);
			const minHeight = Math.min(
				Math.max(1, maxHeight),
				MIN_PLAYER_WINDOW_HEIGHT,
			);
			const width = Math.min(
				Math.max(1, maxWidth),
				Math.max(minWidth, requestedWidth),
			);
			const height = Math.min(
				Math.max(1, maxHeight),
				Math.max(minHeight, requestedHeight),
			);
			layout = {
				left: resizeFromLeft ? fixedRight - width : operation.startLayout.left,
				top: resizeFromTop ? fixedBottom - height : operation.startLayout.top,
				width,
				height,
			};
		}
		applyLayout();
	};

	const startPointerOperation =
		(mode: PointerOperation["mode"]) => (event: PointerEvent) => {
			if (event.button !== 0 || !event.isPrimary) return;
			if (
				mode === "drag" &&
				(document.fullscreenElement ||
					container.querySelector(".art-fullscreen-web"))
			)
				return;
			if (mode === "drag" && (event.target as HTMLElement).closest("button"))
				return;
			operation = {
				pointerId: event.pointerId,
				mode,
				startX: event.clientX,
				startY: event.clientY,
				startLayout: layout,
				target: event.currentTarget as HTMLElement,
			};
			pendingX = event.clientX;
			pendingY = event.clientY;
			operation.target.setPointerCapture(event.pointerId);
			if (mode === "drag") overlay.classList.add("cd2-player-window-dragging");
			event.preventDefault();
		};

	const onPointerMove = (event: PointerEvent) => {
		if (!operation || operation.pointerId !== event.pointerId) return;
		pendingX = event.clientX;
		pendingY = event.clientY;
		if (frameId === null)
			frameId = window.requestAnimationFrame(applyPointerOperation);
		event.preventDefault();
	};

	const finishPointerOperation = (event: PointerEvent) => {
		if (!operation || operation.pointerId !== event.pointerId) return;
		pendingX = event.clientX;
		pendingY = event.clientY;
		if (frameId !== null) window.cancelAnimationFrame(frameId);
		applyPointerOperation();
		if (operation.target.hasPointerCapture(event.pointerId))
			operation.target.releasePointerCapture(event.pointerId);
		operation = null;
		overlay.classList.remove("cd2-player-window-dragging");
		savePlayerWindowLayout(layout);
	};

	const dragStart = startPointerOperation("drag");
	const topResizeStart = startPointerOperation("top");
	const rightResizeStart = startPointerOperation("right");
	const bottomResizeStart = startPointerOperation("bottom");
	const leftResizeStart = startPointerOperation("left");
	const topLeftResizeStart = startPointerOperation("top-left");
	const topRightResizeStart = startPointerOperation("top-right");
	const bottomLeftResizeStart = startPointerOperation("bottom-left");
	const bottomRightResizeStart = startPointerOperation("bottom-right");
	header.addEventListener("pointerdown", dragStart);
	resizeTop.addEventListener("pointerdown", topResizeStart);
	resizeRight.addEventListener("pointerdown", rightResizeStart);
	resizeBottom.addEventListener("pointerdown", bottomResizeStart);
	resizeLeft.addEventListener("pointerdown", leftResizeStart);
	resizeTopLeft.addEventListener("pointerdown", topLeftResizeStart);
	resizeTopRight.addEventListener("pointerdown", topRightResizeStart);
	resizeBottomLeft.addEventListener("pointerdown", bottomLeftResizeStart);
	resizeBottomRight.addEventListener("pointerdown", bottomRightResizeStart);
	window.addEventListener("pointermove", onPointerMove, { passive: false });
	window.addEventListener("pointerup", finishPointerOperation);
	window.addEventListener("pointercancel", finishPointerOperation);
	const onWindowResize = () => {
		layout = clampPlayerWindowLayout(layout);
		applyLayout();
	};
	const saveLayoutBeforePageUnload = () => savePlayerWindowLayout(layout);
	window.addEventListener("resize", onWindowResize);
	window.addEventListener("pagehide", saveLayoutBeforePageUnload);
	const cleanupFloatingInteraction = () => {
		if (frameId !== null) window.cancelAnimationFrame(frameId);
		header.removeEventListener("pointerdown", dragStart);
		resizeTop.removeEventListener("pointerdown", topResizeStart);
		resizeRight.removeEventListener("pointerdown", rightResizeStart);
		resizeBottom.removeEventListener("pointerdown", bottomResizeStart);
		resizeLeft.removeEventListener("pointerdown", leftResizeStart);
		resizeTopLeft.removeEventListener("pointerdown", topLeftResizeStart);
		resizeTopRight.removeEventListener("pointerdown", topRightResizeStart);
		resizeBottomLeft.removeEventListener("pointerdown", bottomLeftResizeStart);
		resizeBottomRight.removeEventListener(
			"pointerdown",
			bottomRightResizeStart,
		);
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", finishPointerOperation);
		window.removeEventListener("pointercancel", finishPointerOperation);
		window.removeEventListener("resize", onWindowResize);
		window.removeEventListener("pagehide", saveLayoutBeforePageUnload);
	};

	const panelEls = createDanmakuPanel(container);

	// ESC 处理
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.code === "Space" && !e.ctrlKey && !e.altKey && !e.metaKey) {
			const editing = e.composedPath().some((node) => {
				if (!(node instanceof HTMLElement)) return false;
				return (
					node.isContentEditable ||
					["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(node.tagName)
				);
			});
			if (!editing) {
				e.preventDefault();
				e.stopImmediatePropagation();
				if (!e.repeat && currentPlayer) {
					if (currentPlayer.playing) currentPlayer.pause();
					else
						void currentPlayer.play().catch((error: unknown) => {
							if ((error as DOMException)?.name !== "AbortError") {
								console.warn("[cd2-artplayer] 恢复播放失败:", error);
							}
						});
				}
				return;
			}
		}
		if (e.key === "Escape") {
			if (panelEls.panel.classList.contains("cd2-show")) {
				panelEls.hide();
			} else {
				destroyPlayer();
				document.removeEventListener("keydown", onKeyDown);
			}
		}
	};
	document.addEventListener("keydown", onKeyDown);
	_cleanupFloatingWindow = () => {
		cleanupFloatingInteraction();
		document.removeEventListener("keydown", onKeyDown);
		if (_getCurrentPlayerWindowLayout === getCurrentWindowLayout) {
			_getCurrentPlayerWindowLayout = null;
		}
	};

	const setChromeVisible = (visible: boolean) => {
		header.classList.toggle("cd2-player-header-visible", visible);
	};
	const mountWindowChrome = (playerRoot: HTMLElement) => {
		playerRoot.appendChild(header);
		setChromeVisible(true);
	};
	return {
		container,
		panelEls,
		mountWindowChrome,
		setChromeVisible,
		focusInitial: () => closeBtn.focus({ preventScroll: true }),
	};
}

// ─── 销毁 ───────────────────────────────────────────────

export function destroyPlayer(restoreFocus = true) {
	const focusTarget = restoreFocus ? _focusBeforePlayer : null;
	if (restoreFocus) _focusBeforePlayer = null;
	_playerSessionNonce += 1;
	if (_saveProgressBeforeDestroy) {
		_saveProgressBeforeDestroy();
		_saveProgressBeforeDestroy = null;
	}
	if (_cleanupBeforeDestroy) {
		_cleanupBeforeDestroy();
		_cleanupBeforeDestroy = null;
	}
	if (_cleanupFloatingWindow) {
		_cleanupFloatingWindow();
		_cleanupFloatingWindow = null;
	}
	if (currentPlayer) {
		currentPlayer.destroy(true);
		currentPlayer = null;
	}
	if (overlayEl) {
		overlayEl.remove();
		overlayEl = null;
	}
	clearPlayerReloadSession();
	if (focusTarget?.isConnected) {
		queueMicrotask(() => focusTarget.focus({ preventScroll: true }));
	}
}

/** 仅在当前标签页发生刷新时恢复播放器；新开页面或普通跳转不会触发。 */
export async function restorePlayerAfterReload(): Promise<boolean> {
	// 若用户已主动打开新视频，绝不能用旧快照覆盖它。
	if (currentPlayer) return false;
	const navigation = performance.getEntriesByType("navigation")[0] as
		| PerformanceNavigationTiming
		| undefined;
	if (navigation?.type !== "reload") {
		// 新标签页可能从 opener 复制 sessionStorage，普通导航时必须主动丢弃。
		if (!currentPlayer) clearPlayerReloadSession();
		return false;
	}

	const session = readPlayerReloadSession();
	if (!session || session.pageUrl !== window.location.href) {
		clearPlayerReloadSession();
		return false;
	}
	if (session.windowLayout) savePlayerWindowLayout(session.windowLayout);

	await openPlayer(
		session.url,
		session.fileName,
		session.filePath,
		session.title,
		session.playlist,
		session.currentIndex,
		session.folderName,
		session.subtitles,
		{
			time: session.time,
			wasPlaying: session.wasPlaying,
			volume: session.volume,
			muted: session.muted,
			playbackRate: session.playbackRate,
			aspectRatio: session.aspectRatio,
			windowLayout: session.windowLayout,
		},
		session.fileSize,
	);
	return true;
}

export function preloadPlayerAudio(
	videoUrl: string,
	fileSize?: number,
	filePath?: string,
	fileName?: string,
): void {
	if (!isExtensionBuild || !isMkvMedia(fileName, videoUrl)) return;
	const mediaIdentity = getMediaIdentity(videoUrl, filePath, fileName);
	const rememberedTime = Math.max(
		0,
		videoMemory.get(mediaIdentity)?.time ??
			videoMemory.get(videoUrl)?.time ??
			0,
	);
	preloadBrowserAudioFallback(videoUrl, rememberedTime, fileSize, videoUrl);
}

// ─── 加载弹幕到播放器 ───────────────────────────────────

function applyDanmaku(_danmaku: ArtDanmaku[]) {
	if (!currentPlayer) return;
	const api = currentPlayer.plugins?.artplayerPluginDanmuku as
		| DanmukuPluginLike
		| undefined;
	if (api) {
		api.config({ danmuku: _danmaku });
		api.load();
	}
}

// ─── 弹幕 SVG 图标 ──────────────────────────────────────

const DANMAKU_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12zM7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>`;

async function activateSubtitleSelection(
	item: SubtitleSelectorItem,
	player: Artplayer,
	sessionNonce: number,
	persist: boolean,
): Promise<void> {
	if (currentPlayer !== player || sessionNonce !== _playerSessionNonce) return;
	const identity = subtitleIdentity(item);
	if (_currentSubtitleIdentity !== identity) {
		cancelActiveLibavSubtitleExtraction();
	}
	_currentSubtitleIdentity = identity;
	_pendingSubtitleIdentity = null;
	if (persist && _currentSubtitleVideoKey) {
		subtitleMemory.set(_currentSubtitleVideoKey, { identity });
	}

	if (identity === "off") {
		_activeLibavSubtitle = null;
		const assPlugin = player.plugins
			.artplayerPluginLibass as unknown as AssPluginLike;
		if (assPlugin) {
			await Promise.resolve(assPlugin.switch?.("")).catch((error) =>
				console.warn("[cd2-artplayer] 关闭 ASS 字幕失败:", error),
			);
		}
		player.subtitle.show = false;
		const tracks = player.video?.textTracks;
		if (tracks) {
			for (let index = 0; index < tracks.length; index += 1) {
				tracks[index].mode = "hidden";
			}
		}
		return;
	}

	const apply = async (url: string) => {
		if (currentPlayer !== player || sessionNonce !== _playerSessionNonce)
			return;
		if (item.ext === "ass" || item.ext === "ssa") {
			player.subtitle.show = false;
			await applyAssSubtitle(player, url);
			return;
		}
		if (item.isNativeType) {
			_activeLibavSubtitle = null;
			player.subtitle.show = false;
			const tracks = player.video?.textTracks;
			if (!tracks) return;
			for (let index = 0; index < tracks.length; index += 1) {
				const track = tracks[index];
				track.mode = track.label === item.html ? "showing" : "hidden";
			}
			return;
		}
		const isActiveSegmentedSubtitle =
			_activeLibavSubtitle?.player === player &&
			_activeLibavSubtitle.url === url;
		if (!isActiveSegmentedSubtitle) _activeLibavSubtitle = null;
		const assPlugin = player.plugins
			.artplayerPluginLibass as unknown as AssPluginLike;
		if (assPlugin) {
			await Promise.resolve(assPlugin.switch?.("")).catch((error) =>
				console.warn("[cd2-artplayer] 关闭 ASS 字幕失败:", error),
			);
		}
		player.subtitle.switch(url, { type: item.ext });
		player.subtitle.show = true;
	};

	if (item.isDeferred && !item.url) {
		const url = await loadDeferredSubtitle(item, player, sessionNonce);
		if (url) await apply(url);
		return;
	}
	await apply(await materializeSubtitle(item));
}

// ─── 打开播放器 ─────────────────────────────────────────

export async function openPlayer(
	url: string,
	fileName: string,
	filePath?: string,
	title?: string,
	playlist?: { fileName: string; filePath: string }[],
	currentIndex?: number,
	folderName?: string,
	subtitles?: SubtitleItem[],
	restoreState?: PlayerRestoreState,
	fileSize?: number,
) {
	const displayTitle = title || fileName;
	const {
		container,
		panelEls,
		mountWindowChrome,
		setChromeVisible,
		focusInitial,
	} = createOverlay(displayTitle);
	const sessionNonce = ++_playerSessionNonce;
	const isCurrentSession = () => sessionNonce === _playerSessionNonce;
	const mediaIdentity = getMediaIdentity(url, filePath, fileName);
	_currentSubtitleVideoKey = mediaIdentity;
	_currentSubtitleIdentity = null;
	_pendingSubtitleIdentity = null;
	_autoSubtitleActivationBarrier = Promise.resolve();
	const shouldUseBrowserAudioFallback =
		isExtensionBuild && isMkvMedia(fileName, url);

	// 弹幕状态文字（显示在控制栏）
	let danmakuStatusText = "弹幕匹配中...";
	let _currentEpisodeId: number | undefined;
	// 保存最后一次搜索/匹配的结果，用于选集后刷新面板高亮
	let _lastAnimes: SearchAnime[] = [];
	let _lastUseDirect = false;

	// 选集回调
	// useDirect: true=使用直连弹弹Play代理, false=使用danmu_api服务
	const onSelectEpisode = async (
		episodeId: number,
		label: string,
		useDirect = false,
	): Promise<number> => {
		_currentEpisodeId = episodeId;
		_lastUseDirect = useDirect;
		panelEls.hide();
		danmakuStatusText = "加载中...";
		updateControlText();
		try {
			const comments = useDirect
				? await directFetchComments(episodeId)
				: await fetchComments(episodeId);
			if (!isCurrentSession()) return 0;
			const danmaku = convertToArtDanmaku(comments.comments);
			applyDanmaku(danmaku);
			const source = useDirect ? "直连" : "API";
			danmakuStatusText = `${label} | ${danmaku.length}条(${source})`;
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `已加载 ${danmaku.length} 条弹幕(${source})`;
			// 更新面板列表高亮
			if (_lastAnimes.length > 0) {
				const selectFn = useDirect
					? (id: number, lbl: string) => onSelectEpisode(id, lbl, true)
					: (id: number, lbl: string) => onSelectEpisode(id, lbl, false);
				renderAnimes(panelEls.body, _lastAnimes, selectFn, episodeId);
			}
			return danmaku.length;
		} catch (err) {
			if (!isCurrentSession()) return 0;
			danmakuStatusText = "加载失败";
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `弹幕加载失败: ${(err as Error).message}`;
			return -1;
		}
	};

	// 搜索功能（根据当前模式决定搜索方式）
	const doSearch = async () => {
		const kw = panelEls.input.value.trim();
		if (!kw) return;
		renderStatus(panelEls.body, "搜索中...");
		const searchMode = getDanmuMode();

		// 仅API模式
		if (searchMode === "api") {
			if (!hasApiUrl()) {
				renderStatus(panelEls.body, "未配置API地址，请先在油猴菜单中设置");
				return;
			}
			try {
				const res = await searchEpisodes(kw);
				if (!isCurrentSession()) return;
				renderAnimes(
					panelEls.body,
					res.animes,
					onSelectEpisode,
					_currentEpisodeId,
				);
			} catch (err) {
				renderStatus(panelEls.body, `搜索失败: ${(err as Error).message}`);
			}
			return;
		}

		// 直连模式 或 自动模式
		try {
			const res = await directSearchEpisodes(kw);
			if (!isCurrentSession()) return;
			renderAnimes(
				panelEls.body,
				res.animes,
				(id, label) => onSelectEpisode(id, label, true),
				_currentEpisodeId,
			);
		} catch (directErr) {
			if (searchMode === "direct") {
				renderStatus(
					panelEls.body,
					`直连搜索失败: ${(directErr as Error).message}`,
				);
				return;
			}
			// auto模式回退到API
			console.warn(
				"[cd2-artplayer] 直连搜索失败，尝试API:",
				(directErr as Error).message,
			);
			if (hasApiUrl()) {
				try {
					const res = await searchEpisodes(kw);
					if (!isCurrentSession()) return;
					renderAnimes(panelEls.body, res.animes, onSelectEpisode);
				} catch (apiErr) {
					renderStatus(panelEls.body, `搜索失败: ${(apiErr as Error).message}`);
				}
			} else {
				renderStatus(
					panelEls.body,
					`搜索失败: ${(directErr as Error).message}`,
				);
			}
		}
	};
	panelEls.searchBtn.onclick = doSearch;
	panelEls.input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") doSearch();
	});

	// 控制栏文字更新方法 (在 artplayer ready 后才有效）
	function updateControlText() {
		const el = container.querySelector(".cd2-dm-ctrl-text");
		if (el) el.textContent = danmakuStatusText;
	}

	const playerPreferences = getPlayerPreferences();
	const alternativeVideoDecoderEnabled =
		isExtensionBuild &&
		/\.(?:mp4|mkv|m4v|mov|webm|avi|rmvb|flv|ts|m2ts|mpeg|mpg|iso)$/i.test(
			fileName,
		);
	let videoDecoderMode: VideoDecoderMode = alternativeVideoDecoderEnabled
		? playerPreferences.videoDecoder
		: "native";
	let mkvMetadataExtractionTimer = 0;
	let mp4SubtitleExtractionTimer = 0;
	const setVideoDecoderMode = (mode: VideoDecoderMode) => {
		videoDecoderMode = mode;
		playerPreferences.videoDecoder = mode;
		GM_setValue(PLAYER_PREFERENCES_KEY, {
			...getPlayerPreferences(),
			videoDecoder: mode,
		});
		Win.dispatchEvent(
			new CustomEvent("cd2-video-renderer-set", {
				detail: { mode, sessionNonce },
			}),
		);
	};
	let videoRendererWarmupCleanup: (() => void) | null = null;
	const videoRendererReady =
		alternativeVideoDecoderEnabled && videoDecoderMode !== "native"
			? new Promise<void>((resolve) => {
					let settled = false;
					let timeoutId = 0;
					const finish = () => {
						if (settled) return;
						settled = true;
						window.clearTimeout(timeoutId);
						Win.removeEventListener("cd2-video-renderer-status", onStatus);
						if (videoRendererWarmupCleanup === finish)
							videoRendererWarmupCleanup = null;
						resolve();
					};
					const onStatus = (event: Event) => {
						const detail = (
							event as CustomEvent<{
								sessionNonce?: number;
								state?: string;
							}>
						).detail;
						if (
							detail?.sessionNonce === sessionNonce &&
							(detail.state === "ready" ||
								detail.state === "error" ||
								detail.state === "closed")
						)
							finish();
					};
					videoRendererWarmupCleanup = finish;
					Win.addEventListener("cd2-video-renderer-status", onStatus);
					timeoutId = window.setTimeout(finish, 15_000);
				})
			: Promise.resolve();
	const deferMediaMetadata = (
		task: () => void,
		setTimer: (timer: number) => void,
	): void => {
		if (!alternativeVideoDecoderEnabled) {
			task();
			return;
		}
		const schedule = () => {
			if (!isCurrentSession()) return;
			setTimer(
				window.setTimeout(() => {
					setTimer(0);
					task();
				}, 750),
			);
		};
		if (videoDecoderMode !== "native") void videoRendererReady.then(schedule);
		else if (currentPlayer?.isReady) schedule();
		else currentPlayer?.once("ready", schedule);
	};

	// 构建控制栏
	const controls: Artplayer["option"]["controls"] = [];
	if (alternativeVideoDecoderEnabled) {
		controls.push({
			name: "video-decoder-selector",
			position: "right",
			index: 5,
			html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer" title="视频解码器">解码</div>`,
			selector: [
				{
					default: videoDecoderMode === "software",
					html: "软件解码",
					mode: "software",
				},
				{
					default: videoDecoderMode === "hardware",
					html: "硬件解码",
					mode: "hardware",
				},
				{
					default: videoDecoderMode === "native",
					html: "浏览器原生",
					mode: "native",
				},
			],
			onSelect: (selector) => {
				const item = selector as VideoDecoderSelectorItem;
				setVideoDecoderMode(item.mode);
				return item.html;
			},
		});
	}
	controls.push(
		{
			name: "subtitle-selector",
			position: "right",
			index: 10,
			html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer" title="字幕切换">${SUBTITLE_ICON}</div>`,
			selector: [{ default: true, html: "关闭字幕", url: "" }],
			onSelect: (selector) => {
				const item = selector as SubtitleSelectorItem;
				const player = currentPlayer;
				if (!player || sessionNonce !== _playerSessionNonce) {
					return item.html;
				}
				void activateSubtitleSelection(item, player, sessionNonce, true).catch(
					(error) => {
						if (isCanceledExtensionRequest(error)) return;
						console.warn("[cd2-artplayer] 字幕加载失败:", error);
						player.notice.show = `字幕加载失败: ${(error as Error).message}`;
					},
				);
				return item.html;
			},
		},
		{
			name: "danmaku-search",
			position: "right",
			index: 15,
			html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer">${DANMAKU_ICON}<span class="cd2-dm-ctrl-text" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">弹幕匹配中...</span></div>`,
			mounted: (element) => {
				element.tabIndex = 0;
				element.setAttribute("role", "button");
				element.setAttribute("aria-label", "打开弹幕搜索");
				element.setAttribute("aria-haspopup", "dialog");
				element.setAttribute("aria-controls", DANMAKU_PANEL_ID);
				element.setAttribute("aria-expanded", "false");
				element.onkeydown = (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					event.stopPropagation();
					panelEls.toggle(element);
				};
			},
			beforeUnmount: (element) => {
				element.onkeydown = null;
			},
			click: (_component, event) => {
				panelEls.toggle(
					event.currentTarget instanceof HTMLElement
						? event.currentTarget
						: undefined,
				);
			},
		},
	);

	if (playlist && playlist.length > 1) {
		controls.push({
			name: "playlist",
			position: "right",
			index: 20,
			html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer" title="选集">选集</div>`,
			selector: playlist.map((item, idx) => ({
				html: item.fileName,
				default: idx === currentIndex,
				fileName: item.fileName,
				filePath: item.filePath,
			})),
			onSelect: (selector) => {
				const item = selector as PlaylistSelectorItem;
				const dispatchPlay = (videoUrl: string) => {
					if (!isCurrentSession()) return;
					Win.dispatchEvent(
						new CustomEvent("cd2-play-video", {
							detail: {
								fileName: item.fileName,
								filePath: item.filePath,
								videoUrl,
								playlist,
								currentIndex: playlist.findIndex(
									(entry) => entry.filePath === item.filePath,
								),
								folderName,
							},
						}),
					);
				};
				if (item.filePath === filePath) {
					dispatchPlay(url);
				} else {
					resolveVideoUrlFromOffline(item.filePath)
						.then((resolvedUrl) => {
							if (!resolvedUrl) {
								console.warn(
									"[cd2-artplayer] 切集时未解析到视频地址:",
									item.filePath,
								);
								return;
							}
							dispatchPlay(resolvedUrl);
						})
						.catch((err) => {
							console.warn("[cd2-artplayer] 切集失败:", err);
						});
				}
				return item.html;
			},
		});
	}

	// 提前记录本次播放路径
	if (folderName && playlist && currentIndex !== undefined) {
		const currentItem = playlist[currentIndex];
		if (currentItem) {
			playlistMemory.set(folderName, { filePath: currentItem.filePath });
		}
	}

	// 初始化播放器
	// 为了让 Artplayer 初始化字幕引擎，我们喂给它一条空内容的 DataURI SRT 数据。
	const initSubtitle = {
		url: `data:text/plain;charset=utf-8,${encodeURIComponent("1\n00:00:00,000 --> 00:00:01,000\n ")}`,
		type: "srt",
		encoding: "utf-8",
		escaping: false,
	};

	// Monkey-patch getExt：让 Artplayer/libass 能识别 Blob URL 的字幕扩展名
	// getExt 是只读属性（只有 getter），需要用 Object.defineProperty 才能覆盖
	const _originalGetExtDescriptor = isExtensionBuild
		? undefined
		: Object.getOwnPropertyDescriptor(Artplayer.utils, "getExt");
	const _originalGetExt = Artplayer.utils.getExt;
	if (!isExtensionBuild)
		try {
			Object.defineProperty(Artplayer.utils, "getExt", {
				configurable: true,
				writable: true,
				value: (extUrl: string) => {
					const cachedExt = _blobUrlExtCache.get(extUrl);
					if (cachedExt) return cachedExt;
					const subItem = [..._currentSubtitles, ..._mkvExtractedSubs].find(
						(s) => s.url === extUrl,
					);
					if (subItem) {
						const ext = getSubtitleType(subItem.fileName);
						if (ext) return ext;
					}
					return _originalGetExt(extUrl);
				},
			});
		} catch (e) {
			console.warn(
				"[cd2-artplayer] 无法 patch getExt，字幕扩展名识别可能不准确:",
				e,
			);
		}

	const danmakuPreferences = getDanmakuPreferences();
	const rememberedVideo =
		videoMemory.get(mediaIdentity) ?? videoMemory.get(url);
	const restoreTime = Math.max(
		0,
		restoreState?.time ?? rememberedVideo?.time ?? 0,
	);
	// Audio and subtitles share the dedicated 1 MiB Range Host while native video
	// remains directly connected to CloudDrive2 for the fastest first frame.
	const audioFallbackPreparation = shouldUseBrowserAudioFallback
		? takeBrowserAudioFallbackPreparation(url, restoreTime, fileSize, url)
		: undefined;
	_autoSubtitleActivationBarrier = audioFallbackPreparation
		? settleWithin(audioFallbackPreparation.openResult, 3000)
		: Promise.resolve();
	if (sessionNonce !== _playerSessionNonce) return;
	currentPlayer = new Artplayer({
		container,
		url,
		volume: restoreState?.volume ?? playerPreferences.volume,
		autoplay: restoreState?.wasPlaying ?? true,
		pip: true,
		autoSize: false,
		autoMini: false,
		screenshot: true,
		setting: true,
		loop: false,
		flip: true,
		playbackRate: true,
		aspectRatio: true,
		fullscreen: true,
		fullscreenWeb: true,
		miniProgressBar: false,
		mutex: true,
		backdrop: true,
		hotkey: true,
		lock: true,
		fastForward: true,
		autoOrientation: true,
		theme: "#1677ff",
		subtitle: initSubtitle,
		controls,
		plugins: [
			artplayerPluginDanmuku({
				danmuku: [],
				...danmakuPreferences,
				mount: undefined,
				// 悬浮播放器自行处理窄窗口布局，禁止插件把设置栏移到视频下方后被裁切。
				width: 0,
				heatmap: GM_getValue(SHOW_DANMAKU_HEATMAP_KEY, false) as boolean,
			}),
			artplayerPluginAss({
				workerUrl: LIBASS_WORKER_SCRIPT_URL,
				wasmUrl: LIBASS_WASM_URL,
				fallbackFont: LIBASS_FALLBACK_FONT,
			}),
		],
	});
	if (alternativeVideoDecoderEnabled) {
		Win.dispatchEvent(
			new CustomEvent("cd2-video-renderer-open", {
				detail: {
					video: currentPlayer.video,
					container: currentPlayer.template.$player,
					videoUrl: url,
					fileSize,
					mode: videoDecoderMode,
					sessionNonce,
				},
			}),
		);
	}
	const networkSpeed = document.createElement("span");
	networkSpeed.id = NETWORK_SPEED_ID;
	networkSpeed.className = "cd2-player-network-speed";
	networkSpeed.setAttribute("role", "status");
	networkSpeed.setAttribute("aria-live", "polite");
	networkSpeed.setAttribute("aria-atomic", "true");
	networkSpeed.setAttribute("aria-hidden", "true");
	currentPlayer.template.$loading.appendChild(networkSpeed);
	const networkSpeedTracker = createVideoNetworkSpeedTracker(
		currentPlayer.video,
		url,
		fileSize,
		networkSpeed,
	);
	const browserAudioFallback = shouldUseBrowserAudioFallback
		? new BrowserAudioFallback({
				video: currentPlayer.video,
				videoUrl: url,
				audioSourceUrl: url,
				preparation: audioFallbackPreparation,
				notice: (message) => {
					if (currentPlayer) currentPlayer.notice.show = message;
				},
			})
		: null;
	if (browserAudioFallback) void browserAudioFallback.start();
	writePlayerReloadSession({
		version: 1,
		pageUrl: window.location.href,
		updatedAt: Date.now(),
		url,
		fileName,
		filePath,
		title,
		playlist,
		currentIndex,
		folderName,
		subtitles,
		fileSize,
		time: restoreTime,
		wasPlaying: restoreState?.wasPlaying ?? true,
		volume: restoreState?.volume ?? playerPreferences.volume,
		muted: restoreState?.muted ?? playerPreferences.muted,
		playbackRate: restoreState?.playbackRate ?? playerPreferences.playbackRate,
		aspectRatio: restoreState?.aspectRatio ?? playerPreferences.aspectRatio,
		windowLayout: _getCurrentPlayerWindowLayout?.(),
	});
	const playerRoot = currentPlayer.template.$player;
	mountWindowChrome(playerRoot);
	focusInitial();

	// ArtPlayer 的左右控制栏会在窄窗口中互相挤压，最终把最右侧的真正全屏
	// 按钮裁掉。根据播放器的实际宽度主动收纳按钮，保证核心操作严格按优先级保留。
	const setResponsiveControlVisible = (
		selector: string,
		visible: boolean,
		display = "flex",
	) => {
		for (const element of playerRoot.querySelectorAll<HTMLElement>(selector)) {
			element.style.setProperty(
				"display",
				visible ? display : "none",
				"important",
			);
		}
	};
	const updateResponsiveControls = () => {
		const width = playerRoot.getBoundingClientRect().width;
		if (!width) return;

		// 最高优先级：无论播放器多窄，都必须保留播放/暂停和真正的全屏。
		setResponsiveControlVisible(".art-control-playAndPause", true);
		setResponsiveControlVisible(".art-control-fullscreen", true);

		// 核心功能按重要性从后往前收起；正常最小宽度 480px 时六项均可见。
		setResponsiveControlVisible(".apd-toggle", width >= 280);
		setResponsiveControlVisible(".art-control-subtitle-selector", width >= 320);
		setResponsiveControlVisible(".art-control-danmaku-search", width >= 360);
		setResponsiveControlVisible(".apd-config", width >= 410);

		// 其余 ArtPlayer 功能先于上述核心按钮收起，避免占满控制栏。
		setResponsiveControlVisible(".art-control-setting", width >= 560);
		setResponsiveControlVisible(".art-control-playlist", width >= 620);
		setResponsiveControlVisible(".art-control-volume", width >= 680);
		setResponsiveControlVisible(".art-control-time", width >= 740);
		setResponsiveControlVisible(".art-control-screenshot", width >= 900);
		setResponsiveControlVisible(".art-control-pip", width >= 900);
		setResponsiveControlVisible(".art-control-fullscreenWeb", width >= 900);
		setResponsiveControlVisible(".cd2-dm-ctrl-text", width >= 900, "inline");
	};
	const responsiveControlsObserver = new ResizeObserver(
		updateResponsiveControls,
	);
	responsiveControlsObserver.observe(playerRoot);
	updateResponsiveControls();
	window.requestAnimationFrame(updateResponsiveControls);
	const onPlayerControl = (visible: boolean) => setChromeVisible(visible);
	currentPlayer.on("control", onPlayerControl);
	currentPlayer.muted = restoreState?.muted ?? playerPreferences.muted;
	currentPlayer.playbackRate =
		restoreState?.playbackRate ?? playerPreferences.playbackRate;
	const restoredAspectRatio =
		restoreState?.aspectRatio ?? playerPreferences.aspectRatio;
	if (restoredAspectRatio !== "default") {
		currentPlayer.aspectRatio = restoredAspectRatio;
	}
	const onDanmakuConfig = (option: unknown) => saveDanmakuPreferences(option);
	const saveCurrentDanmakuPreferences = () => {
		const plugin = currentPlayer?.plugins?.artplayerPluginDanmuku as
			| DanmukuPluginLike
			| undefined;
		if (plugin?.option) saveDanmakuPreferences(plugin.option);
	};
	const savePlayerPreferences = () => {
		if (!currentPlayer) return;
		GM_setValue(PLAYER_PREFERENCES_KEY, {
			volume: currentPlayer.volume,
			muted: currentPlayer.muted,
			playbackRate: currentPlayer.playbackRate,
			aspectRatio: currentPlayer.aspectRatio,
			videoDecoder: videoDecoderMode,
		} satisfies PlayerPreferences);
	};
	currentPlayer.on("artplayerPluginDanmuku:config", onDanmakuConfig);
	currentPlayer.on(
		"artplayerPluginDanmuku:show",
		saveCurrentDanmakuPreferences,
	);
	currentPlayer.on(
		"artplayerPluginDanmuku:hide",
		saveCurrentDanmakuPreferences,
	);
	currentPlayer.on("video:volumechange", savePlayerPreferences);
	currentPlayer.on("video:ratechange", savePlayerPreferences);
	currentPlayer.on("aspectRatio", savePlayerPreferences);

	// 将面板挂载到 artplayer 内部
	currentPlayer.template.$player.appendChild(panelEls.panel);

	// 恢复进度
	if (restoreTime > 0) {
		const playerToRestore = currentPlayer;
		currentPlayer.on("ready", () => {
			if (currentPlayer === playerToRestore) {
				currentPlayer.currentTime = restoreTime;
				if (restoreState && !restoreState.wasPlaying) currentPlayer.pause();
				currentPlayer.notice.show = `已恢复播放进度: ${Math.floor(restoreTime / 60)}分${Math.floor(restoreTime % 60)}秒`;
			}
		});
	}

	// 绑定保存进度的钩子
	const saveCurrentProgress = () => {
		const player = currentPlayer;
		if (player) {
			const time = player.currentTime;
			const duration = player.duration;
			if (time > 0 && (!Number.isFinite(duration) || time < duration - 5)) {
				videoMemory.set(mediaIdentity, {
					time,
					episodeId: _currentEpisodeId,
					label: danmakuStatusText,
					useDirect: _lastUseDirect,
				});
			}
		}
		persistActivePlayerReloadSession();
	};
	_saveProgressBeforeDestroy = saveCurrentProgress;
	const progressSaveTimer = window.setInterval(() => {
		if (currentPlayer && !currentPlayer.video.paused) {
			saveCurrentProgress();
		}
	}, 10000);
	let pageIsUnloading = false;
	let playbackShouldResume = restoreState?.wasPlaying ?? true;
	const onPlaybackStateChange = () => {
		if (!pageIsUnloading && currentPlayer) {
			playbackShouldResume = !currentPlayer.video.paused;
		}
		persistActivePlayerReloadSession();
	};
	const onPageUnload = () => {
		pageIsUnloading = true;
		saveCurrentProgress();
		if (_activePlayerReloadSession) {
			writePlayerReloadSession({
				..._activePlayerReloadSession,
				wasPlaying: playbackShouldResume,
			});
		}
	};
	const onSubtitleTimeUpdate = () => {
		if (currentPlayer) void prefetchActiveLibavSubtitle(currentPlayer);
	};
	const onSubtitleSeeking = () => {
		const state = _activeLibavSubtitle;
		// Initial extraction has not created an active segmented-subtitle state yet.
		// Do not cancel it when ArtPlayer seeks to a restored start position: there
		// would be no state for the seeked handler to refill, leaving subtitles off.
		if (!state || state.player !== currentPlayer || !state.loading) return;
		cancelActiveLibavSubtitleExtraction();
		state.loading = false;
	};
	const onVideoSeeked = () => {
		saveCurrentProgress();
		if (currentPlayer) void prefetchActiveLibavSubtitle(currentPlayer);
	};
	currentPlayer.on("video:play", onPlaybackStateChange);
	currentPlayer.on("video:pause", onPlaybackStateChange);
	currentPlayer.on("video:seeking", onSubtitleSeeking);
	currentPlayer.on("video:seeked", onVideoSeeked);
	currentPlayer.on("video:timeupdate", onSubtitleTimeUpdate);
	window.addEventListener("pagehide", onPageUnload);
	window.addEventListener("beforeunload", onPageUnload);

	_cleanupBeforeDestroy = () => {
		videoRendererWarmupCleanup?.();
		if (mkvMetadataExtractionTimer !== 0) {
			window.clearTimeout(mkvMetadataExtractionTimer);
			mkvMetadataExtractionTimer = 0;
		}
		if (mp4SubtitleExtractionTimer !== 0) {
			window.clearTimeout(mp4SubtitleExtractionTimer);
			mp4SubtitleExtractionTimer = 0;
		}
		if (alternativeVideoDecoderEnabled) {
			Win.dispatchEvent(
				new CustomEvent("cd2-video-renderer-close", {
					detail: { sessionNonce },
				}),
			);
		}
		networkSpeedTracker.destroy();
		browserAudioFallback?.destroy();
		window.clearInterval(progressSaveTimer);
		responsiveControlsObserver.disconnect();
		window.removeEventListener("pagehide", onPageUnload);
		window.removeEventListener("beforeunload", onPageUnload);
		currentPlayer?.off("artplayerPluginDanmuku:config", onDanmakuConfig);
		currentPlayer?.off(
			"artplayerPluginDanmuku:show",
			saveCurrentDanmakuPreferences,
		);
		currentPlayer?.off(
			"artplayerPluginDanmuku:hide",
			saveCurrentDanmakuPreferences,
		);
		currentPlayer?.off("video:volumechange", savePlayerPreferences);
		currentPlayer?.off("video:ratechange", savePlayerPreferences);
		currentPlayer?.off("aspectRatio", savePlayerPreferences);
		currentPlayer?.off("control", onPlayerControl);
		currentPlayer?.off("video:play", onPlaybackStateChange);
		currentPlayer?.off("video:pause", onPlaybackStateChange);
		currentPlayer?.off("video:seeking", onSubtitleSeeking);
		currentPlayer?.off("video:seeked", onVideoSeeked);
		currentPlayer?.off("video:timeupdate", onSubtitleTimeUpdate);
		cleanupMkvExtracted();
		// 用原始描述符恢复（因为 getExt 是只读 getter，不能直接赋值）
		if (_originalGetExtDescriptor) {
			try {
				Object.defineProperty(
					Artplayer.utils,
					"getExt",
					_originalGetExtDescriptor,
				);
			} catch (_) {
				/* ignore */
			}
		}
	};

	// --- 并行执行字幕识别任务 ---

	// 1. 调用方已经解析出的外挂字幕应立即显示，不再重复扫描 CloudDrive2。
	_currentSubtitles = subtitles ?? [];
	applySubtitles(_currentSubtitles);
	if (filePath && _currentSubtitles.length === 0) {
		resolveSubtitlesFromOffline(filePath)
			.then((subs) => {
				if (!isCurrentSession()) return;
				_currentSubtitles = subs;
				applySubtitles(_currentSubtitles);
			})
			.catch((err) => {
				console.warn("[cd2-artplayer] 获取外挂字幕失败:", err);
			});
	}

	// 2. 快速识别 MKV/MP4 内嵌轨道
	const mediaExtension = fileName
		.toLowerCase()
		.match(/\.([^.?#]+)(?:[?#]|$)/)?.[1];
	if (mediaExtension === "mkv") {
		const startMkvMetadataExtraction = () => {
			mkvMetadataExtractionTimer = 0;
			if (!isCurrentSession()) return;
			extractMkvMetadata(url).then((mkvSubs) => {
				if (!isCurrentSession()) return;
				if (mkvSubs.length > 0) {
					_mkvExtractedSubs.push(...mkvSubs);
					applySubtitles(_currentSubtitles);
				}
			});
		};
		deferMediaMetadata(startMkvMetadataExtraction, (timer) => {
			mkvMetadataExtractionTimer = timer;
		});
	}
	if (
		mediaExtension === "mp4" ||
		mediaExtension === "m4v" ||
		mediaExtension === "mov"
	) {
		const startMp4SubtitleExtraction = () => {
			mp4SubtitleExtractionTimer = 0;
			if (!isCurrentSession()) return;
			extractMp4Subtitle(url, gmFetchAdapter)
				.then((mp4Subs) => {
					if (!isCurrentSession()) {
						for (const subtitle of mp4Subs) URL.revokeObjectURL(subtitle.url);
						return;
					}
					if (mp4Subs.length > 0) {
						const subs = mp4Subs.map((s) => ({
							url: s.url,
							fileName: `[MP4内嵌] ${s.name} (${s.ext.toUpperCase()})`,
							isLocal: false,
							ext: s.ext,
							isDeferred: false,
						}));
						_mkvExtractedSubs.push(...subs);
						for (const s of subs) {
							_blobUrlExtCache.set(s.url, s.ext);
						}
						applySubtitles(_currentSubtitles);
					}
				})
				.catch((e) => console.warn("[cd2-artplayer] MP4内嵌提取失败:", e));
		};
		// Let the native/custom video path establish its first frame before the
		// second MP4 moov reader competes for the same slow Range source.
		deferMediaMetadata(startMp4SubtitleExtraction, (timer) => {
			mp4SubtitleExtractionTimer = timer;
		});
	}

	// 3. 初始化音频轨道菜单
	if (currentPlayer) {
		setupAudioTracks(currentPlayer);
	}

	// 自动匹配弹幕
	autoMatch(
		fileName,
		panelEls,
		onSelectEpisode,
		(text: string) => {
			if (!isCurrentSession()) return;
			danmakuStatusText = text;
			updateControlText();
		},
		(animes: SearchAnime[], useDirect: boolean) => {
			if (!isCurrentSession()) return;
			_lastAnimes = animes;
			_lastUseDirect = useDirect;
		},
		isCurrentSession,
	);
}

// ─── 字幕功能（控制栏按钮） ────────────────────────────

function cleanupMkvExtracted() {
	cancelActiveLibavSubtitleExtraction();
	_activeLibavSubtitle = null;
	for (const sub of _mkvExtractedSubs) {
		if (sub.url.startsWith("blob:")) {
			_blobUrlExtCache.delete(sub.url);
			URL.revokeObjectURL(sub.url);
		}
	}
	_mkvExtractedSubs = [];
	for (const url of _externalSubtitleBlobUrls.values()) {
		_blobUrlExtCache.delete(url);
		URL.revokeObjectURL(url);
	}
	_externalSubtitleBlobUrls.clear();
	for (const url of _assFallbackBlobUrls.values()) {
		_blobUrlExtCache.delete(url);
		URL.revokeObjectURL(url);
	}
	_assFallbackBlobUrls.clear();
	_assSubtitleContentCache.clear();
	_mkvExtractionPromise = null;
}

function bytesToBlobPart(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function decodeSubtitle(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		return new TextDecoder("utf-8").decode(bytes.subarray(3));
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("gb18030").decode(bytes);
	}
}

/** 通过扩展后台/GM 请求读取字幕，再转成本地 UTF-8 Blob，消除 CORS 与 URL 后缀问题。 */
async function materializeSubtitle(
	item: SubtitleSelectorItem,
): Promise<string> {
	if (!item.url || item.url.startsWith("blob:") || item.url.startsWith("data:"))
		return item.url;
	const cached = _externalSubtitleBlobUrls.get(item.url);
	if (cached) return cached;
	const response = await gmFetchAdapter(item.url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const text = decodeSubtitle(await response.arrayBuffer());
	const ext = item.ext || getSubtitleType(item.url) || "vtt";
	const mime =
		ext === "ass" || ext === "ssa"
			? "text/x-ssa"
			: ext === "vtt"
				? "text/vtt"
				: "application/x-subrip";
	const blobUrl = URL.createObjectURL(
		new Blob([text], { type: `${mime};charset=utf-8` }),
	);
	_externalSubtitleBlobUrls.set(item.url, blobUrl);
	_blobUrlExtCache.set(blobUrl, ext);
	if (ext === "ass" || ext === "ssa") {
		_assSubtitleContentCache.set(blobUrl, text);
	}
	return blobUrl;
}

function getSubtitleType(fileName: string): string | null {
	const match = fileName.match(/\\.([^.]+)$/);
	if (!match) return null;
	const ext = match[1].toLowerCase();
	return ["srt", "ass", "vtt", "ssa"].includes(ext) ? ext : null;
}

/** 异步解析视频 URL 的可加载外挂字幕列表 */
function resolveVideoUrlFromOffline(filePath: string): Promise<string | null> {
	return new Promise((resolve, reject) => {
		if (typeof Win === "undefined") {
			resolve(null);
			return;
		}
		const requestId = `video_${Math.random().toString(36).substring(2)}`;
		const timeoutId = window.setTimeout(() => {
			Win.removeEventListener("cd2-video-url-resolved", handler);
			resolve(null);
		}, 15000);
		const handler = (e: Event) => {
			const ce = e as CustomEvent;
			if (ce.detail?.requestId !== requestId) {
				return;
			}
			window.clearTimeout(timeoutId);
			Win.removeEventListener("cd2-video-url-resolved", handler);
			if (ce.detail.error) {
				reject(new Error(ce.detail.error));
				return;
			}
			resolve(ce.detail.videoUrl || null);
		};
		Win.addEventListener("cd2-video-url-resolved", handler);
		Win.dispatchEvent(
			new CustomEvent("cd2-resolve-video-url", {
				detail: { requestId, filePath },
			}),
		);
	});
}

function resolveSubtitlesFromOffline(
	filePath: string,
): Promise<SubtitleItem[]> {
	return new Promise((resolve, reject) => {
		if (typeof Win === "undefined") {
			resolve([]);
			return;
		}
		const requestId = `subtitle_${Math.random().toString(36).substring(2)}`;
		const timeoutId = window.setTimeout(() => {
			Win.removeEventListener("cd2-subtitles-resolved", handler);
			resolve([]);
		}, 15000);
		const handler = (e: Event) => {
			const ce = e as CustomEvent;
			if (ce.detail?.requestId !== requestId) {
				return;
			}
			window.clearTimeout(timeoutId);
			Win.removeEventListener("cd2-subtitles-resolved", handler);
			if (ce.detail.error) {
				reject(new Error(ce.detail.error));
				return;
			}
			resolve(ce.detail.subtitles || []);
		};
		Win.addEventListener("cd2-subtitles-resolved", handler);
		Win.dispatchEvent(
			new CustomEvent("cd2-resolve-subtitles", {
				detail: { requestId, filePath },
			}),
		);
	});
}

/** 仅提取 MKV 元数据，实现秒级识别轨道 */
async function extractMkvMetadata(videoUrl: string): Promise<SubtitleItem[]> {
	const results: SubtitleItem[] = [];
	try {
		console.log("[cd2-artplayer] 开始快速识别 MKV 轨道:", videoUrl);
		const tracks = await readMkvSubtitleTracks(videoUrl, gmFetchAdapter);

		if (!tracks || tracks.length === 0) return results;

		for (const [subtitleIndex, track] of tracks.entries()) {
			if (track.type === "unsupported") {
				console.warn(
					`[cd2-artplayer] 暂不支持的 MKV 字幕编码: ${track.codecId}`,
				);
				continue;
			}
			const ext = track.type === "ssa" ? "ass" : track.type;
			results.push({
				url: "",
				fileName: `[MKV内嵌] ${track.trackName || track.language || `Track ${track.trackNumber}`} (${ext.toUpperCase()})`,
				ext,
				mkvTrackId: track.trackNumber,
				mkvSubtitleIndex: subtitleIndex,
				isDeferred: true,
				isDefault: track.isDefault,
				isForced: track.isForced,
			});
		}
	} catch (e) {
		console.warn("[cd2-artplayer] MKV 元数据识别失败:", e);
	}
	return results;
}

function _injectAssFonts(fonts: NonNullable<TrackResult["output"]["fonts"]>) {
	if (typeof document === "undefined") return;
	for (const font of fonts) {
		const blob = new window.Blob([bytesToBlobPart(font.data)], {
			type: "font/ttf",
		});
		const objUrl = window.URL.createObjectURL(blob);
		const fontFace = new FontFace(font.name, `url("${objUrl}")`);
		fontFace
			.load()
			.then((loadedFont) => {
				document.fonts.add(loadedFont);
				console.log(`[cd2-artplayer] 载入内嵌字体成功: ${font.name}`);
			})
			.catch((err) => {
				console.warn(`[cd2-artplayer] 字体 ${font.name} 解析失败:`, err);
			});
	}
}

async function safeSwitchAss(art: Artplayer, url: string): Promise<void> {
	const assPlugin = art.plugins
		?.artplayerPluginLibass as unknown as AssPluginLike;
	if (!assPlugin || typeof assPlugin.switch !== "function") {
		throw new Error("ASS 字幕渲染器不可用");
	}
	const ready = assPlugin.ready?.() ?? Promise.resolve();
	await Promise.race([
		ready,
		new Promise<never>((_, reject) =>
			window.setTimeout(
				() => reject(new Error("ASS 字幕渲染器初始化超时")),
				8000,
			),
		),
	]);
	await assPlugin.switch(url, _assSubtitleContentCache.get(url));
	if (art.video && art.video.videoWidth > 0 && art.video.videoHeight > 0) {
		assPlugin.show?.();
		return;
	}
	await new Promise<void>((resolve) => {
		art.once("video:loadedmetadata", () => resolve());
	});
	assPlugin.show?.();
}

function getAssFallbackUrl(sourceUrl: string): string {
	const cached = _assFallbackBlobUrls.get(sourceUrl);
	if (cached) return cached;
	const content = _assSubtitleContentCache.get(sourceUrl);
	if (!content) throw new Error("没有可用于降级显示的 ASS 字幕内容");
	const url = URL.createObjectURL(
		new Blob([assToWebVtt(content)], { type: "text/vtt;charset=utf-8" }),
	);
	_assFallbackBlobUrls.set(sourceUrl, url);
	_blobUrlExtCache.set(url, "vtt");
	return url;
}

async function applyAssSubtitle(art: Artplayer, url: string): Promise<void> {
	const assPlugin = art.plugins
		?.artplayerPluginLibass as unknown as AssPluginLike;
	let fallbackApplied = false;
	const applyFallback = () => {
		const fallbackUrl = getAssFallbackUrl(url);
		art.subtitle.switch(fallbackUrl, { type: "vtt" });
		art.subtitle.show = true;
		fallbackApplied = true;
	};
	// Only show the unstyled layer until libass proves it can draw once. Keeping
	// this state across rolling-window track updates prevents VTT -> ASS flashes.
	if (!assPlugin?.rendered) applyFallback();
	try {
		await safeSwitchAss(art, url);
	} catch (error) {
		console.warn(
			"[cd2-artplayer] libass 不可用，切换到 WebVTT 保底字幕:",
			error,
		);
		if (!fallbackApplied) applyFallback();
		art.notice.show = "ASS 样式渲染失败，已使用基础字幕";
	}
}

/** 整理选择器，配置 ArtPlayer 控制栏里的字幕菜单 */
function applySubtitles(externalSubs: SubtitleItem[]) {
	if (!currentPlayer) return;

	// 生成原生内嵌字幕列表 (浏览器能识别的部分，通常为空)
	const nativeSubs: SubtitleItem[] = [];
	try {
		const tracks = currentPlayer.video.textTracks;
		if (tracks && tracks.length > 0) {
			for (let i = 0; i < tracks.length; i++) {
				const track = tracks[i];
				if (track.kind === "subtitles" || track.kind === "captions") {
					nativeSubs.push({
						url: "",
						fileName: `[浏览器内嵌] ${track.label || track.language || `Track ${i + 1}`}`,
						isLocal: false,
					});
				}
			}
		}
	} catch (_e) {
		/* ignore */
	}

	const allSubs = [...externalSubs, ..._mkvExtractedSubs, ...nativeSubs];
	if (allSubs.length === 0) return;

	const selector: Array<SubtitleSelectorItem & { default: boolean }> = [];
	const offItem: SubtitleSelectorItem & { default: boolean } = {
		default: false,
		html: "关闭字幕",
		url: "",
		ext: "",
		isNativeType: false,
	};
	selector.push(offItem);
	allSubs.forEach((s) => {
		const ext = s.ext || getSubtitleType(s.fileName) || "vtt";
		selector.push({
			default: false,
			html: s.fileName,
			url: s.url,
			ext: ext,
			isNativeType: s.url === "" && !s.mkvTrackId,
			mkvTrackId: s.mkvTrackId,
			mkvSubtitleIndex: s.mkvSubtitleIndex,
			isDeferred: s.isDeferred,
			isDefault: s.isDefault,
			isForced: s.isForced,
		});
	});

	const rememberedIdentity = _currentSubtitleVideoKey
		? subtitleMemory.get(_currentSubtitleVideoKey)?.identity
		: undefined;
	let target = rememberedIdentity
		? selector.find((item) => subtitleIdentity(item) === rememberedIdentity)
		: undefined;
	if (!rememberedIdentity) {
		target = selector
			.slice(1)
			.sort(
				(left, right) => autoSubtitleScore(right) - autoSubtitleScore(left),
			)[0];
	}
	const targetIdentity = target ? subtitleIdentity(target) : "off";
	for (const item of selector) {
		item.default = subtitleIdentity(item) === targetIdentity;
	}

	currentPlayer.controls.update({
		name: "subtitle-selector",
		selector: selector,
	});
	if (
		target &&
		targetIdentity !== "off" &&
		_currentSubtitleIdentity !== targetIdentity &&
		_pendingSubtitleIdentity !== targetIdentity
	) {
		const player = currentPlayer;
		const sessionNonce = _playerSessionNonce;
		const videoKey = _currentSubtitleVideoKey;
		_pendingSubtitleIdentity = targetIdentity;
		void _autoSubtitleActivationBarrier.then(() => {
			if (
				currentPlayer !== player ||
				sessionNonce !== _playerSessionNonce ||
				videoKey !== _currentSubtitleVideoKey ||
				_pendingSubtitleIdentity !== targetIdentity ||
				_currentSubtitleIdentity !== null
			) {
				return;
			}
			return activateSubtitleSelection(
				target,
				player,
				sessionNonce,
				true,
			).catch((error) => {
				if (isCanceledExtensionRequest(error)) return;
				console.warn("[cd2-artplayer] 默认字幕加载失败:", error);
				if (currentPlayer === player) {
					player.notice.show = `字幕加载失败: ${(error as Error).message}`;
				}
			});
		});
	}
}

interface LibavSubtitleResult {
	content: string;
	codec: string;
	format: "ass" | "vtt";
	startTime: number;
	endTime: number;
}

function dialogueTimestamp(line: string): number {
	const match = line.match(
		/^Dialogue\s*:\s*[^,]*,(\d+):(\d{2}):(\d{2})[.](\d{1,3}),/i,
	);
	if (!match) return Number.POSITIVE_INFINITY;
	return (
		Number(match[1]) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(`0.${match[4]}`)
	);
}

function mergeAssContent(current: string, incoming: string): string {
	const currentLines = current.replace(/\r\n/g, "\n").split("\n");
	const incomingLines = incoming.replace(/\r\n/g, "\n").split("\n");
	const header = currentLines.filter(
		(line) => !/^Dialogue\s*:/i.test(line.trim()),
	);
	const dialogues = new Set(
		[...currentLines, ...incomingLines]
			.map((line) => line.trim())
			.filter((line) => /^Dialogue\s*:/i.test(line)),
	);
	return `${header.join("\n").trimEnd()}\n${[...dialogues]
		.sort((left, right) => dialogueTimestamp(left) - dialogueTimestamp(right))
		.join("\n")}\n`;
}

function vttCueTimestamp(block: string): number {
	const match = block.match(/(\d{2,}):(\d{2}):(\d{2})[.](\d{3})\s+-->/);
	if (!match) return Number.POSITIVE_INFINITY;
	return (
		Number(match[1]) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(match[4]) / 1000
	);
}

function mergeVttContent(current: string, incoming: string): string {
	const cues = new Set<string>();
	for (const content of [current, incoming]) {
		for (const block of content.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
			const normalized = block.trim();
			if (!normalized || /^WEBVTT(?:\s|$)/i.test(normalized)) continue;
			if (!/-->/.test(normalized)) continue;
			cues.add(normalized);
		}
	}
	return `WEBVTT\n\n${[...cues]
		.sort((left, right) => vttCueTimestamp(left) - vttCueTimestamp(right))
		.join("\n\n")}${cues.size ? "\n" : ""}`;
}

function addCoveredSubtitleRange(
	ranges: Array<{ start: number; end: number }>,
	incoming: { start: number; end: number },
): void {
	let start = incoming.start;
	let end = incoming.end;
	for (let index = ranges.length - 1; index >= 0; index -= 1) {
		const range = ranges[index];
		if (range.end < start || range.start > end) continue;
		start = Math.min(start, range.start);
		end = Math.max(end, range.end);
		ranges.splice(index, 1);
	}
	ranges.push({ start, end });
	ranges.sort((left, right) => left.start - right.start);
}

function extractSubtitleWithLibav(
	videoUrl: string,
	subtitleIndex: number,
	currentTime: number,
	lookBehind = 1,
	lookAhead = 1,
): Promise<LibavSubtitleResult> {
	cancelActiveLibavSubtitleExtraction();
	const requestId = `libav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	_activeLibavExtractRequestId = requestId;
	return new Promise((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			Win.removeEventListener("cd2-libav-subtitle-resolved", handler);
			if (_activeLibavExtractRequestId === requestId) {
				_activeLibavExtractRequestId = null;
			}
			Win.dispatchEvent(
				new CustomEvent("cd2-libav-cancel-subtitle", {
					detail: { requestId },
				}),
			);
			reject(new Error("浏览器内置 Matroska 解封装器响应超时"));
		}, 125000);
		const handler = (event: Event) => {
			const detail = (
				event as CustomEvent<
					LibavSubtitleResult & { requestId: string; error?: string }
				>
			).detail;
			if (detail.requestId !== requestId) return;
			window.clearTimeout(timeoutId);
			Win.removeEventListener("cd2-libav-subtitle-resolved", handler);
			if (_activeLibavExtractRequestId === requestId) {
				_activeLibavExtractRequestId = null;
			}
			if (detail.error) reject(new Error(detail.error));
			else resolve(detail);
		};
		Win.addEventListener("cd2-libav-subtitle-resolved", handler);
		Win.dispatchEvent(
			new CustomEvent("cd2-libav-extract-subtitle", {
				detail: {
					requestId,
					videoUrl,
					subtitleIndex,
					startTime: Math.max(0, currentTime - lookBehind),
					endTime: currentTime + lookAhead,
				},
			}),
		);
	});
}

function cancelActiveLibavSubtitleExtraction(): void {
	const requestId = _activeLibavExtractRequestId;
	if (!requestId) return;
	_activeLibavExtractRequestId = null;
	Win.dispatchEvent(
		new CustomEvent("cd2-libav-cancel-subtitle", {
			detail: { requestId },
		}),
	);
}

async function prefetchActiveLibavSubtitle(player: Artplayer): Promise<void> {
	const state = _activeLibavSubtitle;
	if (
		!state ||
		state.player !== player ||
		state.sessionNonce !== _playerSessionNonce ||
		state.loading
	) {
		return;
	}
	const currentTime = player.currentTime;
	let coveringRange: (typeof state.ranges)[number] | undefined;
	for (const range of state.ranges) {
		if (
			currentTime >= range.start &&
			currentTime <= range.end &&
			(!coveringRange || range.end > coveringRange.end)
		) {
			coveringRange = range;
		}
	}
	if (coveringRange && currentTime < coveringRange.end - 2) return;
	state.loading = true;
	const requestNonce = ++state.requestNonce;
	try {
		const targetTime = coveringRange
			? Math.max(currentTime, coveringRange.end - 1)
			: currentTime;
		const extracted = await extractSubtitleWithLibav(
			player.url,
			state.subtitleIndex,
			targetTime,
			3,
			8,
		);
		if (_activeLibavSubtitle !== state || currentPlayer !== player) return;
		const mergedContent =
			state.format === "ass"
				? mergeAssContent(state.content, extracted.content)
				: mergeVttContent(state.content, extracted.content);
		addCoveredSubtitleRange(state.ranges, {
			start: extracted.startTime,
			end: extracted.endTime,
		});
		if (mergedContent === state.content) return;
		state.content = mergedContent;
		if (state.format === "ass") {
			_assSubtitleContentCache.set(state.url, state.content);
			const oldFallback = _assFallbackBlobUrls.get(state.url);
			if (oldFallback) {
				URL.revokeObjectURL(oldFallback);
				_blobUrlExtCache.delete(oldFallback);
				_assFallbackBlobUrls.delete(state.url);
			}
			await applyAssSubtitle(player, state.url);
		} else {
			const previousUrl = state.url;
			const nextUrl = storeExtractedSubtitle(state.content, "vtt", state.item);
			state.url = nextUrl;
			player.subtitle.switch(nextUrl, { type: "vtt" });
			player.subtitle.show = true;
			_blobUrlExtCache.delete(previousUrl);
			URL.revokeObjectURL(previousUrl);
		}
	} catch (error) {
		if (isCanceledExtensionRequest(error)) {
			const message = error instanceof Error ? error.message : String(error);
			// A seek/track change cancels only the obsolete request. Keep the active
			// subtitle state so the seeked handler can immediately load the new window.
			if (!/operation canceled/i.test(message)) _activeLibavSubtitle = null;
			return;
		}
		console.warn("[cd2-artplayer] 预读取下一段内嵌字幕失败:", error);
	} finally {
		if (_activeLibavSubtitle === state && state.requestNonce === requestNonce) {
			state.loading = false;
		}
	}
}

function storeExtractedSubtitle(
	content: string | Uint8Array,
	ext: string,
	item: SubtitleSelectorItem,
	cachedSubtitle?: SubtitleItem,
): string {
	const blob = new window.Blob(
		[typeof content === "string" ? content : bytesToBlobPart(content)],
		{
			type:
				ext === "ass"
					? "text/x-ssa;charset=utf-8"
					: ext === "vtt"
						? "text/vtt;charset=utf-8"
						: "text/plain;charset=utf-8",
		},
	);
	const url = window.URL.createObjectURL(blob);
	_blobUrlExtCache.set(url, ext);
	if (ext === "ass") {
		_assSubtitleContentCache.set(
			url,
			typeof content === "string" ? content : new TextDecoder().decode(content),
		);
	}
	const sub =
		cachedSubtitle ??
		_mkvExtractedSubs.find((entry) => entry.mkvTrackId === item.mkvTrackId);
	if (sub) {
		sub.url = url;
		sub.isDeferred = false;
		sub.ext = ext;
	}
	item.url = url;
	item.ext = ext;
	item.isDeferred = false;
	return url;
}

/** 动态加载延迟识别的内嵌字幕内容 */
async function loadDeferredSubtitle(
	item: SubtitleSelectorItem,
	player: Artplayer,
	sessionNonce: number,
): Promise<string | null> {
	if (
		!item.mkvTrackId ||
		!player ||
		currentPlayer !== player ||
		sessionNonce !== _playerSessionNonce
	) {
		return null;
	}

	const cachedSubtitle = _mkvExtractedSubs.find(
		(sub) => sub.mkvTrackId === item.mkvTrackId,
	);
	const supportsSegmentedLibav =
		isExtensionBuild &&
		["ass", "ssa", "srt", "vtt"].includes(item.ext ?? "") &&
		item.mkvSubtitleIndex !== undefined;
	const shouldRefreshLibav =
		supportsSegmentedLibav && _activeLibavSubtitle?.url !== cachedSubtitle?.url;
	if (cachedSubtitle?.url && !shouldRefreshLibav) {
		cachedSubtitle.isDeferred = false;
		return cachedSubtitle.url;
	}

	try {
		player.notice.show = "正在使用浏览器内置解封装器读取字幕...";
		if (supportsSegmentedLibav && item.mkvSubtitleIndex !== undefined) {
			_activeLibavSubtitle = null;
			const extracted = await extractSubtitleWithLibav(
				player.url,
				item.mkvSubtitleIndex,
				player.currentTime,
			);
			if (currentPlayer !== player || sessionNonce !== _playerSessionNonce) {
				return null;
			}
			const subtitleUrl = storeExtractedSubtitle(
				extracted.content,
				extracted.format,
				item,
				cachedSubtitle,
			);
			_activeLibavSubtitle = {
				player,
				sessionNonce,
				subtitleIndex: item.mkvSubtitleIndex,
				format: extracted.format,
				item,
				url: subtitleUrl,
				content: extracted.content,
				ranges: [{ start: extracted.startTime, end: extracted.endTime }],
				loading: false,
				requestNonce: 0,
			};
			if (extracted.format === "vtt" && !extracted.content.includes("-->")) {
				player.notice.show = /forced|强制/i.test(item.html)
					? "该强制字幕轨在当前时间段没有内容"
					: "该字幕轨在当前时间段没有内容，将继续预读";
			}
			return subtitleUrl;
		}

		player.notice.show = "正在提取内嵌字幕，请稍候...";
		_mkvExtractionPromise ??= extractSubtitles(player.url, {
			fetch: gmFetchAdapter,
			concurrency: 4,
		});
		const tracks = await _mkvExtractionPromise;
		if (currentPlayer !== player || sessionNonce !== _playerSessionNonce) {
			return null;
		}
		const target = tracks.find(
			(t) => t.metadata.trackNumber === item.mkvTrackId,
		);
		if (target?.output.subtitle) {
			const ext = target.type === "ssa" ? "ass" : target.type;
			return storeExtractedSubtitle(
				target.output.subtitle,
				ext,
				item,
				cachedSubtitle,
			);
		}
	} catch (e) {
		_mkvExtractionPromise = null;
		if (isCanceledExtensionRequest(e)) throw e;
		console.error("[cd2-artplayer] 提取字幕内容失败:", e);
		if (currentPlayer === player && sessionNonce === _playerSessionNonce) {
			player.notice.show = `字幕加载失败: ${(e as Error).message}`;
		}
		throw e;
	}
	return null;
}

/** 提取/应用多音轨列表 */
function setupAudioTracks(art: Artplayer) {
	try {
		const audioTracks = (
			art.video as HTMLVideoElement & {
				audioTracks?: AudioTrackListLike;
			}
		).audioTracks;
		if (!audioTracks || audioTracks.length <= 1) return;
		const selector: Array<AudioTrackSelectorItem & { default: boolean }> = [];
		for (let i = 0; i < audioTracks.length; i++) {
			selector.push({
				default: audioTracks[i].enabled,
				html:
					audioTracks[i].label || audioTracks[i].language || `Track ${i + 1}`,
				index: i,
			});
		}
		art.controls.add({
			name: "audio-selector",
			position: "right",
			index: 11,
			html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer" title="音轨">\uD83C\uDFB5</div>`,
			selector,
			onSelect: (selector) => {
				const item = selector as AudioTrackSelectorItem;
				for (let i = 0; i < audioTracks.length; i++) {
					audioTracks[i].enabled = i === item.index;
				}
				return item.html;
			},
		});
	} catch (_e) {
		// ignore
	}
}

// ─── 自动匹配弹幕（多策略，直连优先/API后备）────────────

async function autoMatch(
	fileName: string,
	panelEls: ReturnType<typeof createDanmakuPanel>,
	onSelect: (id: number, label: string, useDirect?: boolean) => Promise<number>,
	setStatus: (text: string) => void,
	setLastAnimes: (animes: SearchAnime[], useDirect: boolean) => void,
	isCurrent: () => boolean,
) {
	if (!isCurrent()) return;
	const keyword = extractKeyword(fileName);
	if (keyword) panelEls.input.value = keyword;

	const mode = getDanmuMode();
	console.log(
		`[cd2-artplayer] 当前弹幕模式: ${mode} (${getDanmuModeLabel(mode)})`,
	);

	// ══════════════════════════════════════════════════
	// 阶段1：直连弹弹Play代理（mode=auto 或 mode=direct 时执行）
	// ══════════════════════════════════════════════════
	if (mode !== "api") {
		try {
			console.log("[cd2-artplayer] ═══ 阶段1: 直连弹弹Play代理 ═══");

			// ── 直连策略1: 文件名匹配 ──
			console.log("[cd2-artplayer] 直连策略1: 文件名匹配, fileName=", fileName);
			setStatus("直连匹配中...");
			const directMatchResult = await directMatchVideo(fileName);
			if (!isCurrent()) return;

			if (directMatchResult.isMatched && directMatchResult.matches.length > 0) {
				const match = directMatchResult.matches[0];
				renderMatches(
					panelEls.body,
					directMatchResult.matches,
					(id, label) => onSelect(id, label, true),
					match.episodeId,
				);
				const directCount = await onSelect(
					match.episodeId,
					match.episodeTitle,
					true,
				);
				if (!isCurrent()) return;
				if (directCount <= 0 && mode === "auto") {
					throw new Error("直连匹配成功但没有弹幕，回退到 API");
				}
				return;
			}

			// ── 直连策略2: 关键词搜索 ──
			if (keyword) {
				console.log("[cd2-artplayer] 直连策略2: 关键词搜索, keyword=", keyword);
				setStatus("直连搜索中...");
				const directSearchResult = await directSearchEpisodes(keyword);
				if (!isCurrent()) return;

				if (directSearchResult.animes.length > 0) {
					setLastAnimes(directSearchResult.animes, true);
					const best = findBestEpisode(fileName, directSearchResult.animes);
					renderAnimes(
						panelEls.body,
						directSearchResult.animes,
						(id, label) => onSelect(id, label, true),
						best?.episodeId,
					);

					if (best) {
						const directCount = await onSelect(
							best.episodeId,
							best.episodeTitle,
							true,
						);
						if (directCount <= 0 && mode === "auto") {
							throw new Error("直连搜索成功但没有弹幕，回退到 API");
						}
						return;
					}

					setStatus(
						`直连找到 ${directSearchResult.animes.length} 部番剧，点击选集`,
					);
					if (!isCurrent()) return;
					if (currentPlayer)
						currentPlayer.notice.show =
							"已搜索到番剧(直连)，请点击弹幕按钮选择集数";
					return;
				}

				// ── 直连策略3: 缩短关键词再搜 ──
				const shortKeyword = keyword.split(" ").slice(0, 2).join(" ");
				if (shortKeyword !== keyword && shortKeyword.length >= 2) {
					console.log(
						"[cd2-artplayer] 直连策略3: 缩短关键词搜索, keyword=",
						shortKeyword,
					);
					panelEls.input.value = shortKeyword;
					const directRetryResult = await directSearchEpisodes(shortKeyword);
					if (!isCurrent()) return;
					if (directRetryResult.animes.length > 0) {
						setLastAnimes(directRetryResult.animes, true);
						const best = findBestEpisode(fileName, directRetryResult.animes);
						renderAnimes(
							panelEls.body,
							directRetryResult.animes,
							(id, label) => onSelect(id, label, true),
							best?.episodeId,
						);
						if (best) {
							const directCount = await onSelect(
								best.episodeId,
								best.episodeTitle,
								true,
							);
							if (directCount <= 0 && mode === "auto") {
								throw new Error("直连搜索成功但没有弹幕，回退到 API");
							}
							return;
						}
						setStatus(
							`直连找到 ${directRetryResult.animes.length} 部番剧，点击选集`,
						);
						if (!isCurrent()) return;
						if (currentPlayer)
							currentPlayer.notice.show =
								"已搜索到番剧(直连)，请点击弹幕按钮选择集数";
						return;
					}
				}
			}

			console.log("[cd2-artplayer] 直连弹弹Play代理未匹配到结果");
		} catch (err) {
			if (!isCurrent()) return;
			console.warn(
				"[cd2-artplayer] 直连弹弹Play代理失败:",
				(err as Error).message,
			);
			if (mode === "direct") {
				// 仅直连模式，不回退
				setStatus("直连匹配失败，点击搜索");
				renderStatus(
					panelEls.body,
					"直连匹配失败\n\n可手动输入番剧名搜索\n或切换到「自动」模式以启用API后备",
				);
				if (currentPlayer)
					currentPlayer.notice.show = "直连匹配失败，可点击弹幕按钮手动搜索";
				return;
			}
		}

		// 仅直连模式且未匹配到
		if (mode === "direct") {
			setStatus("未找到弹幕，点击搜索");
			renderStatus(
				panelEls.body,
				"直连未匹配到结果\n\n可手动输入番剧名搜索\n或切换到「自动」模式以启用API后备",
			);
			if (currentPlayer)
				currentPlayer.notice.show = "未自动匹配到弹幕，可点击弹幕按钮手动搜索";
			return;
		}
	} // end if (mode !== "api")

	// ══════════════════════════════════════════════════
	// 阶段2：danmu_api 服务（mode=auto回退 或 mode=api直接使用）
	// ══════════════════════════════════════════════════
	if (!hasApiUrl()) {
		setStatus("需配置API地址");
		renderStatus(
			panelEls.body,
			"未配置弹幕 API 地址\n\n请通过油猴菜单「⚙ 弹幕 API 配置」设置\n或切换到「直连」/「自动」模式",
		);
		if (currentPlayer)
			currentPlayer.notice.show = "需配置弹幕 API 地址，或切换弹幕模式";
		return;
	}

	try {
		console.log("[cd2-artplayer] ═══ 阶段2: 回退到 danmu_api 服务 ═══");

		// ── API策略1: 文件名匹配 ──
		console.log("[cd2-artplayer] API策略1: 文件名匹配, fileName=", fileName);
		setStatus("API匹配中...");
		const matchResult = await matchVideo(fileName);
		if (!isCurrent()) return;

		if (matchResult.isMatched && matchResult.matches.length > 0) {
			const match = matchResult.matches[0];
			renderMatches(
				panelEls.body,
				matchResult.matches,
				onSelect,
				match.episodeId,
			);
			await onSelect(match.episodeId, match.episodeTitle);
			if (!isCurrent()) return;
			return;
		}

		// ── API策略2: 关键词搜索 (原逻辑：番名+季数+集数 / 番名+季数) ──
		if (keyword) {
			console.log("[cd2-artplayer] API策略2: 关键词搜索, keyword=", keyword);
			setStatus("API搜索中...");
			panelEls.input.value = keyword;
			const searchResult = await searchEpisodes(keyword);
			if (!isCurrent()) return;

			if (searchResult.animes.length > 0) {
				setLastAnimes(searchResult.animes, false);
				const best = findBestEpisode(fileName, searchResult.animes);
				renderAnimes(
					panelEls.body,
					searchResult.animes,
					onSelect,
					best?.episodeId,
				);

				if (best) {
					await onSelect(best.episodeId, best.episodeTitle);
					if (!isCurrent()) return;
					return;
				}

				setStatus(`找到 ${searchResult.animes.length} 部番剧，点击选集`);
				if (currentPlayer)
					currentPlayer.notice.show =
						"已搜索到番剧(API)，请点击弹幕按钮选择集数";
				return;
			}

			// ── API策略3: 缩短关键词再搜 ──
			const shortKeyword = keyword.split(" ").slice(0, 2).join(" ");
			if (shortKeyword !== keyword && shortKeyword.length >= 2) {
				console.log(
					"[cd2-artplayer] API策略3: 缩短关键词搜索, keyword=",
					shortKeyword,
				);
				panelEls.input.value = shortKeyword;
				const retryResult = await searchEpisodes(shortKeyword);
				if (!isCurrent()) return;
				if (retryResult.animes.length > 0) {
					setLastAnimes(retryResult.animes, false);
					const best = findBestEpisode(fileName, retryResult.animes);
					renderAnimes(
						panelEls.body,
						retryResult.animes,
						onSelect,
						best?.episodeId,
					);
					if (best) {
						await onSelect(best.episodeId, best.episodeTitle);
						if (!isCurrent()) return;
						return;
					}
					setStatus(`找到 ${retryResult.animes.length} 部番剧，点击选集`);
					if (currentPlayer)
						currentPlayer.notice.show =
							"已搜索到番剧(API)，请点击弹幕按钮选择集数";
					return;
				}
			}
		}

		// 全部失败
		setStatus("未找到弹幕，点击搜索");
		renderStatus(panelEls.body, "自动匹配失败，请手动输入番剧名搜索");
		if (currentPlayer)
			currentPlayer.notice.show = "未自动匹配到弹幕，可点击弹幕按钮手动搜索";
	} catch (err) {
		if (!isCurrent()) return;
		console.error("[cd2-artplayer] API匹配异常:", err);
		setStatus("匹配失败，点击搜索");
		renderStatus(panelEls.body, `匹配出错: ${(err as Error).message}`);
	}
}
