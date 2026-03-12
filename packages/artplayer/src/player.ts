/**
 * ArtPlayer 播放器模块
 * 弹幕搜索集成到 ArtPlayer 控制栏
 */

import Artplayer from "artplayer";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
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
	hasApiUrl,
	type MatchItem,
	matchVideo,
	type SearchAnime,
	searchEpisodes,
} from "./danmu-api";

let currentPlayer: Artplayer | null = null;
let overlayEl: HTMLDivElement | null = null;

const CONTAINER_ID = "cd2-artplayer-container";
const OVERLAY_ID = "cd2-artplayer-overlay";

// ─── 样式 ────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById("cd2-artplayer-styles")) return;
	const style = document.createElement("style");
	style.id = "cd2-artplayer-styles";
	style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.92);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #fff;
    }
    #${OVERLAY_ID} .cd2-player-header {
      position: absolute; top: 0; left: 0; right: 0;
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 20px; z-index: 10; pointer-events: none;
    }
    #${OVERLAY_ID} .cd2-player-header > * { pointer-events: auto; }
    #${OVERLAY_ID} .cd2-player-title {
      font-size: 14px; opacity: 0.9; text-shadow: 0 1px 4px rgba(0,0,0,0.8);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;
    }
    #${OVERLAY_ID} .cd2-player-close {
      background: none; border: none; color: #fff; font-size: 24px;
      cursor: pointer; padding: 4px 8px; opacity: 0.7; transition: opacity 0.2s; flex-shrink: 0;
      text-shadow: 0 1px 4px rgba(0,0,0,0.8);
    }
    #${OVERLAY_ID} .cd2-player-close:hover { opacity: 1; }
    #${CONTAINER_ID} { width: 90vw; height: 80vh; max-width: 1400px; }

    /* 弹幕搜索浮层（在播放器内部） */
    .cd2-dm-panel {
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      z-index: 110; background: rgba(0,0,0,0.96); border: 1px solid rgba(255,255,255,0.12);
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
      background: none; border: none; color: #fff; opacity: 0.5; cursor: pointer; font-size: 18px;
    }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-close-panel:hover { opacity: 1; }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-mode-badge {
      font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
      background: rgba(22,119,255,0.2); color: #1677ff; border: 1px solid rgba(22,119,255,0.3);
      transition: all 0.15s; white-space: nowrap; user-select: none;
    }
    .cd2-dm-panel .cd2-dm-header .cd2-dm-mode-badge:hover {
      background: rgba(22,119,255,0.35); border-color: rgba(22,119,255,0.5);
    }
    .cd2-dm-panel .cd2-dm-search {
      display: flex; gap: 8px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .cd2-dm-panel .cd2-dm-search input {
      flex: 1; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.18);
      border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; outline: none;
    }
    .cd2-dm-panel .cd2-dm-search input::placeholder { color: rgba(255,255,255,0.35); }
    .cd2-dm-panel .cd2-dm-search input:focus { border-color: #1677ff; }
    .cd2-dm-panel .cd2-dm-search button {
      background: #1677ff; border: none; border-radius: 6px; padding: 8px 16px;
      color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap; font-weight: 500;
    }
    .cd2-dm-panel .cd2-dm-search button:hover { background: #4096ff; }
    .cd2-dm-panel .cd2-dm-body { overflow-y: auto; padding: 6px 0; flex: 1; }
    .cd2-dm-panel .cd2-dm-body::-webkit-scrollbar { width: 4px; }
    .cd2-dm-panel .cd2-dm-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
    .cd2-dm-panel .cd2-dm-group { padding: 0 16px; margin-bottom: 6px; }
    .cd2-dm-panel .cd2-dm-group-title {
      font-size: 13px; font-weight: 600; padding: 8px 0 4px; color: #1677ff;
    }
    .cd2-dm-panel .cd2-dm-ep {
      font-size: 12px; padding: 7px 10px; margin: 2px 0; border-radius: 6px;
      cursor: pointer; transition: all 0.15s; color: rgba(255,255,255,0.75);
    }
    .cd2-dm-panel .cd2-dm-ep:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .cd2-dm-panel .cd2-dm-ep.cd2-active { background: rgba(22,119,255,0.2); color: #1677ff; font-weight: 500; }
    .cd2-dm-panel .cd2-dm-status {
      padding: 20px 16px; text-align: center; font-size: 12px; color: rgba(255,255,255,0.4);
    }
  `;
	document.head.appendChild(style);
}

// ─── 弹幕面板 ───────────────────────────────────────────

function createDanmakuPanel(playerContainer: HTMLDivElement) {
	const panel = document.createElement("div");
	panel.className = "cd2-dm-panel";
	panel.innerHTML = `
    <div class="cd2-dm-header">
      <span>弹幕搜索</span>
      <span class="cd2-dm-mode-badge" title="点击切换匹配模式">${getDanmuModeLabel()}</span>
      <button class="cd2-dm-close-panel">✕</button>
    </div>
    <div class="cd2-dm-search">
      <input type="text" placeholder="输入番剧名搜索..." />
      <button>搜索</button>
    </div>
    <div class="cd2-dm-body">
      <div class="cd2-dm-status">等待自动匹配...</div>
    </div>
  `;

	// 放在播放器容器的父级（overlay），而不是 artplayer 内部
	playerContainer.parentElement?.appendChild(panel);

	// biome-ignore lint/style/noNonNullAssertion: Guaranteed by DOM structure
	const input = panel.querySelector<HTMLInputElement>(".cd2-dm-search input")!;
	// biome-ignore lint/style/noNonNullAssertion: Guaranteed by DOM structure
	const searchBtn = panel.querySelector<HTMLButtonElement>(
		".cd2-dm-search button",
	)!;
	// biome-ignore lint/style/noNonNullAssertion: Guaranteed by DOM structure
	const body = panel.querySelector<HTMLDivElement>(".cd2-dm-body")!;
	// biome-ignore lint/style/noNonNullAssertion: Guaranteed by DOM structure
	const closeBtn = panel.querySelector<HTMLButtonElement>(
		".cd2-dm-close-panel",
	)!;

	// 阻止键盘事件冒泡
	panel.addEventListener("keydown", (e) => e.stopPropagation());
	// 阻止点击关闭面板传播到播放器
	panel.addEventListener("click", (e) => e.stopPropagation());

	closeBtn.onclick = () => panel.classList.remove("cd2-show");

	// 模式切换徽章
	// biome-ignore lint/style/noNonNullAssertion: Guaranteed by DOM structure
	const modeBadge = panel.querySelector<HTMLSpanElement>(".cd2-dm-mode-badge")!;
	modeBadge.onclick = () => {
		const newMode = cycleDanmuMode();
		modeBadge.textContent = getDanmuModeLabel(newMode);
		if (currentPlayer)
			currentPlayer.notice.show = `弹幕模式已切换为: ${getDanmuModeLabel(newMode)}`;
	};

	const toggle = () => panel.classList.toggle("cd2-show");
	const hide = () => panel.classList.remove("cd2-show");

	return { panel, input, searchBtn, body, modeBadge, toggle, hide };
}

// ─── 渲染结果 ───────────────────────────────────────────

function renderMatches(
	body: HTMLDivElement,
	matches: MatchItem[],
	onSelect: (id: number, label: string) => void,
	activeId?: number,
) {
	body.innerHTML = "";
	if (matches.length === 0) {
		body.innerHTML = '<div class="cd2-dm-status">无匹配结果</div>';
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
		g.innerHTML = `<div class="cd2-dm-group-title">${title}</div>`;
		for (const item of items) {
			const el = document.createElement("div");
			el.className =
				"cd2-dm-ep" + (item.episodeId === activeId ? " cd2-active" : "");
			el.textContent = item.episodeTitle;
			el.onclick = () =>
				onSelect(item.episodeId, `${item.animeTitle} - ${item.episodeTitle}`);
			g.appendChild(el);
		}
		body.appendChild(g);
	}
}

function renderAnimes(
	body: HTMLDivElement,
	animes: SearchAnime[],
	onSelect: (id: number, label: string) => void,
) {
	body.innerHTML = "";
	if (animes.length === 0) {
		body.innerHTML =
			'<div class="cd2-dm-status">无搜索结果，换个关键词试试</div>';
		return;
	}
	for (const anime of animes) {
		const g = document.createElement("div");
		g.className = "cd2-dm-group";
		g.innerHTML = `<div class="cd2-dm-group-title">${anime.animeTitle}（${anime.typeDescription}）</div>`;
		for (const ep of anime.episodes) {
			const el = document.createElement("div");
			el.className = "cd2-dm-ep";
			el.textContent = ep.episodeTitle;
			el.onclick = () =>
				onSelect(ep.episodeId, `${anime.animeTitle} - ${ep.episodeTitle}`);
			g.appendChild(el);
		}
		body.appendChild(g);
	}
}

// ─── 覆盖层 ─────────────────────────────────────────────

function createOverlay(title: string) {
	destroyPlayer();
	injectStyles();

	const overlay = document.createElement("div");
	overlay.id = OVERLAY_ID;

	const header = document.createElement("div");
	header.className = "cd2-player-header";

	const titleEl = document.createElement("span");
	titleEl.className = "cd2-player-title";
	titleEl.textContent = title;

	const closeBtn = document.createElement("button");
	closeBtn.className = "cd2-player-close";
	closeBtn.textContent = "✕";
	closeBtn.title = "关闭播放器";
	closeBtn.onclick = destroyPlayer;

	header.append(titleEl, closeBtn);

	const container = document.createElement("div");
	container.id = CONTAINER_ID;

	overlay.append(header, container);
	document.body.appendChild(overlay);
	overlayEl = overlay;

	const panelEls = createDanmakuPanel(container);

	// ESC 处理
	const onKeyDown = (e: KeyboardEvent) => {
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

	return { container, panelEls };
}

// ─── 销毁 ───────────────────────────────────────────────

export function destroyPlayer() {
	if (currentPlayer) {
		currentPlayer.destroy(true);
		currentPlayer = null;
	}
	if (overlayEl) {
		overlayEl.remove();
		overlayEl = null;
	}
}

// ─── 加载弹幕到播放器 ───────────────────────────────────

function applyDanmaku(danmaku: ArtDanmaku[]) {
	if (!currentPlayer) return;
	// biome-ignore lint/suspicious/noExplicitAny: Artplayer plugin type missing
	const api = (currentPlayer as any).plugins?.artplayerPluginDanmuku;
	if (api) {
		api.config({ danmuku: danmaku });
		api.load();
	}
}

// ─── 弹幕 SVG 图标 ──────────────────────────────────────

const DANMAKU_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12zM7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>`;

// ─── 打开播放器 ─────────────────────────────────────────

export async function openPlayer(
	url: string,
	fileName: string,
	title?: string,
) {
	const displayTitle = title || fileName;
	const { container, panelEls } = createOverlay(displayTitle);

	// 弹幕状态文字（显示在控制栏）
	let danmakuStatusText = "弹幕匹配中...";
	let _currentEpisodeId: number | undefined;

	// 选集回调
	// useDirect: true=使用直连弹弹Play代理, false=使用danmu_api服务
	const onSelectEpisode = async (episodeId: number, label: string, useDirect = false) => {
		_currentEpisodeId = episodeId;
		panelEls.hide();
		danmakuStatusText = "加载中...";
		updateControlText();
		try {
			const comments = useDirect
				? await directFetchComments(episodeId)
				: await fetchComments(episodeId);
			const danmaku = convertToArtDanmaku(comments.comments);
			applyDanmaku(danmaku);
			const source = useDirect ? "直连" : "API";
			danmakuStatusText = `${label} | ${danmaku.length}条(${source})`;
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `已加载 ${danmaku.length} 条弹幕(${source})`;
		} catch (err) {
			danmakuStatusText = "加载失败";
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `弹幕加载失败: ${(err as Error).message}`;
		}
	};

	// 搜索功能（根据当前模式决定搜索方式）
	const doSearch = async () => {
		const kw = panelEls.input.value.trim();
		if (!kw) return;
		panelEls.body.innerHTML = '<div class="cd2-dm-status">搜索中...</div>';
		const searchMode = getDanmuMode();

		// 仅API模式
		if (searchMode === "api") {
			if (!hasApiUrl()) {
				panelEls.body.innerHTML = '<div class="cd2-dm-status">未配置API地址，请先在油猴菜单中设置</div>';
				return;
			}
			try {
				const res = await searchEpisodes(kw);
				renderAnimes(panelEls.body, res.animes, onSelectEpisode);
			} catch (err) {
				panelEls.body.innerHTML = `<div class="cd2-dm-status">搜索失败: ${(err as Error).message}</div>`;
			}
			return;
		}

		// 直连模式 或 自动模式
		try {
			const res = await directSearchEpisodes(kw);
			renderAnimes(panelEls.body, res.animes, (id, label) => onSelectEpisode(id, label, true));
		} catch (directErr) {
			if (searchMode === "direct") {
				panelEls.body.innerHTML = `<div class="cd2-dm-status">直连搜索失败: ${(directErr as Error).message}</div>`;
				return;
			}
			// auto模式回退到API
			console.warn("[cd2-artplayer] 直连搜索失败，尝试API:", (directErr as Error).message);
			if (hasApiUrl()) {
				try {
					const res = await searchEpisodes(kw);
					renderAnimes(panelEls.body, res.animes, onSelectEpisode);
				} catch (apiErr) {
					panelEls.body.innerHTML = `<div class="cd2-dm-status">搜索失败: ${(apiErr as Error).message}</div>`;
				}
			} else {
				panelEls.body.innerHTML = `<div class="cd2-dm-status">搜索失败: ${(directErr as Error).message}</div>`;
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

	// 初始化播放器
	currentPlayer = new Artplayer({
		container,
		url,
		volume: 0.8,
		autoplay: true,
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
		miniProgressBar: true,
		mutex: true,
		backdrop: true,
		hotkey: true,
		lock: true,
		fastForward: true,
		autoOrientation: true,
		theme: "#1677ff",
		controls: [
			{
				name: "danmaku-search",
				position: "right",
				index: 15,
				html: `<div style="display:flex;align-items:center;gap:4px;padding:0 6px;cursor:pointer">${DANMAKU_ICON}<span class="cd2-dm-ctrl-text" style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">弹幕匹配中...</span></div>`,
				click: () => panelEls.toggle(),
			},
		],
		plugins: [
			artplayerPluginDanmuku({
				danmuku: [],
				speed: 5,
				opacity: 1,
				fontSize: 25,
				color: "#FFFFFF",
				mode: 0,
				margin: [10, "25%"],
				antiOverlap: true,
				synchronousPlayback: false,
				mount: undefined,
				heatmap: true,
			}),
		],
	});

	// 自动匹配弹幕（多策略）
	autoMatch(fileName, panelEls, onSelectEpisode, (text: string) => {
		danmakuStatusText = text;
		updateControlText();
	});
}

// ─── 自动匹配弹幕（多策略，直连优先/API后备）────────────

async function autoMatch(
	fileName: string,
	panelEls: ReturnType<typeof createDanmakuPanel>,
	onSelect: (id: number, label: string, useDirect?: boolean) => void,
	setStatus: (text: string) => void,
) {
	const keyword = extractKeyword(fileName);
	if (keyword) panelEls.input.value = keyword;

	const mode = getDanmuMode();
	console.log(`[cd2-artplayer] 当前弹幕模式: ${mode} (${getDanmuModeLabel(mode)})`);

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

		if (directMatchResult.isMatched && directMatchResult.matches.length > 0) {
			const match = directMatchResult.matches[0];
			renderMatches(
				panelEls.body,
				directMatchResult.matches,
				(id, label) => onSelect(id, label, true),
				match.episodeId,
			);
			await onSelect(
				match.episodeId,
				`${match.animeTitle} - ${match.episodeTitle}`,
				true,
			);
			return;
		}

		// ── 直连策略2: 关键词搜索 ──
		if (keyword) {
			console.log("[cd2-artplayer] 直连策略2: 关键词搜索, keyword=", keyword);
			setStatus("直连搜索中...");
			const directSearchResult = await directSearchEpisodes(keyword);

			if (directSearchResult.animes.length > 0) {
				renderAnimes(panelEls.body, directSearchResult.animes, (id, label) => onSelect(id, label, true));

				const best = findBestEpisode(fileName, directSearchResult.animes);
				if (best) {
					await onSelect(
						best.episodeId,
						`${best.animeTitle} - ${best.episodeTitle}`,
						true,
					);
					return;
				}

				setStatus(`直连找到 ${directSearchResult.animes.length} 部番剧，点击选集`);
				if (currentPlayer)
					currentPlayer.notice.show = "已搜索到番剧(直连)，请点击弹幕按钮选择集数";
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
				if (directRetryResult.animes.length > 0) {
					renderAnimes(panelEls.body, directRetryResult.animes, (id, label) => onSelect(id, label, true));
					const best = findBestEpisode(fileName, directRetryResult.animes);
					if (best) {
						await onSelect(
							best.episodeId,
							`${best.animeTitle} - ${best.episodeTitle}`,
							true,
						);
						return;
					}
					setStatus(`直连找到 ${directRetryResult.animes.length} 部番剧，点击选集`);
					if (currentPlayer)
						currentPlayer.notice.show = "已搜索到番剧(直连)，请点击弹幕按钮选择集数";
					return;
				}
			}
		}

		console.log("[cd2-artplayer] 直连弹弹Play代理未匹配到结果");
	} catch (err) {
		console.warn("[cd2-artplayer] 直连弹弹Play代理失败:", (err as Error).message);
		if (mode === "direct") {
			// 仅直连模式，不回退
			setStatus("直连匹配失败，点击搜索");
			panelEls.body.innerHTML =
				'<div class="cd2-dm-status">直连匹配失败<br><br>可手动输入番剧名搜索<br>或切换到「自动」模式以启用API后备</div>';
			if (currentPlayer)
				currentPlayer.notice.show = "直连匹配失败，可点击弹幕按钮手动搜索";
			return;
		}
	}

	// 仅直连模式且未匹配到
	if (mode === "direct") {
		setStatus("未找到弹幕，点击搜索");
		panelEls.body.innerHTML =
			'<div class="cd2-dm-status">直连未匹配到结果<br><br>可手动输入番剧名搜索<br>或切换到「自动」模式以启用API后备</div>';
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
		panelEls.body.innerHTML =
			'<div class="cd2-dm-status">未配置弹幕 API 地址<br><br>请通过油猴菜单「⚙ 弹幕 API 配置」设置<br>或切换到「直连」/「自动」模式</div>';
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

		if (matchResult.isMatched && matchResult.matches.length > 0) {
			const match = matchResult.matches[0];
			renderMatches(
				panelEls.body,
				matchResult.matches,
				onSelect,
				match.episodeId,
			);
			await onSelect(
				match.episodeId,
				`${match.animeTitle} - ${match.episodeTitle}`,
			);
			return;
		}

		// ── API策略2: 关键词搜索 ──
		if (keyword) {
			console.log("[cd2-artplayer] API策略2: 关键词搜索, keyword=", keyword);
			setStatus("API搜索中...");
			panelEls.input.value = keyword;
			const searchResult = await searchEpisodes(keyword);

			if (searchResult.animes.length > 0) {
				renderAnimes(panelEls.body, searchResult.animes, onSelect);

				const best = findBestEpisode(fileName, searchResult.animes);
				if (best) {
					await onSelect(
						best.episodeId,
						`${best.animeTitle} - ${best.episodeTitle}`,
					);
					return;
				}

				setStatus(`找到 ${searchResult.animes.length} 部番剧，点击选集`);
				if (currentPlayer)
					currentPlayer.notice.show = "已搜索到番剧(API)，请点击弹幕按钮选择集数";
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
				if (retryResult.animes.length > 0) {
					renderAnimes(panelEls.body, retryResult.animes, onSelect);
					const best = findBestEpisode(fileName, retryResult.animes);
					if (best) {
						await onSelect(
							best.episodeId,
							`${best.animeTitle} - ${best.episodeTitle}`,
						);
						return;
					}
					setStatus(`找到 ${retryResult.animes.length} 部番剧，点击选集`);
					if (currentPlayer)
						currentPlayer.notice.show = "已搜索到番剧(API)，请点击弹幕按钮选择集数";
					return;
				}
			}
		}

		// 全部失败
		setStatus("未找到弹幕，点击搜索");
		panelEls.body.innerHTML =
			'<div class="cd2-dm-status">自动匹配失败，请手动输入番剧名搜索</div>';
		if (currentPlayer)
			currentPlayer.notice.show = "未自动匹配到弹幕，可点击弹幕按钮手动搜索";
	} catch (err) {
		console.error("[cd2-artplayer] API匹配异常:", err);
		setStatus("匹配失败，点击搜索");
		panelEls.body.innerHTML = `<div class="cd2-dm-status">匹配出错: ${(err as Error).message}</div>`;
	}
}

// ─── 从文件名提取搜索关键词 ────────────────────────────
// 针对 dmhy / 字幕组 / 动漫资源站命名规范优化
//
// 典型格式:
//   [LoliHouse] 达尔文事变 / Darwin Jihen - 10 [WebRip 1080p ...].mkv
//   [綠茶字幕組] 蘑菇魔女 / Champignon no Majo [09][WebRip]...
//   【幻櫻字幕組】【1月新番】【黃金神威 Golden Kamuy】【59】...
//   達爾文事變「ダーウィン事変」The Darwin Incident S01E10 1080p ...

/** 检测字符串是否包含CJK字符 */
function hasCJK(s: string): boolean {
	return /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
}

function extractKeyword(fileName: string): string {
	const title = extractTitle(fileName);
	const season = extractSeasonNumber(fileName);
	const episode = extractEpisodeNumber(fileName);

	// 拼接: 番名 + S0XE0X 或 番名 + 0XX
	let result = title;
	if (season && episode) {
		result += ` S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
	} else if (episode) {
		result += ` ${String(episode).padStart(3, "0")}`;
	}

	console.log(`[cd2-artplayer] extractKeyword: "${fileName}" → "${result}"`);
	return result;
}

/** 从 extractKeyword 的结果中剥离末尾的集数部分，仅保留番名（用于搜索API） */
function extractSearchTitle(keyword: string): string {
	return keyword
		.replace(/\s+S\d+E\d+$/, "")
		.replace(/\s+\d{2,3}$/, "")
		.trim();
}

// ─── 提取番名（不含季集，符号去除适配模糊匹配） ──────────

function extractTitle(fileName: string): string {
	let name = fileName.replace(/\.[^.]+$/, ""); // 去扩展名

	// ── ★ 分隔格式（如 `六四位元字幕組★番名★10★...`）──
	if (name.includes("\u2605")) {
		const starParts = name.split("\u2605").map((s) => s.trim()).filter(Boolean);
		const titlePart = starParts.slice(1).find((p) => hasCJK(p) && !/^\d+$/.test(p) && !/1080|720|1920|AVC|AAC|MP4/i.test(p));
		if (titlePart) {
			name = titlePart.replace(/\s+[A-Z][a-z]+(?:\s+[a-z]+)*(?:\s+[A-Z][a-z]+)*\s*$/i, "").trim() || titlePart;
			name = name.replace(/\s+\d{1,3}\s*$/, "").trim();
			return cleanTitle(name);
		}
	}

	// ── 【】包裹全部内容（如【幻櫻字幕組】【1月新番】【黃金神威 Golden Kamuy】【59】）──
	const fullWidthTags = name.match(/【[^【】]*】/g);
	if (fullWidthTags && fullWidthTags.length >= 3) {
		const skipPatterns = /字幕|新番|月新|合集|GB|BIG5|MP4|MKV|1080|720|1920|1280|練習組|练习组/i;
		for (const tag of fullWidthTags) {
			const content = tag.slice(1, -1).trim();
			if (hasCJK(content) && !skipPatterns.test(content) && !/^\d+$/.test(content)) {
				name = content;
				break;
			}
		}
	}

	// ── 嵌套【】下划线分隔（如 【...的孩子】_我推的孩子_Oshi no Ko】）──
	if (name.includes("_") && hasCJK(name)) {
		const parts = name.split("_").map((s) => s.trim()).filter(Boolean);
		const cjkTitle = parts.find((p) => hasCJK(p) && !/字幕|练习|偶像/.test(p) && p.length >= 2);
		if (cjkTitle) name = cjkTitle;
	}

	// ── 剥离开头连续的 [字幕组] / 【字幕组】 标签 ──
	if (/^\s*[[\u3010]/.test(name)) {
		name = name.replace(/^(\s*[[\u3010][^\]\u3011]*[\]\u3011]\s*)+/, "").trim();
	}

	// ── 去壳标题中的【】，保留内容 ──
	name = name.replace(/【([^】]*)】/g, "$1").trim();

	// ── 用 "/" 分隔提取番名，优先取CJK ──
	if (name.includes("/")) {
		const parts = name.split(/\s*\/\s*/);
		const cjkPart = parts.find((p) => hasCJK(p.trim()));
		name = cjkPart ? cjkPart.trim() : parts[0].trim();
	}

	// ── 截断集数及之后的内容 ──
	name = name
		.replace(/\s+-\s+\d+\b.*$/, "")
		.replace(/\s*\[\d+(?:v\d+)?(?:\s*[-~]\s*\d+)?].*$/, "")
		.replace(/\s+S\d+E\d+\b.*$/i, "")
		.replace(/(」)\s*The\s+.*$/i, "$1")
		.replace(/\s+\d{1,3}\s*$/, "")
		.trim();

	// ── 去除残留技术标记 ──
	name = name
		.replace(/[[\u3010][^\]\u3011]*[\]\u3011]/g, "")
		.replace(/[(\uff08][^)\uff09]*[)\uff09]/g, "")
		.replace(/\b\d{3,4}[xX\u00d7]\d{3,4}\b/g, "")
		.replace(/\b(1080[pi]?|720[pi]?|480[pi]?|2160[pi]?|4K|UHD)\b/gi, "")
		.replace(/\b(HEVC|AVC|H\.?264|H\.?265|x264|x265|10bit|Hi10P|HDR)\b/gi, "")
		.replace(/\b(AAC|FLAC|DTS|AC3|MP3|OGG|OPUS|EAC3|TrueHD|Atmos)\b/gi, "")
		.replace(/\b(BluRay|BDRip|WEBRip|WEB-DL|DVDRip|HDTV|REMUX|WebRip|BILIBILI|CR|B-Global|ABEMA|Baha|ViuTV)\b/gi, "")
		.replace(/\b(MP4|MKV|AVI|RMVB|FLV|TS|WMV|MOV|WAV)\b/gi, "")
		.replace(/\b(CHS|CHT|JPN?|ENG?|GB|BIG5|YUE|PGS|SRT|OVA)\b/gi, "")
		.replace(/(简繁|繁日|简日|简体|繁体|繁體|簡體|双语|雙語|粤语|粵語|中文|日语|日英|配音)/g, "")
		.replace(/(字幕组?|字幕組?|翻译|翻譯|招募|内嵌|外挂|内封|內嵌|內封|外封|无字幕|多國字幕)/g, "")
		.replace(/\u2605[^\u2605]*\u2605/g, "")
		.replace(/\u2605/g, "")
		.replace(/\bv\d+\b/gi, "")
		.replace(/\bS\d+$/i, "")
		.replace(/\s+-\s*$/, "")
		.replace(/^\s*-\s+/, "")
		.replace(/\s+/g, " ")
		.trim();

	// ── 截断CJK标题后的拉丁文罗马音 ──
	if (hasCJK(name)) {
		const cjkTruncated = name.replace(/\s+[A-Z][a-zA-Z]+(?:\s+[a-zA-Z]+)*\s*$/, "").trim();
		if (cjkTruncated.length >= 2 && hasCJK(cjkTruncated)) {
			name = cjkTruncated;
		}
	}

	// ── 回退 ──
	if (name.length < 2) {
		const fallback = fileName
			.replace(/\.[^.]+$/, "")
			.replace(/[\u3010\u3011【】\[\]()（）{}「」『』\u2605]/g, " ")
			.replace(/\b(1080[pi]?|720[pi]?)\\b/gi, "")
			.replace(/[-_.]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		const words = fallback.split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w));
		name = words.slice(0, 4).join(" ");
	}

	return cleanTitle(name);
}

/** 去除符号适配模糊匹配: ～→空格, 「」→去除, 季数文字→去除(由S0X表示) */
function cleanTitle(title: string): string {
	return title
		.replace(/[～~「」『』《》""'']/g, " ")
		.replace(/第[一二三四五六七八九十百千\d]+季/g, "")
		.replace(/\d+(st|nd|rd|th)\s*Season/gi, "")
		.replace(/[-_.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// ─── 提取季数 ────────────────────────────────────────────

function extractSeasonNumber(fileName: string): number | null {
	const name = fileName.replace(/\.[^.]+$/, "");
	const patterns: [RegExp, ((m: RegExpMatchArray) => number)?][] = [
		[/第([一二三四五六七八九十])季/, (m) => "一二三四五六七八九十".indexOf(m[1]) + 1],
		[/第(\d+)季/, (m) => parseInt(m[1])],
		[/\bS(\d+)\s*E\d+/i],
		[/\bS(\d+)\b(?!\d)/i],
		[/(\d+)(?:st|nd|rd|th)\s*Season/i],
	];
	for (const [pat, transform] of patterns) {
		const m = name.match(pat);
		if (m) {
			const num = transform ? transform(m) : parseInt(m[1]);
			if (num > 0 && num < 30) return num;
		}
	}
	return null;
}

// ─── 提取集数 ────────────────────────────────────────────

function extractEpisodeNumber(fileName: string): number | null {
	const name = fileName.replace(/\.[^.]+$/, "");
	const patterns: RegExp[] = [
		/第(\d+)[话話集期]/,
		/\bEP?\s*(\d+)\b/i,
		/\bS\d+E(\d+)\b/i,
		/\u2605\s*(\d{1,3})\s*\u2605/,
		/【(\d{1,3})】/,
		/\[\s*(\d{1,3})\s*\]/,
		/\s+-\s+(\d{1,3})\s/,
		/\s+-\s+(\d{1,3})\s*$/,
		/[\s_.-]\s*(\d{2,3})\s*[\s_.\-[\u3010(v]/,
		/[\s_.-]\s*(\d{2,3})\s*$/,
	];
	for (const pat of patterns) {
		const m = name.match(pat);
		if (m) {
			const num = parseInt(m[1]);
			if (num > 0 && num < 999) return num;
		}
	}
	return null;
}

// ─── 从文件名推断集数并匹配最佳结果 ───────────────────

function findBestEpisode(
	fileName: string,
	animes: SearchAnime[],
): { episodeId: number; animeTitle: string; episodeTitle: string } | null {
	const epNum = extractEpisodeNumber(fileName);
	if (epNum === null) return null;

	for (const anime of animes) {
		for (const ep of anime.episodes) {
			const epTitle = ep.episodeTitle;
			const nums = epTitle.match(/\d+/g);
			if (nums) {
				for (const n of nums) {
					if (parseInt(n) === epNum) {
						return {
							episodeId: ep.episodeId,
							animeTitle: anime.animeTitle,
							episodeTitle: epTitle,
						};
					}
				}
			}
		}
	}
	return null;
}





