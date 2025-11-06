#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"

echo "Working directory: ${ROOT_DIR}"

# 1) BFF 接続ロジック
cat <<'EOF' > "${ROOT_DIR}/src/lib/bff.ts"
let cachedHealthUrl: string | null = null;
let cachedHealthBase: string | null = null;

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

const DEFAULT_PROD_BASE = "https://izakaya-verse-promo-95139013565.asia-northeast1.run.app";
const DEFAULT_DEV_BASE = "http://localhost:4117";

export function resolveBffBase(): string {
  const candidates = [
    import.meta.env.VITE_REACT_APP_BFF_URL,
    import.meta.env.VITE_BFF_URL,
    import.meta.env.REACT_APP_BFF_URL,
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);

  if (candidates.length > 0) {
    return trimTrailingSlash(candidates[0]);
  }

  if (typeof window !== "undefined" && window.location) {
    const origin = window.location.origin.replace(/\/+$/, "");
    if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
      return DEFAULT_DEV_BASE;
    }
  }
  return DEFAULT_PROD_BASE;
}

export function clearCachedHealthUrl(): void {
  cachedHealthUrl = null;
  cachedHealthBase = null;
}

export async function getHealthUrl(baseOverride?: string): Promise<string> {
  const base = trimTrailingSlash(baseOverride ?? resolveBffBase());
  if (cachedHealthUrl && cachedHealthBase === base) {
    return cachedHealthUrl;
  }

  const adminInfoUrl = `${base}/admin/info`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(adminInfoUrl, { signal: controller.signal, cache: "no-store" });
    clearTimeout(timeout);
    if (response.ok) {
      const info = await response.json().catch(() => ({}));
      if (info && typeof info.health_url === "string" && info.health_url.trim()) {
        cachedHealthBase = base;
        cachedHealthUrl = `${base}${info.health_url}`;
        return cachedHealthUrl;
      }
    }
  } catch {
    // ignore failures and fall back
  }

  cachedHealthBase = base;
  cachedHealthUrl = `${base}/health/ping`;
  return cachedHealthUrl;
}
EOF

# 2) Vite 設定
cat <<'EOF' > "${ROOT_DIR}/vite.config.ts"
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";

const DEFAULT_PROD_API_BASE = "https://izakaya-verse-promo-95139013565.asia-northeast1.run.app";
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
EOF

# 3) nginx.conf (Cloud Run 用)
cat <<'EOF' > "${ROOT_DIR}/nginx.conf"
server {
    listen 8080;
    server_name localhost;

    root /usr/share/nginx/html;
    index index.html;

    include /etc/nginx/mime.types;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        try_files $uri =404;
    }

    error_log /dev/stderr warn;
    access_log /dev/stdout main;
}
EOF

# 4) index.html (base タグ追加)
cat <<'EOF' > "${ROOT_DIR}/index.html"
<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <title>IZAKAYA Lite Preview</title>
  </head>
  <body class="min-h-screen bg-[#0b1533]">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

# 5) CODEX (運用ルール)
mkdir -p "${ROOT_DIR}/docs"
cat <<'EOF' > "${ROOT_DIR}/docs/CODEX.md"
# IZAKAYA-LITE-UI CODEX
## BFF 接続ルール（必読）

### ■ 本番環境
常に Google Cloud Run の BFF を使用する：

https://izakaya-verse-promo-95139013565.asia-northeast1.run.app

`VITE_API_BASE` を上記 URL に固定し、公開ビルドでローカル BFF を参照させないこと。

### ■ ローカル開発
デバッグ時のみ `http://localhost:4117` を使用：
VITE_API_BASE="http://localhost:4117"



### ■ 理由
- 端末依存を排除
- CORS エラーを回避
- 常に同一バージョンの BFF を利用
EOF

echo "=== Done! ==="
echo "次の手順:"
echo "1) ターミナルにフルディスクアクセスを付与 or Documents以外へ移動してから"
echo "   npm run build"
echo "2) git status で差分確認 → git add → git commit → git push"
