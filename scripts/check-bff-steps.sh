#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:4117}"

echo "=== BFF connectivity step check ==="
echo "Target base URL: ${BASE_URL}"
echo

call_endpoint() {
  local label="$1"
  local path="$2"
  local method="${3:-GET}"
  local data="${4:-}"

  local url="${BASE_URL%/}${path}"
  local tmp_body
  tmp_body="$(mktemp)"

  echo "-- ${label}: ${method} ${url}"

  local status
  if [[ "${method}" == "POST" ]]; then
    status="$(curl -sS -o "${tmp_body}" -w "%{http_code}" \
      -H "Content-Type: application/json" \
      -X POST \
      -d "${data}" \
      "${url}" || echo "000")"
  else
    status="$(curl -sS -o "${tmp_body}" -w "%{http_code}" \
      "${url}" || echo "000")"
  fi

  local body
  body="$(cat "${tmp_body}")"
  rm -f "${tmp_body}"

  echo "   status: ${status}"
  if [[ -n "${body}" ]]; then
    echo "${body}" | sed 's/^/   body  : /'
  else
    echo "   body  : (empty)"
  fi

  if [[ "${status}" != "200" ]]; then
    echo "   result: ❌ failure"
    return 1
  fi

  echo "   result: ✅ success"
  echo
  return 0
}

failures=0

call_endpoint "health/ping" "/health/ping" || failures=$((failures + 1))

call_endpoint "admin/info" "/admin/info" || failures=$((failures + 1))

call_endpoint "chat/v1" "/chat/v1" "POST" '{"prompt":"health-check from check-bff-steps.sh"}' || failures=$((failures + 1))

if [[ "${failures}" -eq 0 ]]; then
  echo "All steps succeeded ✅"
  exit 0
else
  echo "Completed with ${failures} failure(s) ❌"
  exit 1
fi
