import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		outDir: "build",
		emptyOutDir: false,
		copyPublicDir: false,
		target: "chrome109",
		minify: true,
		lib: {
			entry: path.resolve(__dirname, "src/audio-host.ts"),
			formats: ["iife"],
			name: "Cd2AudioHost",
			fileName: () => "audio-host.js",
		},
	},
});
