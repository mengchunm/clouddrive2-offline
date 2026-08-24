import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

function patchLibassCanvasReadback() {
	return {
		name: "cd2-libass-will-read-frequently",
		enforce: "pre" as const,
		transform(code: string, id: string) {
			const normalizedId = id.replaceAll("\\", "/").split("?", 1)[0];
			if (!normalizedId.endsWith("/libass-wasm/dist/js/subtitles-octopus.js")) {
				return null;
			}
			const patchedCode = code.replace(
				/getContext\(\s*(['"])2d\1\s*\)/g,
				(_match, quote: string) =>
					`getContext(${quote}2d${quote}, { willReadFrequently: true })`,
			);
			if (patchedCode === code && code.includes("getImageData")) {
				throw new Error(
					"libass Canvas readback patch no longer matches subtitles-octopus.js",
				);
			}
			return patchedCode === code ? null : { code: patchedCode, map: null };
		},
	};
}

export default defineConfig({
	publicDir: "public",
	define: {
		__CD2_EXTENSION_BUILD__: "true",
		"process.env.NODE_ENV": JSON.stringify("production"),
	},
	resolve: {
		alias: [
			{
				find: "vite-plugin-monkey/dist/client",
				replacement: path.resolve(__dirname, "src/compat/monkey.ts"),
			},
			{
				find: "artplayer-plugin-libass",
				replacement: path.resolve(__dirname, "src/compat/libass-plugin.ts"),
			},
			{ find: "@", replacement: path.resolve(__dirname, "../offline/src") },
		],
	},
	plugins: [patchLibassCanvasReadback(), react()],
	build: {
		outDir: "build",
		emptyOutDir: true,
		target: "chrome109",
		minify: true,
		lib: {
			entry: path.resolve(__dirname, "src/content.ts"),
			formats: ["iife"],
			name: "CloudDrive2Extension",
			fileName: () => "content.js",
		},
		rollupOptions: {
			output: {
				assetFileNames: (assetInfo) =>
					assetInfo.names.some((name) => name.endsWith(".css"))
						? "style.css"
						: "assets/[name]-[hash][extname]",
			},
		},
	},
});
