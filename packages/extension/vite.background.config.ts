import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		outDir: "build",
		emptyOutDir: false,
		target: "chrome109",
		minify: true,
		lib: {
			entry: path.resolve(__dirname, "src/background.ts"),
			formats: ["es"],
			fileName: () => "background.js",
		},
	},
});
