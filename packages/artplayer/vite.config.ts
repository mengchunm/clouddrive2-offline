import path from "node:path";
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	build: {
		minify: true,
	},
	plugins: [
		monkey({
			entry: "src/main.ts",
			userscript: {
				name: "clouddrive2-artplayer",
				namespace: "https://github.com/mengchunm/clouddrive2-artplayer",
				author: "saevio",
				description:
					"CloudDrive2 视频播放器 - 基于 ArtPlayer，集成弹弹Play弹幕",
				homepage: "https://github.com/mengchunm/clouddrive2-artplayer",
				match: ["https://*/*", "http://*/*"],
				connect: ["api.dandanplay.net", "*"],
				grant: [
					"GM_xmlhttpRequest",
					"GM_registerMenuCommand",
					"GM_getValue",
					"GM_setValue",
					"unsafeWindow",
				],
			},
		}),
	],
});
