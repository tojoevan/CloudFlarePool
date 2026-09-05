#!/usr/bin/env bash
# Agent 自助部署（申请 / 审批 / 取用 模型，全程零 SSH）：
#   1. 读取本地缓存令牌（~/.workbuddy/cloudflarepool-agent.json），有效则复用；
#   2. 缺失/过期 → POST /api/agent/token/request {purpose} 申请，轮询 GET .../:id 直到运维审批；
#   3. 用令牌触发部署并轮询日志；
#   4. 若部署返回 401（被运维吊销）→ 清空缓存、重新申请一次。
# 用法：bash scripts/agent-deploy.sh "部署说明：修复 xx 路由" [--timeout 300]
set -uo pipefail

PURPOSE="Agent 自助部署请求"
TIMEOUT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="${2:-300}"; shift 2 ;;
    *) PURPOSE="$1"; shift ;;
  esac
done

BASE="https://home.inkspcl.com"
STORE_DIR="${HOME}/.workbuddy"
STORE_FILE="$STORE_DIR/cloudflarepool-agent.json"
# 若本地缓存了 baseUrl 则优先使用
if [ -f "$STORE_FILE" ]; then
  CACHED_BASE=$(node -e "try{process.stdout.write(require('$STORE_FILE').baseUrl||'')}catch(e){}" 2>/dev/null)
  [ -n "$CACHED_BASE" ] && BASE="$CACHED_BASE"
fi

json_get () { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)$1||''))}catch(e){}})" ; }

# 取得有效令牌：缓存有效则复用，否则申请+轮询审批
get_token () {
  # 1) 尝试缓存
  if [ -f "$STORE_FILE" ]; then
    CACHE_EXP=$(node -e "try{process.stdout.write(String(require('$STORE_FILE').expiresAtMs||''))}catch(e){}" 2>/dev/null)
    if [ -n "$CACHE_EXP" ] && [ "$(date +%s)000" -lt "$CACHE_EXP" ] 2>/dev/null; then
      node -e "try{process.stdout.write(require('$STORE_FILE').token||'')}catch(e){}" 2>/dev/null
      return 0
    fi
  fi
  # 2) 申请
  local purpose_json; purpose_json=$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$PURPOSE")
  local REQ; REQ=$(curl -s -X POST "$BASE/api/agent/token/request" \
    -H "Content-Type: application/json" -d "{\"purpose\":$purpose_json}")
  local RID; RID=$(printf '%s' "$REQ" | json_get ".requestId")
  if [ -z "$RID" ]; then echo "✗ 申请失败: $REQ" >&2; return 1; fi
  echo "==> 已提交部署申请 (requestId=$RID，用途: $PURPOSE)" >&2
  echo "    等待运维在管理后台「部署授权」审批（最长 10 分钟）..." >&2
  # 3) 轮询审批
  for _ in $(seq 1 120); do
    sleep 5
    local ST; ST=$(curl -s "$BASE/api/agent/token/request/$RID")
    local ST_STATUS; ST_STATUS=$(printf '%s' "$ST" | json_get ".status")
    if [ "$ST_STATUS" = "approved" ]; then
      local TK EXP; TK=$(printf '%s' "$ST" | json_get ".token"); EXP=$(printf '%s' "$ST" | json_get ".expiresAtMs")
      mkdir -p "$STORE_DIR"; umask 077
      cat > "$STORE_FILE" <<JSON
{ "token": "$TK", "expiresAtMs": $EXP, "baseUrl": "$BASE", "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
      chmod 600 "$STORE_FILE"
      echo "✓ 令牌已审批并缓存（过期 $(date -r $((EXP/1000)) 2>/dev/null || echo "$EXP")）" >&2
      echo "$TK"; return 0
    elif [ "$ST_STATUS" = "rejected" ] || [ "$ST_STATUS" = "revoked" ]; then
      echo "✗ 申请被$ST_STATUS，部署未执行。" >&2; return 1
    fi
  done
  echo "✗ 等待审批超时（10 分钟），请提醒运维审批。" >&2; return 1
}

TOKEN=$(get_token) || exit 1
[ -z "$TOKEN" ] && { echo "✗ 未取得令牌" >&2; exit 1; }

# 触发部署（遇 401 吊销则重申请一次）
trigger_deploy () {
  curl -s -w $'\n%{http_code}' -X POST "$BASE/api/agent/deploy" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
}

RESP=$(trigger_deploy)
HTTP=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')
if [ "$HTTP" = "401" ] || [ "$HTTP" = "403" ]; then
  echo "⚠️  令牌失效/被吊销（HTTP $HTTP），重新申请一次..." >&2
  rm -f "$STORE_FILE"
  TOKEN=$(get_token) || exit 1
  RESP=$(trigger_deploy)
  HTTP=$(printf '%s' "$RESP" | tail -1)
  BODY=$(printf '%s' "$RESP" | sed '$d')
fi
echo "HTTP $HTTP"
echo "$BODY"
if [ "$HTTP" != "202" ]; then echo "✗ 触发失败（HTTP $HTTP）" >&2; exit 4; fi

TASK_ID=$(printf '%s' "$BODY" | json_get ".taskId")
[ -z "$TASK_ID" ] && { echo "✗ 未返回 taskId" >&2; exit 5; }
echo "==> taskId=$TASK_ID，开始轮询日志（超时 ${TIMEOUT}s）..."

ELAPSED=0; INTERVAL=3; LOG=""
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  sleep "$INTERVAL"; ELAPSED=$((ELAPSED + INTERVAL))
  ST=$(curl -s "$BASE/api/agent/deploy/status/$TASK_ID" -H "Authorization: Bearer $TOKEN")
  STATUS=$(printf '%s' "$ST" | json_get ".status")
  EXITCODE=$(printf '%s' "$ST" | json_get ".exitCode")
  LOG=$(printf '%s' "$ST" | json_get ".log")
  echo "---- [${ELAPSED}s] status=$STATUS exit=${EXITCODE:-?} ----"
  printf '%s\n' "$LOG" | tail -12
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "failed" ]; then break; fi
done

echo
echo "===== 部署结果 ====="
echo "状态码: $STATUS  退出码: $EXITCODE"
if [ "$STATUS" = "failed" ]; then
  echo "✗ 部署失败，完整日志："
  printf '%s\n' "$LOG"
  if printf '%s' "$LOG" | grep -q "gateway runtime updated"; then
    echo "⚠️  本次部署更新了网关运行时(server.js)，但网关进程未重启，新代码尚未生效。"
    echo "    请在宝塔重启网关进程（或配置 DEPLOY_RESTART_CMD 自动重启）。"
  fi
  exit 1
fi
if [ "$STATUS" = "success" ]; then
  echo "✓ 部署成功。"
  if printf '%s' "$LOG" | grep -q "gateway runtime updated"; then
    echo "⚠️  注意：本次部署更新了网关运行时(server.js)，需宝塔重启网关进程后方可生效。"
  fi
fi
