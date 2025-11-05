#!/usr/bin/env bash
# CASE-PORT-20251101: ensure preview-ui primary port is free before dev server starts
PORT=5174
if PIDS=$(lsof -ti tcp:$PORT 2>/dev/null); then
  echo "[kill-preview-port] stopping processes on $PORT: $PIDS"
  kill $PIDS 2>/dev/null
  sleep 1
fi
