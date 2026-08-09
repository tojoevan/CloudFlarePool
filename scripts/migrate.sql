-- 迁移租户 slug：jiashiben -> weijiashi（微家事）
-- 运行前请先执行 check.sql 确认现状（避免重复执行 / 误覆盖已有 weijiashi 行）
-- 幂等：仅当 jiashiben 行存在时生效，重复运行无害

-- 1) 租户元数据：改名 + 绑定真实 AppID
--    注意：appid 为微信后台真实 AppID，请先把下方占位符替换为你的真实值，或删除此列仅迁移 slug
UPDATE tenants
   SET tenant_id = 'weijiashi',
       appid     = 'REPLACE_WITH_YOUR_APPID',
       name      = '微家事'
 WHERE tenant_id = 'jiashiben';

-- 2) 业务表租户归属一并迁移（防止历史数据孤儿化、App 读到空）
UPDATE todos         SET tenant_id = 'weijiashi' WHERE tenant_id = 'jiashiben';
UPDATE tasks_doc     SET tenant_id = 'weijiashi' WHERE tenant_id = 'jiashiben';
UPDATE archive_items SET tenant_id = 'weijiashi' WHERE tenant_id = 'jiashiben';
