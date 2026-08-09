-- 迁移前 / 迁移后检查租户现状
SELECT tenant_id, appid, name FROM tenants;

-- 各表按租户统计行数，确认数据已跟随迁移（期望：jiashiben=0，weijiashi 有数据）
SELECT 'tenants'        AS tbl, tenant_id, COUNT(*) AS n FROM tenants        GROUP BY tenant_id
UNION ALL
SELECT 'todos'          AS tbl, tenant_id, COUNT(*) AS n FROM todos          GROUP BY tenant_id
UNION ALL
SELECT 'tasks_doc'      AS tbl, tenant_id, COUNT(*) AS n FROM tasks_doc      GROUP BY tenant_id
UNION ALL
SELECT 'archive_items'  AS tbl, tenant_id, COUNT(*) AS n FROM archive_items  GROUP BY tenant_id;
