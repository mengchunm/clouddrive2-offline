import { startArtplayer } from "../../artplayer/src/main";
import { startOffline } from "../../offline/src/userscript";
import { registerAudioFallbackBridge } from "./compat/audio-fallback";
import { registerLibavSubtitleBridge } from "./compat/libav-subtitles";
import {
	preloadExtensionStorage,
	registerExtensionCommandBridge,
} from "./compat/monkey";
import { registerVideoRendererBridge } from "./compat/video-renderer";

async function start(): Promise<void> {
	await preloadExtensionStorage();
	registerExtensionCommandBridge();
	registerLibavSubtitleBridge();
	registerAudioFallbackBridge();
	registerVideoRendererBridge();
	startArtplayer();
	startOffline();
	console.info("[cd2-extension] CloudDrive2 浏览器扩展已加载");
}

void start().catch((error) => console.error("[cd2-extension] 启动失败", error));
