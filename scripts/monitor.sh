#!/usr/bin/env bash
# cloudflarepool 健康监控（数据湖 + 网关 + D1 用量）
#
# 用法:  ./scripts/monitor.sh
# 建议:  每日 cron 或接入 WorkBuddy 定时任务；异常时关注非 200 / D1 用量接近配额。
set -uo pipefail
cd "$(dirname "$0")/.."

echo "== 时间: $(date '+%F %T %Z') =="

echo "-- 数据湖 /health --"
curl -sS --max-time 10 https://data.kapibala.icu/health && echo || echo "❌ 数据湖不可达"

echo
echo "-- 网关 /api/health --"
curl -sS --max-time 10 https://home.inkspcl.com/api/health && echo || echo "❌ 网关不可达"

echo
echo "-- 管理后台首页 --"
code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://home.inkspcl.com/admin/)
echo "HTTP $code $([ "$code" = 200 ] && echo ✅ || echo ❌)"

echo
echo "-- D1 用量 --"
npx wrangler d1 info cloudflarepool 2>/dev/null | grep -iE "size|rows|written|read|quota" | head -8 || echo "（wrangler 需本地 OAuth 登录）"
