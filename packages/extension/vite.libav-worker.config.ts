import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const libavDistDirectory = path.resolve(
	__dirname,
	"node_modules/@libav.js/variant-default/dist",
);
const libavFactoryId = "virtual:cd2-libav-factory";
const libavWasmId = "virtual:cd2-libav-wasm-base64";
const resolvedLibavWasmId = `\0${libavWasmId}`;

export default defineConfig({
	plugins: [
		{
			name: "cd2-inline-libav-runtime",
			resolveId(id) {
				if (id === libavFactoryId) {
					return path.join(
						libavDistDirectory,
						"libav-6.9.8.1-default.wasm.mjs",
					);
				}
				if (id === libavWasmId) return resolvedLibavWasmId;
			},
			load(id) {
				if (id !== resolvedLibavWasmId) return;
				const wasm = readFileSync(
					path.join(libavDistDirectory, "libav-6.9.8.1-default.wasm.wasm"),
				).toString("base64");
				return `export default ${JSON.stringify(wasm)};`;
			},
		},
	],
	build: {
		outDir: "build",
		emptyOutDir: false,
		copyPublicDir: false,
		target: "chrome109",
		minify: true,
		lib: {
			entry: path.resolve(__dirname, "src/libav-worker.ts"),
			formats: ["es"],
			fileName: () => "libav-worker.js",
		},
	},
});
