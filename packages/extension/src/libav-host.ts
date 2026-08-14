let initialized = false;

window.addEventListener("message", (event: MessageEvent) => {
	if (
		initialized ||
		event.source !== window.parent ||
		event.data?.type !== "cd2-libav-host-init" ||
		!event.ports[0]
	) {
		return;
	}
	initialized = true;
	const port = event.ports[0];
	const workerUrl =
		window.location.protocol === "chrome-extension:"
			? chrome.runtime.getURL("libav-worker.js")
			: new URL("./libav-worker.js", window.location.href).toString();
	const worker = new Worker(workerUrl, {
		type: "module",
	});
	port.addEventListener("message", (portEvent: MessageEvent) => {
		const data = portEvent.data;
		const transfer = data?.data instanceof ArrayBuffer ? [data.data] : [];
		worker.postMessage(data, transfer);
	});
	worker.addEventListener("message", (workerEvent: MessageEvent) => {
		const data = workerEvent.data;
		const transfer = data?.data instanceof ArrayBuffer ? [data.data] : [];
		port.postMessage(data, transfer);
	});
	worker.addEventListener("error", (error) => {
		port.postMessage({
			type: "host-error",
			error: error.message || "libav Worker 启动失败",
		});
	});
	port.start();
	port.postMessage({ type: "host-ready" });
});
