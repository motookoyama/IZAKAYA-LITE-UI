#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== IZAKAYA Lite | Production Build Consistency Check ==="
EXIT_CODE=0

DOCS_INDEX="docs/index.html"

if [ ! -f "${DOCS_INDEX}" ]; then
  echo "❌ ${DOCS_INDEX} が存在しません。まず npm run build を実行してください。"
  EXIT_CODE=1
else
  if [ -d src ]; then
    if find src -type f -newer "${DOCS_INDEX}" | head -n 1 | grep -q '.'; then
      echo "❌ src/ に ${DOCS_INDEX} より新しいファイルがあります。npm run build で最新化してください。"
      EXIT_CODE=1
    else
      echo "✅ src/ の更新は docs/ に反映済みです。"
    fi
  else
    echo "⚠️ src/ ディレクトリが見つかりませんでした。構成を確認してください。"
  fi
fi

if git status --porcelain -- docs .env.production | grep -q '.'; then
  echo "❌ docs/ または .env.production に未コミットの変更があります。git add/commit/push を忘れないでください。"
  EXIT_CODE=1
else
  echo "✅ docs/ と .env.production に未コミットの変更はありません。"
fi

if [ "${EXIT_CODE}" -eq 0 ]; then
  echo "=== OK: 本番配信用アセットは最新です ==="
else
  echo "=== NG: 上記の問題を解決してからデプロイしてください ==="
fi

exit "${EXIT_CODE}"
