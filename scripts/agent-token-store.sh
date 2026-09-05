#!/usr/bin/env bash
# 【可选·手动兜底】将 Agent 部署令牌安全存到本地（~/.workbuddy），绝不进仓库。
# 正常流程下 agent-deploy.sh 会自动申请+轮询审批并自缓存令牌，无需本脚本。
# 仅当你在管理后台「部署授权」手动复制了令牌时，用它本地存档。
# 用法：bash scripts/agent-token-store.sh <token> <expiresAtISO> [baseUrl]
#   <token>        管理后台「部署授权」审批后显示的令牌
#   <expiresAtISO>  建议有效期（如 2026-09-12T10:00:00.000Z）
#   [baseUrl]      网关地址，默认 https://home.inkspcl.com
set -euo pipefail

TOKEN="${1:-}"
EXPIRES="${2:-}"
BASE="${3:-https://home.inkspcl.com}"

if [ -z "$TOKEN" ] || [ -z "$EXPIRES" ]; then
  echo "用法: bash scripts/agent-token-store.sh <token> <expiresAtISO> [baseUrl]" >&2
  exit 1
fi

STORE_DIR="${HOME}/.workbuddy"
STORE_FILE="$STORE_DIR/cloudflarepool-agent.json"
mkdir -p "$STORE_DIR"
umask 077

cat > "$STORE_FILE" <<JSON
{
  "token": "$TOKEN",
  "expiresAt": "$EXPIRES",
  "baseUrl": "$BASE",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
chmod 600 "$STORE_FILE"
echo "✓ 已写入 $STORE_FILE (chmod 600)"
