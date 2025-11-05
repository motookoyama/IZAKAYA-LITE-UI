import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiBase = env.VITE_API_BASE || "http://localhost:4117";
  return {
    plugins: [react()],
    base: env.VITE_APP_BASE || "./",
    build: {
      outDir: path.resolve(__dirname, "dist"),
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
