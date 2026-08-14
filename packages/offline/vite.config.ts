import path from "node:path";
import react from "@vitejs/plugin-react-swc";
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
    react(),
    monkey({
      entry: "src/userscript.tsx",
      userscript: {
        name: "clouddrive2-offline",
        namespace: "https://github.com/mengchunm/clouddrive2-offline",
        author: "saevio",
        description: "一键添加磁力链接到 CloudDrive2 离线下载 (fork from sqzw-x)",
        homepage: "https://github.com/mengchunm/clouddrive2-offline",
        match: ["https://*/*", "http://*/*"],
        connect: ["*"],
        grant: ["GM_registerMenuCommand", "GM_getValue", "GM_setValue", "GM_setClipboard", "unsafeWindow"],
      },
      build: {
        externalGlobals: {
          // antd: cdn.npmmirror("antd", "dist/antd.min.js"),
        },
      },
      server: {
        // mountGmApi: true,
      },
    }),
  ],
});
