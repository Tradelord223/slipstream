import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const apiTarget = process.env.SLIPSTREAM_API ?? "http://127.0.0.1:4392";

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  server: {
    port: 5180,
    strictPort: true,
    open: false,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url)), realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url)))] },
    proxy: {
      "/api": {
        target: apiTarget,
        // The server only answers to its own Host and Origin; present the dev page as if it were served from there.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", apiTarget);
          });
        },
      },
    },
  },
});
