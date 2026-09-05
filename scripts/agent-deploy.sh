#!/usr/bin/env bash
# Agent 自助部署：读取本地令牌 → 触发部署 → 轮询日志 → 输出结果（全程零 SSH）。
# 依赖：本地已用 agent-token-store.sh 存入运维下发的 token。
# 用法：bash scripts/agent-deploy.sh [--timeout 300]
set -uo pipefail

TIMEOUT=300
if [ "${1:-}" = "--timeout" ]; then TIMEOUT="${2:-300}"; fi

STORE_FILE="${HOME}/.workbuddy/cloudflarepool-agent.json"
if [ ! -f "$STORE_FILE" ]; then
  echo "ERROR: 找不到本地令牌 $STORE_FILE。请先运行 agent-token-store.sh 存入运维下发的 token。" >&2
  exit 2
fi

TOKEN=$(node -e "process.stdout.write(require('$STORE_FILE').token || '')")
BASE=$(node -e "process.stdout.write(require('$STORE_FILE').baseUrl || 'https://home.inkspcl.com')")
EXPIRES=$(node -e "process.stdout.write(require('$STORE_FILE').expiresAt || '')")

if [ -z "$TOKEN" ]; then echo "ERROR: 本地令牌为空，请重新 store。" >&2; exit 2; fi

# 本地有效期自检：过期直接拒绝，提示运维轮换
if [ -n "$EXPIRES" ]; then
  NOW_MS=$(date +%s)000
  EXP_MS=$(node -e "process.stdout.write(String(Date.parse('$EXPIRES')))")
  if [ "$NOW_MS" -gt "$EXP_MS" ] 2>/dev/null; then
    echo "ERROR: Agent 令牌已过期（$EXPIRES），请联系运维轮换：POST /api/t4data/agent-token/rotate" >&2
    exit 3
  fi
  LEFT_H=$(( (EXP_MS - NOW_MS) / 3600000 ))
  if [ "$LEFT_H" -lt 24 ]; then
    echo "⚠️  令牌将在约 ${LEFT_H} 小时内过期，建议尽快请运维轮换。" >&2
  fi
fi

echo "==> 触发部署: POST $BASE/api/agent/deploy"
RESP=$(curl -s -w $'\n%{http_code}' -X POST "$BASE/api/agent/deploy" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
HTTP=$(printf '%s' "$RESP" | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')
echo "HTTP $HTTP"
echo "$BODY"
if [ "$HTTP" != "202" ]; then
  echo "✗ 触发失败（HTTP $HTTP）" >&2
  exit 4
fi

TASK_ID=$(printf '%s' "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).taskId||''))")
if [ -z "$TASK_ID" ]; then echo "✗ 未返回 taskId" >&2; exit 5; fi
echo "==> taskId=$TASK_ID，开始轮询日志（超时 ${TIMEOUT}s）..."

ELAPSED=0; INTERVAL=3; LOG=""
while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  sleep "$INTERVAL"; ELAPSED=$((ELAPSED + INTERVAL))
  ST=$(curl -s "$BASE/api/agent/deploy/status/$TASK_ID" -H "Authorization: Bearer $TOKEN")
  STATUS=$(printf '%s' "$ST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).status||''))")
  EXITCODE=$(printf '%s' "$ST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).exitCode===null||JSON.parse(s).exitCode===undefined?'':JSON.parse(s).exitCode)))")
  LOG=$(printf '%s' "$ST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const t=JSON.parse(s);process.stdout.write((t.log||[]).join('\n'))})")
  echo "---- [${ELAPSED}s] status=$STATUS exit=$EXITCODE ----"
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
