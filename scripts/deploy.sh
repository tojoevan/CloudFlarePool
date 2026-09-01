#!/usr/bin/env bash
# 一键部署脚本（经网关 /api/t4data/deploy 异步调用）。
#
# 职责：拉取最新代码 → 按需安装运行时依赖（锁文件变化时才装） → 部署数据湖（wrangler）→ 同步 SPA 静态资源 → 重写 version.json。
# 设计要点：
#   - 数据湖与 SPA 是独立部署单元，本脚本一次发齐（网关↔数据湖配套）。
#   - version.json 由本脚本重写；网关 /api/health 懒读它，故部署后**无需重启网关**
#     即在后台「版本矩阵」显示新 HEAD。仅当 server.js 自身改动时才需宝塔重启网关。
#   - CLOUDFLARE_API_TOKEN 由网关进程环境继承（网关 .env 中配置），wrangler 直接读取。
set -euo pipefail

REPO_DIR="${DEPLOY_REPO_DIR:-/opt/cloudflarepool}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/www/wwwroot/home.inkspcl.com}"

# 部署用 SSH 只读密钥（中立路径，网关无论以 root/www 运行均可读取，git pull 不依赖 ~/.ssh）
export GIT_SSH_COMMAND="ssh -i /opt/cloudflarepool-deploy/id_ed25519 -o StrictHostKeyChecking=no"

echo "[deploy] REPO_DIR=$REPO_DIR  WEB_ROOT=$WEB_ROOT"
echo "[deploy] CLOUDFLARE_API_TOKEN set: $([ -n "${CLOUDFLARE_API_TOKEN:-}" ] && echo yes || echo NO)"

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

# 仅在依赖锁文件变化（或首次/依赖缺失）时才重装依赖，避免每次部署都跑 npm ci：
#   - node_modules 不入 git，clone 后首装一次即可；之后锁文件不变则复用，显著加快部署。
#   - 锁文件指纹存于仓库内 .deploy-state/package-lock.sha256（已 gitignore），与仓库
#     同属主（www），可安全读写、随仓库迁移。
#   - 兜底：若 node_modules/hono 不存在（被清理/全新克隆），即使指纹匹配也强制重装。
#   - npm 缓存重定向到仓库内（REPO_DIR/.npm-cache）：系统 npm 缓存 /www/server/nodejs/cache
#     是 root 属主，网关以 www 身份运行时无写权限（EACCES），已上轮修复为仓库内缓存。
DEPLOY_STATE_DIR="$REPO_DIR/.deploy-state"
LOCK_HASH_FILE="$DEPLOY_STATE_DIR/package-lock.sha256"
mkdir -p "$DEPLOY_STATE_DIR"
CURRENT_LOCK_HASH=$(sha256sum "$REPO_DIR/package-lock.json" | awk '{print $1}')
LAST_LOCK_HASH=$(cat "$LOCK_HASH_FILE" 2>/dev/null || echo "")
if [ "$CURRENT_LOCK_HASH" != "$LAST_LOCK_HASH" ] || [ ! -d "$REPO_DIR/node_modules/hono" ]; then
  export npm_config_cache="$REPO_DIR/.npm-cache"
  echo "[deploy] package-lock.json changed or deps missing -> install runtime deps (npm ci --omit=dev)..."
  NODE_OPTIONS="--max-old-space-size=384" npm ci --omit=dev --no-audit --no-fund --cache "$REPO_DIR/.npm-cache"
  echo "$CURRENT_LOCK_HASH" > "$LOCK_HASH_FILE"
  echo "[deploy] deps installed"
else
  echo "[deploy] package-lock.json unchanged & node_modules present -> skip npm ci (fast path)"
fi

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

# 同步网关运行时代码到 WEB_ROOT（关键修复）。
# 旧设计只同步 SPA，导致改 server.js 后 WEB_ROOT 里跑的仍是旧代码——
# 「版本更新」拉了新代码却发不到运行目录，新增路由（如 /api/family）永远 404。
# 注意：网关进程实际从 WEB_ROOT 根层启动（node server.js，server.js/lib 都在根层，
# 不在 WEB_ROOT/gateway/ 子目录），故同步目标必须是 WEB_ROOT/ 而非 WEB_ROOT/gateway/。
# node_modules 沿用 WEB_ROOT 既有副本；若缺失则软链到 REPO_DIR/node_modules（deploy.sh 已 npm ci 过）。
echo "[deploy] sync gateway runtime to WEB_ROOT..."
cp -r gateway/server.js gateway/lib "$WEB_ROOT/" 2>/dev/null || true
if [ ! -e "$WEB_ROOT/node_modules" ] && [ -d "$REPO_DIR/node_modules" ]; then
  ln -sfn "$REPO_DIR/node_modules" "$WEB_ROOT/node_modules"
  echo "[deploy] symlinked node_modules -> $REPO_DIR/node_modules"
fi
echo "[deploy] gateway runtime synced"

# 可选：重启网关（仅 server.js 变更时才需要）。默认不重启，避免部署期间中断；
# 如需在 server.js 改动后自动重启，在网关 .env 配置 DEPLOY_RESTART_CMD。
if [ -n "${DEPLOY_RESTART_CMD:-}" ]; then
  echo "[deploy] restart: $DEPLOY_RESTART_CMD"
  eval "$DEPLOY_RESTART_CMD"
fi

echo "[deploy] DONE head=$HEAD"
