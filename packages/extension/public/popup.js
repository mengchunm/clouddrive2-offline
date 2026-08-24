const DANMU_MODE_KEY = "danmu_mode";
const DANMU_MODES = ["direct", "auto", "api"];
const DANMU_MODE_LABELS = {
	direct: "仅直连",
	auto: "自动",
	api: "仅 API",
};

const status = document.querySelector("#status");
const closePlayerButton = document.querySelector(
	'button[data-command="close-player"]',
);
const cycleDanmuModeButton = document.querySelector(
	'button[data-action="cycle-danmu-mode"]',
);
const danmuModeValue = document.querySelector("#danmuModeValue");

closePlayerButton.disabled = true;

function setStatus(text, tone = "") {
	status.textContent = text;
	status.dataset.tone = tone;
}

function setButtonBusy(button, busy) {
	button.disabled = busy;
	button.classList.toggle("is-busy", busy);
	button.setAttribute("aria-busy", String(busy));
}

function normalizeDanmuMode(value) {
	return DANMU_MODES.includes(value) ? value : "direct";
}

function renderDanmuMode(mode) {
	danmuModeValue.textContent = DANMU_MODE_LABELS[normalizeDanmuMode(mode)];
}

async function getActiveTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

async function initializePopup() {
	const stored = await chrome.storage.local.get(DANMU_MODE_KEY);
	renderDanmuMode(stored[DANMU_MODE_KEY]);

	const tab = await getActiveTab();
	if (!tab?.id) {
		closePlayerButton.disabled = true;
		return;
	}
	try {
		const state = await chrome.tabs.sendMessage(tab.id, {
			type: "cd2-get-command-state",
		});
		closePlayerButton.disabled =
			!state?.availableCommands?.includes("close-player");
	} catch {
		closePlayerButton.disabled = true;
		setStatus("当前页面不支持播放器操作", "warning");
	}
}

for (const button of document.querySelectorAll("button[data-command]")) {
	button.addEventListener("click", async () => {
		setButtonBusy(button, true);
		setStatus("正在执行…");
		try {
			const tab = await getActiveTab();
			if (!tab?.id) throw new Error("无法获取当前标签页");
			const result = await chrome.tabs.sendMessage(tab.id, {
				type: "cd2-run-command",
				command: button.dataset.command,
			});
			setStatus(
				result?.ok ? "操作已完成" : result?.error || "操作失败",
				result?.ok ? "success" : "error",
			);
		} catch {
			setStatus("当前页面不支持此操作，请刷新网页后重试", "error");
		} finally {
			setButtonBusy(button, false);
		}
	});
}

cycleDanmuModeButton.addEventListener("click", async () => {
	setButtonBusy(cycleDanmuModeButton, true);
	try {
		const stored = await chrome.storage.local.get(DANMU_MODE_KEY);
		const current = normalizeDanmuMode(stored[DANMU_MODE_KEY]);
		const next =
			DANMU_MODES[(DANMU_MODES.indexOf(current) + 1) % DANMU_MODES.length];
		await chrome.storage.local.set({ [DANMU_MODE_KEY]: next });
		renderDanmuMode(next);
		setStatus(`弹幕模式已切换为“${DANMU_MODE_LABELS[next]}”`, "success");
	} catch (error) {
		setStatus(`切换失败：${error.message || error}`, "error");
	} finally {
		setButtonBusy(cycleDanmuModeButton, false);
	}
});

document
	.querySelector('button[data-action="open-options"]')
	.addEventListener("click", () => {
		chrome.runtime.openOptionsPage();
		window.close();
	});

document
	.querySelector('button[data-action="open-playback-options"]')
	.addEventListener("click", () => {
		void chrome.tabs.create({
			url: chrome.runtime.getURL("options.html#playback-settings"),
		});
		window.close();
	});

void initializePopup().catch((error) => {
	closePlayerButton.disabled = true;
	setStatus(`扩展状态读取失败：${error.message || error}`, "error");
});
