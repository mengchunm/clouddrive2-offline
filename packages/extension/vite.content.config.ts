import path from "node:path";
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

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
	plugins: [react()],
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
