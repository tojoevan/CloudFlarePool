#!/usr/bin/env bash
# 一键部署脚本（经网关 /api/t4data/deploy 异步调用）。
#
# 职责：拉取最新代码 → 按需安装运行时依赖（锁文件变化时才装） → 部署数据湖（wrangler）→ 同步 SPA 静态资源 → 重写 version.json。
# 设计要点：
#   - 数据湖与 SPA 是独立部署单元，本脚本一次发齐（网关↔数据湖配套）。
#   - version.json 由本脚本重写；网关 /api/health 懒读它，故部署后**无需重启网关**
#     即在后台「版本矩阵」显示新 HEAD。仅当 server.js 自身改动时才需宝塔重启网关。
#   - CLOUDFLARE_API_TOKEN 由网关进程环境继承（网关 .env 中配置），wrangler 直接读取。
#
# 【部署权限规则（D）】本脚本只可由 www 身份运行（宝塔「版本更新」按钮经 www 网关进程 spawn 即满足）。
#   严禁以 root 手跑本脚本或在 /opt/cloudflarepool 以 root 执行 git：root 写下的对象属主为 root，
#   会导致 www 运行的按钮后续 git pull 写不进 .git/objects（EACCES）。仓库与 wrangler HOME 已统一为 www 属主/可写。
set -euo pipefail

# —— 权限守卫（B）：禁止以 root 运行，防止权限污染 ——
if [ "$(id -u)" -eq 0 ]; then
  echo "[deploy] ERROR: 禁止以 root 运行 deploy.sh（会造成 /opt/cloudflarepool 权限污染，致按钮后续 git pull EACCES）。" >&2
  echo "[deploy] 请以 www 身份运行，或经宝塔「版本更新」按钮触发。" >&2
  exit 1
fi

REPO_DIR="${DEPLOY_REPO_DIR:-/opt/cloudflarepool}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/www/wwwroot/home.inkspcl.com}"

# 部署用 SSH 只读密钥（中立路径，www 可读取；契合「只用 www 操作仓库」规则，不依赖 ~/.ssh）
export GIT_SSH_COMMAND="ssh -i /opt/cloudflarepool-deploy/id_ed25519 -o StrictHostKeyChecking=no"

# 网关进程（www）继承了启动者 root 的 HOME=/root（700，www 不可进入），
# 而 wrangler/npm 会把日志·缓存写到 $HOME 下，导致 EACCES 部署失败。
# 这里把 HOME 重定向到 www 专属可写目录（建表时已 chown www:www），兜底 /tmp。
export HOME="/www/.cloudflare-home"
mkdir -p "$HOME" 2>/dev/null || export HOME="/tmp"

echo "[deploy] REPO_DIR=$REPO_DIR  WEB_ROOT=$WEB_ROOT"
echo "[deploy] CLOUDFLARE_API_TOKEN set: $([ -n "${CLOUDFLARE_API_TOKEN:-}" ] && echo yes || echo NO)"

cd "$REPO_DIR" || { echo "[deploy] ERROR: cannot cd $REPO_DIR"; exit 1; }

# 还原上次部署被 sed 改动的 wrangler.toml，避免工作区 dirty 导致后续 git pull 失败
git checkout -- wrangler.toml 2>/dev/null || true

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

# 部署数据湖。⚠️ 必须先改 wrangler.toml 的 GIT_HEAD 再裸 wrangler deploy：
# wrangler 4.120 下 --var GIT_HEAD 无法覆盖 toml 同名 [vars]，运行时 env 仍取兜底旧值，
# 会致 health.git 显示旧 sha、与 version.json(HEAD) 不一致（详见部署方案第八节第 5 条）。
sed -i.bak -E "s/^GIT_HEAD = \".*\"/GIT_HEAD = \"$HEAD\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "[deploy] wrangler deploy datalake (GIT_HEAD=$HEAD)..."
wrangler deploy
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
echo "[deploy] gateway runtime updated: server.js (requires gateway restart to take effect)"
if [ ! -e "$WEB_ROOT/node_modules" ] && [ -d "$REPO_DIR/node_modules" ]; then
  ln -sfn "$REPO_DIR/node_modules" "$WEB_ROOT/node_modules"
  echo "[deploy] symlinked node_modules -> $REPO_DIR/node_modules"
