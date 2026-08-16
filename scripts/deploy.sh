#!/usr/bin/env bash
# 一键部署脚本（经网关 /api/t4data/deploy 异步调用）。
#
# 职责：拉取最新代码 → 部署数据湖（wrangler）→ 同步 SPA 静态资源 → 重写 version.json。
# 设计要点：
#   - 数据湖与 SPA 是独立部署单元，本脚本一次发齐（网关↔数据湖配套）。
#   - version.json 由本脚本重写；网关 /api/health 懒读它，故部署后**无需重启网关**
#     即在后台「版本矩阵」显示新 HEAD。仅当 server.js 自身改动时才需宝塔重启网关。
#   - CF_API_TOKEN 由网关进程环境继承（网关 .env 中配置），wrangler 直接读取。
set -uo pipefail

REPO_DIR="${DEPLOY_REPO_DIR:-/opt/cloudflarepool}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/www/wwwroot/home.inkspcl.com}"

echo "[deploy] REPO_DIR=$REPO_DIR  WEB_ROOT=$WEB_ROOT"
echo "[deploy] CF_API_TOKEN set: $([ -n "${CF_API_TOKEN:-}" ] && echo yes || echo NO)"

cd "$REPO_DIR" || { echo "[deploy] ERROR: cannot cd $REPO_DIR"; exit 1; }

echo "[deploy] git pull origin main..."
git pull --ff-only origin main
HEAD=$(git rev-parse --short HEAD)
echo "[deploy] HEAD=$HEAD"

# 重写网关版本号（health 懒加载读取，无需重启网关即可生效）。
# 网关进程实际从 WEB_ROOT 启动（宝塔入口），故 version.json 必须写到
# WEB_ROOT/version.json（__dirname 解析处）；仓库克隆目录也同步一份保持致。
printf '{"git":"%s"}\n' "$HEAD" > "$WEB_ROOT/version.json"
printf '{"git":"%s"}\n' "$HEAD" > gateway/version.json
echo "[deploy] wrote version.json (git=$HEAD) -> $WEB_ROOT/version.json"

# 部署数据湖（带上 GIT_HEAD，便于后台核对部署版本）
echo "[deploy] wrangler deploy datalake (GIT_HEAD=$HEAD)..."
wrangler deploy --var GIT_HEAD:"$HEAD"
echo "[deploy] datalake deployed"

# 同步静态 SPA（免重启）
echo "[deploy] sync SPA statics..."
mkdir -p "$WEB_ROOT/public/admin" "$WEB_ROOT/public/spa"
cp -r gateway/public/admin/. "$WEB_ROOT/public/admin/"
cp -r gateway/public/spa/. "$WEB_ROOT/public/spa/" 2>/dev/null || true
echo "[deploy] SPA synced"

# 可选：重启网关（仅 server.js 变更时才需要）。默认不重启，避免部署期间中断；
# 如需在 server.js 改动后自动重启，在网关 .env 配置 DEPLOY_RESTART_CMD。
if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then
  echo "[deploy] restart: $DEPLOY_RESTART_CMD"
  eval "$DEPLOY_RESTART_CMD"
fi

echo "[deploy] DONE head=$HEAD"
