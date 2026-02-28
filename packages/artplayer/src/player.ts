/**
 * ArtPlayer 播放器模块
 * 弹幕搜索集成到 ArtPlayer 控制栏
 */

import Artplayer from "artplayer";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import {
	matchVideo,
	searchEpisodes,
	fetchComments,
	convertToArtDanmaku,
	hasCredentials,
	type ArtDanmaku,
	type MatchItem,
	type SearchAnime,
} from "./dandanplay";

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

	const input = panel.querySelector<HTMLInputElement>(".cd2-dm-search input")!;
	const searchBtn = panel.querySelector<HTMLButtonElement>(
		".cd2-dm-search button",
	)!;
	const body = panel.querySelector<HTMLDivElement>(".cd2-dm-body")!;
	const closeBtn = panel.querySelector<HTMLButtonElement>(
		".cd2-dm-close-panel",
	)!;

	// 阻止键盘事件冒泡
	panel.addEventListener("keydown", (e) => e.stopPropagation());
	// 阻止点击关闭面板传播到播放器
	panel.addEventListener("click", (e) => e.stopPropagation());

	closeBtn.onclick = () => panel.classList.remove("cd2-show");

	const toggle = () => panel.classList.toggle("cd2-show");
	const hide = () => panel.classList.remove("cd2-show");

	return { panel, input, searchBtn, body, toggle, hide };
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
		(
			groups.get(m.animeTitle) ||
			(groups.set(m.animeTitle, []), groups.get(m.animeTitle)!)
		).push(m);
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
	let currentEpisodeId: number | undefined;

	// 选集回调
	const onSelectEpisode = async (episodeId: number, label: string) => {
		currentEpisodeId = episodeId;
		panelEls.hide();
		danmakuStatusText = "加载中...";
		updateControlText();
		try {
			const comments = await fetchComments(episodeId);
			const danmaku = convertToArtDanmaku(comments.comments);
			applyDanmaku(danmaku);
			danmakuStatusText = `${label} | ${danmaku.length}条`;
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `已加载 ${danmaku.length} 条弹幕`;
		} catch (err) {
			danmakuStatusText = "加载失败";
			updateControlText();
			if (currentPlayer)
				currentPlayer.notice.show = `弹幕加载失败: ${(err as Error).message}`;
		}
	};

	// 搜索功能
	const doSearch = async () => {
		const kw = panelEls.input.value.trim();
		if (!kw) return;
		panelEls.body.innerHTML = '<div class="cd2-dm-status">搜索中...</div>';
		try {
			const res = await searchEpisodes(kw);
			renderAnimes(panelEls.body, res.animes, onSelectEpisode);
		} catch (err) {
			panelEls.body.innerHTML = `<div class="cd2-dm-status">搜索失败: ${(err as Error).message}</div>`;
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

// ─── 自动匹配弹幕（多策略）─────────────────────────────

async function autoMatch(
	fileName: string,
	panelEls: ReturnType<typeof createDanmakuPanel>,
	onSelect: (id: number, label: string) => void,
	setStatus: (text: string) => void,
) {
	const keyword = extractKeyword(fileName);
	if (keyword) panelEls.input.value = keyword;

	if (!hasCredentials()) {
		setStatus("需配置API密钥");
		panelEls.body.innerHTML =
			'<div class="cd2-dm-status">请先通过油猴菜单「⚙ 弹弹Play API 配置」设置 AppId 和 AppSecret<br><br>申请方式：发邮件到 kaedei@dandanplay.net<br>主题：弹弹play开放平台申请</div>';
		if (currentPlayer)
			currentPlayer.notice.show =
				"弹幕功能需配置弹弹Play API密钥，请在油猴菜单中设置";
		return;
	}

	try {
		// ── 策略1: 直接用完整文件名匹配  ──
		console.log("[cd2-artplayer] 策略1: 文件名匹配, fileName=", fileName);
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

		// ── 策略2: 用提取的关键词搜索  ──
		if (keyword) {
			console.log("[cd2-artplayer] 策略2: 关键词搜索, keyword=", keyword);
			setStatus("搜索中...");
			const searchResult = await searchEpisodes(keyword);

			if (searchResult.animes.length > 0) {
				renderAnimes(panelEls.body, searchResult.animes, onSelect);

				// 尝试自动选中最佳集数
				const best = findBestEpisode(fileName, searchResult.animes);
				if (best) {
					await onSelect(
						best.episodeId,
						`${best.animeTitle} - ${best.episodeTitle}`,
					);
					return;
				}

				// 有结果但无法确定集数，提示用户选择
				setStatus(`找到 ${searchResult.animes.length} 部番剧，点击选集`);
				if (currentPlayer)
					currentPlayer.notice.show = "已搜索到番剧，请点击弹幕按钮选择集数";
				return;
			}

			// ── 策略3: 缩短关键词再搜  ──
			const shortKeyword = keyword.split(" ").slice(0, 2).join(" ");
			if (shortKeyword !== keyword && shortKeyword.length >= 2) {
				console.log(
					"[cd2-artplayer] 策略3: 缩短关键词搜索, keyword=",
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
						currentPlayer.notice.show = "已搜索到番剧，请点击弹幕按钮选择集数";
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
		console.error("[cd2-artplayer] 自动匹配异常:", err);
		setStatus("匹配失败，点击搜索");
		panelEls.body.innerHTML = `<div class="cd2-dm-status">匹配出错: ${(err as Error).message}</div>`;
	}
}

// ─── 从文件名提取搜索关键词 ────────────────────────────

function extractKeyword(fileName: string): string {
	const name = fileName
		.replace(/\.[^.]+$/, "")
		.replace(/[[\]【】()（）{}「」『』]/g, " ")
		.replace(/\d{3,4}[xX×]\d{3,4}/g, "")
		.replace(/\b(1080[pi]?|720[pi]?|480[pi]?|2160[pi]?|4K|UHD)\b/gi, "")
		.replace(/\b(BluRay|BDRip|WEBRip|WEB-DL|DVDRip|HDTV|REMUX)\b/gi, "")
		.replace(/\b(HEVC|AVC|H\.?264|H\.?265|x264|x265|10bit|Hi10P|HDR)\b/gi, "")
		.replace(/\b(AAC|FLAC|DTS|AC3|MP3|OGG|OPUS|EAC3|TrueHD|Atmos)\b/gi, "")
		.replace(/\b(MP4|MKV|AVI|RMVB|FLV|TS|WMV|MOV)\b/gi, "")
		.replace(/\b(S\d+E\d+)\b/gi, "")
		.replace(/\bv\d+\b/gi, "")
		.replace(/\b(CHS|CHT|JPN?|ENG?|GB|BIG5|繁体|简体|简日|繁日)\b/gi, "")
		.replace(/字幕组?|翻译|内嵌|外挂|内封/g, "")
		.replace(/[-_.]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	// 去掉独立的纯数字和单字符
	const words = name.split(" ").filter((w) => w.length > 1 && !/^\d+$/.test(w));
	return words.slice(0, 3).join(" ");
}

// ─── 从文件名推断集数并匹配最佳结果 ───────────────────

function findBestEpisode(
	fileName: string,
	animes: SearchAnime[],
): { episodeId: number; animeTitle: string; episodeTitle: string } | null {
	// 提取集数
	const epNum = extractEpisodeNumber(fileName);
	if (epNum === null) return null;

	// 在第一个番剧中查找对应集数
	for (const anime of animes) {
		for (const ep of anime.episodes) {
			// episodeTitle 通常为 "第1话"、"第01集" 或 "01" 或 "Episode 1"
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

function extractEpisodeNumber(fileName: string): number | null {
	const name = fileName.replace(/\.[^.]+$/, "");

	// 匹配各种集数格式
	const patterns = [
		/第(\d+)[话話集期]/, // 第01话
		/\bEP?\s*(\d+)\b/i, // EP01 / E01
		/\bS\d+E(\d+)\b/i, // S01E01
		/[\s_.-]\s*(\d{2,3})\s*[\s_.\-[【(v]/, // 空格/分隔符后的2-3位数字
		/[\s_.-]\s*(\d{2,3})\s*$/, // 结尾的2-3位数字
		/[[\s](\d{2})\s*[\]]/, // [01] 格式
	];

	for (const pat of patterns) {
		const m = name.match(pat);
		if (m) {
			const num = parseInt(m[1]);
			if (num > 0 && num < 2000) return num;
		}
	}
	return null;
}
