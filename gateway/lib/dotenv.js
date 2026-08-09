// 极简 .env 加载器（零依赖）：仅填充尚未存在的环境变量。
// 生产环境可由宝塔 / 系统直接注入环境变量，是否读取 .env 都不影响运行。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function loadDotEnv(path) {
  const envPath = path || join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return; // 没有 .env 文件就跳过
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
