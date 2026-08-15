-- 把演示待办 t1 转移给「当前微信用户」。
-- 原理：先在你手机上用修复后的「新建待办」创建任意一条真实待办，
-- 该待办会以你的真实 openid 写入 D1；本脚本再把 t1 的 owner 改成同一个 openid。
--
-- 运行（在 cloudflarepool 目录）：
--   wrangler d1 execute cloudflarepool --remote --file=scripts/reassign_demo.sql
--
-- 安全：仅当已存在非 u_demo 的真实待办时才执行 UPDATE（EXISTS 守卫）。

UPDATE todos
SET owner_openid = (
  SELECT owner_openid FROM todos
  WHERE id != 't1' AND owner_openid != 'u_demo'
  ORDER BY updated_at DESC LIMIT 1
)
WHERE id = 't1'
  AND EXISTS (
    SELECT 1 FROM todos
    WHERE id != 't1' AND owner_openid != 'u_demo'
  );