fi
echo "[deploy] gateway runtime synced"

# ---- 部署后网关重启（默认不重启，零中断）----
# 仅当网关运行时代码(server.js)真正变化时才需重启；SPA/数据湖发版不触发。
# 重启方式（读取顺序：先继承环境变量，再读网关 .env 文件）：
#   1) DEPLOY_RESTART_CMD（推荐，用户显式指定）：如 `pm2 restart <app>`。由用户自行保证该命令
#      以正确用户/cwd 拉起新 server.js，最可靠。
#   2) 【已废弃】kill 网关进程触发宝塔自愈的自动重启：经生产实测，宝塔对【外部 kill】走的是
#      应急路径（以 root、错误 cwd 拉起 node server.js），会导致网关起不来/502，且偶有卡死；
#      宝塔仅在【面板点「重启」】时才用正确 www 上下文干净重启。故 kill 方案不安全，已删除。
# ⚠️ 若未配置 DEPLOY_RESTART_CMD 且 server.js 变化：仅打印提示，需手动在宝塔点「重启」网关，
#    切勿靠 kill 自动触发。
# ⚠️ 重启命令必须「延迟+脱离进程树」执行：deploy.sh 是网关(node) spawn 的子进程，同步杀网关
#    会连部署任务一起带走、致状态写不全。延迟 3s 待部署落库成功后再重启。
# 从网关 .env 读取配置（不 source 全文件，避免污染其它环境；优先用已继承的环境变量）。
env_get () {
  local k="$1" v=""
  if [ -n "${!k:-}" ]; then v="${!k}";
  elif [ -f "$WEB_ROOT/.env" ]; then
    v=$(grep -E "^[[:space:]]*$k[[:space:]]*=" "$WEB_ROOT/.env" 2>/dev/null | tail -1 | sed -E "s/^[^=]+=//" | sed -E "s/^[\"']|[\"']\$//g")
  fi
  printf '%s' "$v"
}
RESTART_CMD=$(env_get DEPLOY_RESTART_CMD)
LAST_SHA="$WEB_ROOT/.deploy-last-serverjs.sha"
NEW_SHA=$(sha256sum "$WEB_ROOT/server.js" 2>/dev/null | awk '{print $1}')
NEED_RESTART=0
if [ -n "$NEW_SHA" ]; then
  if [ -f "$LAST_SHA" ]; then
    if [ "$(cat "$LAST_SHA" 2>/dev/null)" != "$NEW_SHA" ]; then
      NEED_RESTART=1
      echo "$NEW_SHA" > "$LAST_SHA" 2>/dev/null || true
    fi
  else
    # 首次：仅建立基线，不重启（避免对未变更的 server.js 误重启）
    echo "$NEW_SHA" > "$LAST_SHA" 2>/dev/null || true
  fi
fi
if [ "$NEED_RESTART" = "1" ]; then
  if [ -n "$RESTART_CMD" ]; then
    # DEPLOY_RESTART_CMD 由用户显式配置（如 pm2 restart <app>），以正确用户/cwd 拉起新 server.js，最可靠。
    echo "[deploy] server.js changed -> scheduling restart: $RESTART_CMD"
    setsid bash -c "sleep 3; ${RESTART_CMD}" </dev/null >/dev/null 2>&1 &
    echo "[deploy] restart scheduled (deferred 3s, detached)"
  else
    # ⚠️ 不提供 kill 网关触发宝塔自愈的自动重启：生产实测，宝塔对【外部 kill】走应急路径
    # （root + 错误 cwd 拉起 node server.js），会导致网关起不来/502 甚至卡死；仅【面板点重启】
    # 才用正确 www 上下文干净重启。故 server.js 变化的部署仍需手动在宝塔点「重启」网关。
    echo "[deploy] server.js changed 但未配置 DEPLOY_RESTART_CMD -> 需手动在宝塔点「重启」网关方可生效（kill 自动重启已废弃：不安全）"
  fi
else
  echo "[deploy] server.js 未变化，跳过网关重启"
fi

echo "[deploy] DONE head=$HEAD"
