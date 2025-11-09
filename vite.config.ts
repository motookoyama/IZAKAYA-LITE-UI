import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

const DEFAULT_PROD_API_BASE = "https://izakaya-bff-95139013565.asia-northeast1.run.app";
const DEFAULT_DEV_API_BASE = "http://localhost:4117";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBase =
    env.VITE_API_BASE ||
    (mode === "development" ? DEFAULT_DEV_API_BASE : DEFAULT_PROD_API_BASE);
  const basePath = env.VITE_APP_BASE || "./";

  return {
    plugins: [react()],
    base: basePath,
    define: {
      __VITE_API_BASE__: JSON.stringify(apiBase),
    },
    build: {
      outDir: path.resolve(__dirname, "docs"),
      emptyOutDir: true,
    },
    preview: {
      host: true,
      port: Number(env.VITE_PREVIEW_PORT || 4173),
    },
    server: {
      host: true,
      port: Number(env.VITE_DEV_PORT || 5174),
      strictPort: true,
      proxy: {
        "/cards": apiBase,
        "/chat": apiBase,
        "/wallet": apiBase,
      },
    },
  };
});
