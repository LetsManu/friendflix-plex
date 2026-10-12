#!/usr/bin/env bash
# Verifies the Plan B nginx config against a running backend + a fake Jellyfin, using a throw-away nginx container.
# Needs: docker, node, curl. The backend must be reachable at BACKEND_URL (default http://127.0.0.1:3100) with
# a valid session cookie in SID and INTERNAL_SECRET set. See docs/operations.md ("Plan B testen").
set -euo pipefail
: "${SID:?session id (ff_sid cookie value)}" "${INTERNAL_SECRET:?}"
BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:3100}"
JF_ECHO_PORT="${JF_ECHO_PORT:-9100}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$(mktemp -d)"
sed -e "s#__INTERNAL_SECRET__#${INTERNAL_SECRET}#" \
    -e "s#http://127.0.0.1:3081#${BACKEND_URL}#" \
    -e "s#http://127.0.0.1:8096#http://127.0.0.1:${JF_ECHO_PORT}#" \
    -e "s#Host 127.0.0.1:8096#Host 127.0.0.1:${JF_ECHO_PORT}#" \
    "$HERE/deploy/npm/plan-b-auth-request.conf" > "$CONF/plan-b.conf"
cat > "$CONF/nginx.conf" <<N
events {}
http { server { listen 8088; include /etc/nginx/plan-b.conf; location / { return 404; } location /internal/ { return 404; } } }
N
NAME=ff-planb-$$
docker run -d --rm --name "$NAME" --network host -v "$CONF/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$CONF/plan-b.conf:/etc/nginx/plan-b.conf:ro" nginx:alpine >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$CONF"' EXIT
sleep 1.5
ID=$(printf 'a%.0s' $(seq 32)); B=http://127.0.0.1:8088; fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check "no cookie -> 401"                 "$(code $B/media/Videos/$ID/master.m3u8)" 401
check "bad cookie -> 401"                "$(code -H 'Cookie: ff_sid=nope-nope-nope-nope-nope' $B/media/Videos/$ID/master.m3u8)" 401
check "valid session -> 200"             "$(code -H "Cookie: ff_sid=$SID" "$B/media/Videos/$ID/master.m3u8?MaxStreamingBitrate=999999999&api_key=LEAK")" 200
check "path outside allowlist -> 403"    "$(code -H "Cookie: ff_sid=$SID" $B/media/System/Info)" 403
check "traversal -> 403"                 "$(code -H "Cookie: ff_sid=$SID" "$B/media/Videos/$ID/hls1/main/..%2f..%2f..%2fSystem/Info")" 403
check "POST denied -> 403"               "$(code -X POST -H "Cookie: ff_sid=$SID" $B/media/Videos/$ID/master.m3u8)" 403
check "/internal/ not public -> 404"     "$(code $B/internal/authz-nginx)" 404
BODY=$(curl -s -D - -H "Cookie: ff_sid=$SID" -H 'Authorization: Bearer ATTACKER' -H 'X-Emby-Token: ATTACKER' "$B/media/Videos/$ID/master.m3u8?MaxStreamingBitrate=999999999&api_key=LEAK")
echo "$BODY" | grep -qi 'attacker' && { echo "FAIL client auth headers reached Jellyfin"; fail=1; } || echo "ok   client auth headers not forwarded"
echo "$BODY" | grep -q 'LEAK' && { echo "FAIL api_key reached Jellyfin"; fail=1; } || echo "ok   api_key stripped"
echo "$BODY" | grep -q 'MaxStreamingBitrate=60000000' && echo "ok   bitrate clamped to role limit" || { echo "FAIL bitrate not clamped"; fail=1; }
echo "$BODY" | grep -q 'Token="tok-' && echo "ok   user token injected server-side" || { echo "FAIL token not injected"; fail=1; }
echo "$BODY" | sed -n '1,/^\r$/p' | grep -qi 'set-cookie\|x-jellyfin\|authorization' && { echo "FAIL sensitive header leaked to browser"; fail=1; } || echo "ok   no Set-Cookie/token headers in response"
R=$(curl -s -D - -o /dev/null -H "Cookie: ff_sid=$SID" -H 'Range: bytes=0-9' "$B/media/Videos/$ID/stream?static=true")
echo "$R" | grep -q '206' && echo "ok   HTTP Range passthrough (206)" || { echo "FAIL range"; fail=1; }
[ "$fail" = 0 ] || { echo '--- nginx log:'; docker logs "$NAME" 2>&1 | tail -8; }
exit $fail
