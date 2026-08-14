const status = document.querySelector("#status");

for (const button of document.querySelectorAll("button[data-command]")) {
  button.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: "cd2-run-command",
        titlePrefix: button.dataset.command,
      });
      status.textContent = result?.ok ? "操作已发送到当前页面" : result?.error || "操作失败";
    } catch {
      status.textContent = "扩展尚未注入当前页面，请刷新该网页后重试";
    }
  });
}

document.querySelector('button[data-action="open-options"]').addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
