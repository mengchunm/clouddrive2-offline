const CONFIG_KEY = "cd2_config_v1";
const SHOW_PANEL_KEY = "cd2_show_panel";
const LOCAL_DIRECTORY_KEY = "cd2_local_directory_enabled";
const SHOW_DANMAKU_HEATMAP_KEY = "cd2_show_danmaku_heatmap";
const PREFERRED_PLAYER_KEY = "cd2_default_player";
const DANMU_MODE_KEY = "danmu_mode";
const DANMU_API_URL_KEY = "danmu_api_url";
const DEFAULT_DANMU_API_URL = "https://clouddrive2.netlify.app/87076677";
const MIN_NATIVE_PROTOCOL = 8;
const INSTALLER_FILENAME =
	"CloudDrive2Offline/clouddrive2-native-host-installer.cmd";
const form = document.querySelector("#settings-form");
const saveStatus = document.querySelector("#status");
const nativeStatus = document.querySelector("#nativeStatus");
const downloadNativeInstaller = document.querySelector(
	"#downloadNativeInstaller",
);
const downloadNativeInstallerLabel = document.querySelector(
	"#downloadNativeInstallerLabel",
);
const refreshNativeHost = document.querySelector("#refreshNativeHost");
const uninstallNativeHost = document.querySelector("#uninstallNativeHost");
const uninstallConfirm = document.querySelector("#uninstallConfirm");
const saveSettings = document.querySelector("#saveSettings");
const grpcBaseUrl = document.querySelector("#grpcBaseUrl");
const apiToken = document.querySelector("#apiToken");
const offlineDestPath = document.querySelector("#offlineDestPath");
const showPanel = document.querySelector("#showPanel");
const showDanmakuHeatmap = document.querySelector("#showDanmakuHeatmap");
const defaultPlayer = document.querySelector("#defaultPlayer");
const danmuMode = document.querySelector("#danmuMode");
const danmuApiUrl = document.querySelector("#danmuApiUrl");
const danmuApiUrlError = document.querySelector("#danmuApiUrlError");
let nativeState = "checking";
let nativeRefreshPromise = null;
let savedSnapshot = "";
let saving = false;

function setSaveStatus(text, tone = "") {
	saveStatus.textContent = text;
	saveStatus.dataset.tone = tone;
}

function readFormState() {
	return {
		config: {
			grpcBaseUrl: grpcBaseUrl.value.trim().replace(/\/+$/, ""),
			apiToken: apiToken.value.trim(),
			offlineDestPath: offlineDestPath.value.trim() || "/",
		},
		showPanel: showPanel.checked,
		showDanmakuHeatmap: showDanmakuHeatmap.checked,
		defaultPlayer: defaultPlayer.value,
		danmuMode: danmuMode.value,
		danmuApiUrl: danmuApiUrl.value.trim().replace(/\/+$/, ""),
	};
}

function currentSnapshot() {
	return JSON.stringify(readFormState());
}

function updateSaveButton() {
	saveSettings.disabled =
		saving || !form.checkValidity() || currentSnapshot() === savedSnapshot;
	form.setAttribute("aria-busy", saving ? "true" : "false");
}

function validateDanmuApiUrl() {
	const value = danmuApiUrl.value.trim();
	let error = "";
	if (value) {
		try {
			const parsed = new URL(value);
			if (!["http:", "https:"].includes(parsed.protocol))
				error = "仅支持 HTTP 或 HTTPS 地址";
		} catch {
			error = "请输入完整的 HTTP 或 HTTPS 地址";
		}
	}
	danmuApiUrl.setCustomValidity(error);
	if (error) danmuApiUrl.setAttribute("aria-invalid", "true");
	else danmuApiUrl.removeAttribute("aria-invalid");
	danmuApiUrlError.textContent = error;
	return !error;
}

function bindSecretToggle(buttonId, input) {
	const button = document.querySelector(buttonId);
	button.addEventListener("click", () => {
		const visible = input.type === "password";
		input.type = visible ? "text" : "password";
		button.textContent = visible ? "隐藏" : "显示";
		button.setAttribute("aria-pressed", String(visible));
	});
}

