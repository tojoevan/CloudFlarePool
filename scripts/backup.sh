#!/usr/bin/env bash
# cloudflarepool 数据湖备份脚本（生产 D1）
#
# 用法:  ./scripts/backup.sh [--keep N]      # N=保留份数，默认 5
# 产出:  backups/<ts>-restore-points.txt  当前可用的 Time Travel 恢复点（自动备份书签）
#        backups/<ts>-full.sql            schema + data 全量导出（主要备份产物）
#        backups/<ts>-schema.sql          仅 schema（便于 diff / 重建）
#
# 恢复:
#   1) SQL 全量导入（重建表+数据，最快）:
#        npx wrangler d1 execute cloudflarepool --remote --file=backups/<ts>-full.sql
#   2) Time Travel 按书签回滚（见 restore-points.txt 内给出的命令）:
#        npx wrangler d1 time-travel restore cloudflarepool --bookmark=<bookmark> --remote
#
# 说明: backups/ 目录已被 .gitignore 忽略（含真实数据，勿入库）。
set -euo pipefail
cd "$(dirname "$0")/.."

DB=cloudflarepool
KEEP=5
if [ "${1:-}" = "--keep" ]; then KEEP="${2:-5}"; fi
TS=$(date +%Y%m%d-%H%M%S)
OUT=backups
mkdir -p "$OUT"

echo "==> [$TS] 1/3 读取 Time Travel 恢复点 (自动书签)..."
npx wrangler d1 time-travel info "$DB" 2>&1 | tee "$OUT/$TS-restore-points.txt" || true

echo "==> [$TS] 2/3 全量导出 (schema + data)..."
npx wrangler d1 export "$DB" --remote --output="$OUT/$TS-full.sql" --skip-confirmation

echo "==> [$TS] 3/3 schema-only 导出..."
npx wrangler d1 export "$DB" --remote --output="$OUT/$TS-schema.sql" --no-data --skip-confirmation

echo "==> 清理：仅保留最近 $KEEP 份"
ls -1t "$OUT"/*-full.sql            2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$OUT"/*-schema.sql          2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$OUT"/*-restore-points.txt  2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "==> 完成。"
ls -lh "$OUT" | tail -n +2
