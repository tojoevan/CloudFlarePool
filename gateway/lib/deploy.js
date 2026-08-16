// 异步部署任务管理器（网关侧）。
//
// 部署（数据湖 wrangler + SPA 同步）可能耗时数十秒，故采用异步模型：
//   - startDeploy() 立即 spawn 部署脚本并返回 taskId（202 Accepted）
//   - 前端轮询 getDeployStatus(taskId) 获取实时日志与最终状态
// 任务状态存于进程内存 Map；网关重启后历史任务丢失（前端据此把 404 视为未知/失败），
// 对 MVP 可接受（部署本身是幂等的，失败可重触发）。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const tasks = new Map();
const MAX_LOG = 500;

function appendLog(task, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) task.log.push(t);
  }
  if (task.log.length > MAX_LOG) task.log.splice(0, task.log.length - MAX_LOG);
}

// 启动一次部署。script 为 bash 部署脚本的绝对路径；env 追加到子进程环境。
// 返回 { id, status, startedAt }。
export function startDeploy({ script, env = {}, adminId = null } = {}) {
  const id = randomUUID();
  const task = {
    id,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    adminId,
    log: [],
  };
  tasks.set(id, task);

  appendLog(task, `[deploy] start script=${script} admin=${adminId || '?'}`);
  const child = spawn('bash', [script], {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => appendLog(task, d));
  child.stderr.on('data', (d) => appendLog(task, d));

  child.on('error', (e) => {
    task.status = 'failed';
    task.finishedAt = Date.now();
    task.exitCode = -1;
    appendLog(task, `[deploy] spawn error: ${e.message}`);
  });

  child.on('close', (code) => {
    task.exitCode = code;
    task.status = code === 0 ? 'success' : 'failed';
    task.finishedAt = Date.now();
    appendLog(task, `[deploy] exit code ${code}`);
  });

  return { id: task.id, status: task.status, startedAt: task.startedAt };
}

// 返回任务状态快照；未知 id 返回 null（前端据此判断任务已不可见）。
export function getDeployStatus(id) {
  const t = tasks.get(id);
  if (!t) return null;
  return {
    id: t.id,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    exitCode: t.exitCode,
    log: t.log.slice(-60),
  };
}
