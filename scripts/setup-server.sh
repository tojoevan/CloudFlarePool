#!/usr/bin/env bash
# 一次性服务器初始化（让「一键部署」按钮真正可用）。
#
# 前置：服务器已装 node >=18 与 git，且能访问 GitHub 与 Cloudflare。
# 用法（二选一）：
#   CF_API_TOKEN=xxxx ./scripts/setup-server.sh
#   export CF_API_TOKEN=xxxx; ./scripts/setup-server.sh
#
# 它会：克隆 cloudflarepool 仓库 → 安装 wrangler → 把 CF_API_TOKEN 与部署路径
# 写入网关 .env（仅服务端，gitignore 已忽略 .env）。完成后**请在宝塔重启网关**
# 以加载新的 /api/t4data/deploy 路由；之后点击「版本更新」即可一键部署。
set -euo pipefail

CLONE_URL="${CLONE_URL:-https://github.com/YOUR_GITHUB/cloudflarepool.git}"
REPO_DIR="${DEPLOY_REPO_DIR:-/opt/cloudflarepool}"
WEB_ROOT="${DEPLOY_WEB_ROOT:-/www/wwwroot/home.inkspcl.com}"
CF_TOKEN="${CF_API_TOKEN:-}"

if [ -z "$CF_TOKEN" ]; then
  echo "✗ 缺少 CF_API_TOKEN。请：CF_API_TOKEN=xxx $0" >&2
  exit 1
fi

echo "[setup] 检查基础依赖..."
command -v git >/dev/null 2>&1 || { echo "✗ 未安装 git，请先安装"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ 未安装 node(>=18)，请先安装"; exit 1; }
if ! command -v wrangler >/dev/null 2>&1; then
  echo "[setup] 安装 wrangler（全局）..."
  npm install -g wrangler
fi

echo "[setup] 克隆/更新仓库 -> $REPO_DIR"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "$CLONE_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git checkout main
git pull --ff-only origin main

# 运行中的网关从 WEB_ROOT 启动并读取 WEB_ROOT/.env（宝塔入口指向此处）。
# 部署按钮 spawn 的脚本继承网关进程环境，故 CF_API_TOKEN 等必须写入 WEB_ROOT/.env
# 才能被继承；克隆目录的 .env 同步一份，供未来直接从仓库目录运行网关的场景。
ENV_FILE="$WEB_ROOT/.env"
touch "$ENV_FILE"
if [ ! -f "$REPO_DIR/gateway/.env" ]; then
  touch "$REPO_DIR/gateway/.env"
fi

set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # 值可能含特殊字符，用整行替换（兼容 / 与 base64url）
    local escaped
    escaped=$(printf '%s' "$val" | sed -e 's/[&/]/\\&/g')
    sed -i "s#^${key}=.*#${key}=${escaped}#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

echo "[setup] 写入部署相关环境变量到网关 .env（WEB_ROOT 与仓库目录各一份）"
for f in "$ENV_FILE" "$REPO_DIR/gateway/.env"; do
  ENV_FILE="$f" set_env "CF_API_TOKEN" "$CF_TOKEN"
  ENV_FILE="$f" set_env "DEPLOY_REPO_DIR" "$REPO_DIR"
  ENV_FILE="$f" set_env "DEPLOY_WEB_ROOT" "$WEB_ROOT"
done
# DEPLOY_SCRIPT 默认指向仓库内的 scripts/deploy.sh，无需显式设置；
# 若需部署后自动重启网关（server.js 变更时），在 WEB_ROOT/.env 配置重启命令，例如：
#   DEPLOY_RESTART_CMD="pm2 restart home-inkspcl"
# 默认留空 = 不自动重启（routine 部署无需重启）。

echo "[setup] 完成。"
echo "[setup] 下一步：在宝塔面板重启网关（加载 /api/t4data/deploy 路由）。"
echo "[setup] 之后管理后台「版本更新」按钮即可一键部署（数据湖 + SPA，无需重启）。"
