const CONFIG_KEY = "cd2_config_v1";
const SHOW_PANEL_KEY = "cd2_show_panel";
const LOCAL_DIRECTORY_KEY = "cd2_local_directory_enabled";
const SHOW_DANMAKU_HEATMAP_KEY = "cd2_show_danmaku_heatmap";
const MEDIA_CACHE_ENABLED_KEY = "cd2_media_cache_enabled";
const MIN_NATIVE_PROTOCOL = 8;
const INSTALLER_FILENAME =
	"CloudDrive2Offline/clouddrive2-native-host-installer.cmd";
const form = document.querySelector("#settings-form");
const saveStatus = document.querySelector("#status");
const nativeStatus = document.querySelector("#nativeStatus");
const downloadNativeInstaller = document.querySelector(
	"#downloadNativeInstaller",
);
const uninstallNativeHost = document.querySelector("#uninstallNativeHost");
const mediaCacheEnabled = document.querySelector("#mediaCacheEnabled");
const mediaCacheStatus = document.querySelector("#mediaCacheStatus");
const clearMediaCache = document.querySelector("#clearMediaCache");
let nativeState = "checking";
let nativeRefreshPromise = null;

function setSaveStatus(text) {
	saveStatus.textContent = text;
}

function formatBytes(value) {
	if (!Number.isFinite(value) || value <= 0) return "0 MB";
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
	return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

async function refreshMediaCacheStats() {
	try {
		const result = await chrome.runtime.sendMessage({
			type: "cd2-media-cache-stats",
		});
		if (!result?.ok) throw new Error(result?.error || "统计失败");
		mediaCacheStatus.textContent = `${formatBytes(result.totalBytes)} / ${formatBytes(result.maxBytes)}`;
		mediaCacheStatus.dataset.tone = "ready";
	} catch (error) {
		mediaCacheStatus.textContent = "统计失败";
		mediaCacheStatus.dataset.tone = "error";
	}
}

clearMediaCache.addEventListener("click", async () => {
	clearMediaCache.disabled = true;
	clearMediaCache.classList.add("is-busy");
	mediaCacheStatus.textContent = "正在清理…";
	mediaCacheStatus.dataset.tone = "checking";
	try {
		const result = await chrome.runtime.sendMessage({
			type: "cd2-media-cache-clear",
		});
		if (!result?.ok) throw new Error(result?.error || "清理失败");
		await refreshMediaCacheStats();
	} catch (error) {
		mediaCacheStatus.textContent = "清理失败";
		mediaCacheStatus.dataset.tone = "error";
	} finally {
		clearMediaCache.disabled = false;
		clearMediaCache.classList.remove("is-busy");
	}
});

function setNativeStatus(text, tone = "checking") {
	nativeStatus.textContent = text;
	nativeStatus.dataset.tone = tone;
}

function setNativeActionsBusy(busy) {
	downloadNativeInstaller.disabled = busy;
	uninstallNativeHost.disabled =
		busy || !["ready", "outdated"].includes(nativeState);
	downloadNativeInstaller.classList.toggle("is-busy", busy);
	uninstallNativeHost.classList.toggle("is-busy", busy);
}

function withTimeout(promise, timeoutMs, text) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = window.setTimeout(() => reject(new Error(text)), timeoutMs);
		}),
	]).finally(() => window.clearTimeout(timer));
}

function sendNativeMessage(action, timeoutMs = 3500) {
	const type =
		action === "uninstall" ? "cd2-native-uninstall" : "cd2-native-status";
	return withTimeout(
		chrome.runtime.sendMessage({ type }),
		timeoutMs,
		"助手检测超时",
	);
}

function isNativeHostMissing(error) {
	return /native messaging host.*not found|specified native messaging host not found|找不到.*native.*host/i.test(
		error?.message || String(error || ""),
	);
}

async function detectNativeHost() {
	try {
		const result = await sendNativeMessage("ping");
		if (result?.ok === true && result?.kind === "powershell") {
			return result.protocol >= MIN_NATIVE_PROTOCOL ? "ready" : "outdated";
		}
		return "missing";
	} catch (error) {
		return /timeout|超时/i.test(error?.message || "") ? "timeout" : "missing";
	}
}

function renderNativeState(state) {
	nativeState = state;
	downloadNativeInstaller.textContent =
		state === "ready" ? "重新下载脚本" : "下载脚本";
	if (state === "ready") setNativeStatus("已安装，可定位本地文件", "ready");
	else if (state === "checking") setNativeStatus("正在检测…", "checking");
	else if (state === "outdated")
		setNativeStatus("检测到旧版助手，请更新脚本", "warning");
	else if (state === "timeout")
		setNativeStatus("检测超时，可稍后重试", "warning");
	else setNativeStatus("未安装", "warning");
	uninstallNativeHost.disabled = !["ready", "outdated"].includes(state);
}