function setNativeStatus(text, tone = "checking") {
	nativeStatus.textContent = text;
	nativeStatus.dataset.tone = tone;
}

function setNativeActionsBusy(busy) {
	downloadNativeInstaller.disabled = busy;
	refreshNativeHost.disabled = busy;
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
	downloadNativeInstallerLabel.textContent =
		state === "ready" ? "重新下载" : "下载助手";
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

async function uninstallNativeHostNow() {
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
}

refreshNativeHost.addEventListener("click", () => void refreshNativeState());
uninstallNativeHost.addEventListener("click", () => {
	uninstallConfirm.returnValue = "";
	uninstallConfirm.showModal();
});
uninstallConfirm.addEventListener("close", () => {
	if (uninstallConfirm.returnValue === "uninstall")
		void uninstallNativeHostNow();
});

async function loadSettings() {
	try {
		const stored = await chrome.storage.local.get([
			CONFIG_KEY,
			SHOW_PANEL_KEY,
			SHOW_DANMAKU_HEATMAP_KEY,
			PREFERRED_PLAYER_KEY,
			DANMU_MODE_KEY,
			DANMU_API_URL_KEY,
		]);
		const config = stored[CONFIG_KEY] || {};
		grpcBaseUrl.value = config.grpcBaseUrl || "http://localhost:19798";
		apiToken.value = config.apiToken || "";
		offlineDestPath.value = config.offlineDestPath || "/";
		showPanel.checked = stored[SHOW_PANEL_KEY] ?? true;
		showDanmakuHeatmap.checked = stored[SHOW_DANMAKU_HEATMAP_KEY] ?? false;
		defaultPlayer.value = ["web", "potplayer", "dandanplay", "infuse"].includes(
			stored[PREFERRED_PLAYER_KEY],
		)
			? stored[PREFERRED_PLAYER_KEY]
			: "web";
		danmuMode.value = ["direct", "auto", "api"].includes(stored[DANMU_MODE_KEY])
			? stored[DANMU_MODE_KEY]
			: "direct";
		danmuApiUrl.value = stored[DANMU_API_URL_KEY] ?? DEFAULT_DANMU_API_URL;
		validateDanmuApiUrl();
		savedSnapshot = currentSnapshot();
		updateSaveButton();
		await refreshNativeState();
	} catch (error) {
		setSaveStatus(`设置加载失败：${error.message || error}`, "error");
	}
}

bindSecretToggle("#toggleApiTokenVisibility", apiToken);
bindSecretToggle("#toggleDanmuApiVisibility", danmuApiUrl);
saveSettings.disabled = true;

form.addEventListener("input", (event) => {
	if (event.target === danmuApiUrl) validateDanmuApiUrl();
	setSaveStatus("");
	updateSaveButton();
});
form.addEventListener("change", () => {
	setSaveStatus("");
	updateSaveButton();
});

window.addEventListener("focus", () => void refreshNativeState());

form.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (!validateDanmuApiUrl() || !form.reportValidity()) return;

	saving = true;
	updateSaveButton();
	setSaveStatus("正在保存…");
	try {
		const state = readFormState();
		await chrome.storage.local.set({
			[CONFIG_KEY]: state.config,
			[SHOW_PANEL_KEY]: state.showPanel,
			[SHOW_DANMAKU_HEATMAP_KEY]: state.showDanmakuHeatmap,
			[PREFERRED_PLAYER_KEY]: state.defaultPlayer,
			[DANMU_MODE_KEY]: state.danmuMode,
			[DANMU_API_URL_KEY]: state.danmuApiUrl,
		});
		savedSnapshot = currentSnapshot();
		setSaveStatus("设置已保存", "success");
		window.setTimeout(() => {
			if (saveStatus.textContent === "设置已保存") setSaveStatus("");
		}, 2500);
	} catch (error) {
		setSaveStatus(`保存失败：${error.message || error}`, "error");
	} finally {
		saving = false;
		updateSaveButton();
	}
});

void loadSettings();
