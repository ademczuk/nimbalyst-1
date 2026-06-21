#!/usr/bin/env bash
# End-to-end smoke test for the nimbalyst control plane (/control/v1/*).
#
# Reads token + port from the running nimbalyst's userData dir, exercises
# every route in order, and asserts the round-trip works:
#   1. GET /control/v1/health
#   2. POST /control/v1/sessions
#   3. POST /control/v1/sessions/:id/messages
#   4. GET /control/v1/sessions/:id
#   5. GET /control/v1/sessions/:id/transcript
#
# Usage:
#   bash scripts/test-control-plane.sh [WORKSPACE_ID]
# Default WORKSPACE_ID: "ws-control-test" (created on the fly).
#
# Exit codes:
#   0  all checks passed
#   1  precondition failure (token/port missing — nimbalyst not running)
#   2  test failure (at least one step returned non-2xx)

set -euo pipefail

# Resolve userData. Defaults match Electron's app.getPath('userData') for
# Windows + macOS + Linux dev installs of @nimbalyst/electron.
case "$(uname -s 2>/dev/null || echo Windows)" in
    Linux*)
        USERDATA="${HOME}/.config/@nimbalyst/electron"
        ;;
    Darwin*)
        USERDATA="${HOME}/Library/Application Support/@nimbalyst/electron"
        ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
        USERDATA="${APPDATA:-${HOME}/AppData/Roaming}/@nimbalyst/electron"
        ;;
    *)
        USERDATA="${HOME}/.config/@nimbalyst/electron"
        ;;
esac

# Allow override via env for the user2 dev mode (NIMBALYST_USER_DATA_DIR).
USERDATA="${NIMBALYST_USER_DATA_DIR:-$USERDATA}"

TOKEN_FILE="${USERDATA}/.control-token"
PORT_FILE="${USERDATA}/.control-port"
WORKSPACE_ID="${1:-ws-control-test}"

if [[ ! -r "$TOKEN_FILE" ]]; then
    echo "ERROR: token file not readable: $TOKEN_FILE"
    echo "Is nimbalyst running? Token is written at MCP server startup."
    exit 1
fi
if [[ ! -r "$PORT_FILE" ]]; then
    echo "ERROR: port file not readable: $PORT_FILE"
    exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
PORT="$(cat "$PORT_FILE")"
BASE="http://127.0.0.1:${PORT}/control/v1"

echo "userData : $USERDATA"
echo "port     : $PORT"
echo "token    : ${TOKEN:0:8}... (32-byte hex)"
echo "base url : $BASE"
echo

fail=0

check() {
    local name="$1"
    local expected_status="$2"
    local actual_status="$3"
    local body="$4"
    if [[ "$actual_status" == "$expected_status" ]]; then
        echo "PASS  $name  ($actual_status)"
        if [[ -n "$body" ]]; then
            echo "      body: $(echo "$body" | head -c 200)"
        fi
    else
        echo "FAIL  $name  (expected $expected_status, got $actual_status)"
        echo "      body: $body"
        fail=$((fail + 1))
    fi
}

# 1. Health
echo "-- 1. GET /health"
status=$(curl -s -o /tmp/ctrl_health.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$BASE/health")
check "health" 200 "$status" "$(cat /tmp/ctrl_health.json)"

# 2. Auth negative test — request without token should 401
echo "-- 2. health (no token, expect 401)"
status=$(curl -s -o /tmp/ctrl_noauth.json -w "%{http_code}" "$BASE/health")
check "health-noauth" 401 "$status" "$(cat /tmp/ctrl_noauth.json)"

# 3. Create session
echo "-- 3. POST /sessions"
status=$(curl -s -o /tmp/ctrl_create.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"workspaceId\": \"$WORKSPACE_ID\", \"provider\": \"kimiclaw\", \"model\": \"kimi-code/kimi-for-coding\", \"title\": \"control-plane smoke test\"}" \
    "$BASE/sessions")
check "create-session" 201 "$status" "$(cat /tmp/ctrl_create.json)"

SESSION_ID="$(cat /tmp/ctrl_create.json | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)"
if [[ -z "$SESSION_ID" ]]; then
    echo "ERROR: could not extract session_id; aborting downstream checks"
    exit 2
fi
echo "      session_id: $SESSION_ID"

# 4. Get session
echo "-- 4. GET /sessions/:id"
status=$(curl -s -o /tmp/ctrl_get.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SESSION_ID")
check "get-session" 200 "$status" "$(cat /tmp/ctrl_get.json)"

# 5. Send message
echo "-- 5. POST /sessions/:id/messages"
status=$(curl -s -o /tmp/ctrl_send.json -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"prompt": "ping from control-plane smoke test"}' \
    "$BASE/sessions/$SESSION_ID/messages")
check "send-message" 202 "$status" "$(cat /tmp/ctrl_send.json)"

# 6. Get transcript (will be sparse since renderer may not have processed yet)
echo "-- 6. GET /sessions/:id/transcript"
status=$(curl -s -o /tmp/ctrl_transcript.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SESSION_ID/transcript?limit=10")
check "get-transcript" 200 "$status" "$(cat /tmp/ctrl_transcript.json)"

# 7. Get 404 for missing session
echo "-- 7. GET /sessions/does-not-exist (expect 404)"
status=$(curl -s -o /tmp/ctrl_404.json -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$BASE/sessions/does-not-exist")
check "404-missing-session" 404 "$status" "$(cat /tmp/ctrl_404.json)"

echo
if [[ $fail -eq 0 ]]; then
    echo "OK: all control-plane checks passed"
    exit 0
else
    echo "FAIL: $fail check(s) failed"
    exit 2
fi