async function refreshNativeState() {
	if (nativeRefreshPromise) return nativeRefreshPromise;
	nativeRefreshPromise = (async () => {
		renderNativeState("checking");
		setNativeActionsBusy(true);
		const state = await detectNativeHost();
		renderNativeState(state);
		setNativeActionsBusy(false);
		await chrome.storage.local.set({
			[LOCAL_DIRECTORY_KEY]: state === "ready",
		});
		return state;
	})();
	try {
		return await nativeRefreshPromise;
	} finally {
		nativeRefreshPromise = null;
	}
}

function waitForDownload(downloadId) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = window.setTimeout(
			() => finish(new Error("下载脚本超时")),
			60_000,
		);
		const onChanged = (delta) => {
			if (delta.id !== downloadId) return;
			if (delta.error?.current) finish(new Error(delta.error.current));
			else if (delta.state?.current === "complete") finish();
		};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timer);
			chrome.downloads.onChanged.removeListener(onChanged);
			if (error) reject(error);
			else resolve();
		};
		chrome.downloads.onChanged.addListener(onChanged);
		void chrome.downloads.search({ id: downloadId }).then((items) => {
			const item = items[0];
			if (item?.error) finish(new Error(item.error));
			else if (item?.state === "complete") finish();
		});
	});
}

async function waitForNativeHost() {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		if ((await detectNativeHost()) === "ready") {
			await chrome.storage.local.set({ [LOCAL_DIRECTORY_KEY]: true });
			renderNativeState("ready");
			return;
		}
	}
	setNativeStatus("仍未检测到助手，请确认已运行下载的脚本", "error");
}

downloadNativeInstaller.addEventListener("click", async () => {
	setNativeActionsBusy(true);
	setNativeStatus("正在下载脚本…", "checking");
	try {
		const downloadId = await chrome.downloads.download({
			url: chrome.runtime.getURL("native-host/clouddrive2-native-host.cmd"),
			filename: INSTALLER_FILENAME,
			conflictAction: "uniquify",
			saveAs: false,
		});
		await waitForDownload(downloadId);
		setNativeStatus("下载完成，请运行脚本", "warning");
		void waitForNativeHost();
	} catch (error) {
		const text = error?.message || String(error);
		setNativeStatus(
			text === "USER_CANCELED"
				? "下载已取消，请再次点击下载"
				: `下载失败：${text}`,
			"error",
		);
	} finally {
		setNativeActionsBusy(false);
	}
});

uninstallNativeHost.addEventListener("click", async () => {
	setNativeStatus("正在卸载…", "checking");
	setNativeActionsBusy(true);
	try {
		const result = await sendNativeMessage("uninstall", 4000);
		if (!result?.ok && !isNativeHostMissing(result?.error))
			throw new Error(result?.error || "卸载失败");
		await chrome.storage.local.set({ [LOCAL_DIRECTORY_KEY]: false });
		renderNativeState("missing");
		setNativeStatus("卸载完成", "ready");
	} catch (error) {
		if (isNativeHostMissing(error)) {
			await chrome.storage.local.set({ [LOCAL_DIRECTORY_KEY]: false });
			renderNativeState("missing");
			setNativeStatus("助手已不存在", "ready");
		} else setNativeStatus(`卸载失败：${error.message || error}`, "error");
	} finally {
		setNativeActionsBusy(false);
	}
});

async function loadSettings() {
	const stored = await chrome.storage.local.get([
		CONFIG_KEY,
		SHOW_PANEL_KEY,
		SHOW_DANMAKU_HEATMAP_KEY,
		MEDIA_CACHE_ENABLED_KEY,
	]);
	const config = stored[CONFIG_KEY] || {};
	document.querySelector("#grpcBaseUrl").value =
		config.grpcBaseUrl || "http://localhost:19798";
	document.querySelector("#apiToken").value = config.apiToken || "";
	document.querySelector("#offlineDestPath").value =
		config.offlineDestPath || "/";
	document.querySelector("#showPanel").checked = stored[SHOW_PANEL_KEY] ?? true;
	document.querySelector("#showDanmakuHeatmap").checked =
		stored[SHOW_DANMAKU_HEATMAP_KEY] ?? false;
	mediaCacheEnabled.checked = stored[MEDIA_CACHE_ENABLED_KEY] ?? true;
	await refreshMediaCacheStats();
	await refreshNativeState();
}

window.addEventListener("focus", () => void refreshNativeState());

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	const config = {
		grpcBaseUrl: document
			.querySelector("#grpcBaseUrl")
			.value.trim()
			.replace(/\/+$/, ""),
		apiToken: document.querySelector("#apiToken").value.trim(),
		offlineDestPath:
			document.querySelector("#offlineDestPath").value.trim() || "/",
	};
	await chrome.storage.local.set({
		[CONFIG_KEY]: config,
		[SHOW_PANEL_KEY]: document.querySelector("#showPanel").checked,
		[SHOW_DANMAKU_HEATMAP_KEY]: document.querySelector("#showDanmakuHeatmap")
			.checked,
		[MEDIA_CACHE_ENABLED_KEY]: mediaCacheEnabled.checked,
	});
	setSaveStatus("设置已保存");
	window.setTimeout(() => setSaveStatus(""), 2000);
});

void loadSettings();
