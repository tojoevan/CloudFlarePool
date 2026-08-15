#!/usr/bin/env node
// Minimal, zero-dependency MCP server (stdio transport, JSON-RPC 2.0) that
// exposes the 微家事 (weijiashi) data lake to any MCP client (Claude Desktop,
// WorkBuddy, etc.) using a T3 service token.
//
// Tools:
//   list_todos    GET /t/<tenant>/todos        (data:read)
//   add_task      POST /t/<tenant>/todos       (data:write)
//   search_archive GET /t/<tenant>/archive      (data:read)
//
// Run:  node server.js   (after filling .env from .env.example)
//
// The data lake domain (data.kapibala.icu) is NOT ICP-filed, so this server
// is meant for integration / overseas clients, per the platform design (§12).

import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataLakeClient } from './lib/datalake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = { ...process.env };
  const file = path.join(__dirname, '.env');
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in env)) env[k] = v;
    }
  }
  return env;
}

const env = loadEnv();
const cfg = {
  dataLakeUrl: env.WEIJIASHI_DATA_LAKE_URL || 'https://data.kapibala.icu',
  apiKeyId: env.WEIJIASHI_API_KEY_ID,
  apiKeySecret: env.WEIJIASHI_API_KEY_SECRET,
  apiKeyKid: env.WEIJIASHI_API_KEY_KID,
  tenantId: env.WEIJIASHI_TENANT_ID || 'weijiashi',
  appId: env.WEIJIASHI_APP_ID || 'jiashiben',
};

function die(msg) {
  process.stderr.write(`[mcp] ${msg}\n`);
  process.exit(1);
}
if (!cfg.apiKeyId || !cfg.apiKeySecret || !cfg.apiKeyKid) {
  die('missing WEIJIASHI_API_KEY_ID / _SECRET / _KID — copy .env.example to .env');
}

const client = createDataLakeClient(cfg);

const TOOLS = [
  {
    name: 'list_todos',
    description:
      '列出「微家事」租户下的待办事项。ownerAll=true 时返回该租户全部成员的待办（家庭视角），否则仅返回集成身份自身创建的待办。',
    inputSchema: {
      type: 'object',
      properties: {
        ownerAll: {
          type: 'boolean',
          description: 'true=返回租户内全部待办（家庭共享视角），false=仅集成身份自身。默认 true。',
          default: true,
        },
      },
    },
  },
  {
    name: 'add_task',
    description:
      '在「微家事」租户下新增一条待办/任务。owner 可指定归属的家庭成员 openid；留空则归到 AI 集成身份。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '待办标题（必填）' },
        tag: { type: 'string', description: '可选标签' },
        owner: { type: 'string', description: '归属家庭成员的 openid（可选）' },
        shared: { type: 'boolean', description: '是否标记为家庭共享，默认 false' },
      },
      required: ['title'],
    },
  },
  {
    name: 'search_archive',
    description:
      '在「微家事」归档库中按关键词检索（标题/类型/内容全文匹配）。ownerAll=true 时跨全租户检索。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '检索关键词（可选；留空返回全部归档）' },
        ownerAll: { type: 'boolean', description: 'true=跨全租户检索，默认 true', default: true },
      },
    },
  },
];

function json(text) {
  return [{ type: 'text', text }];
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_todos': {
      const r = await client.listTodos(args);
      return { content: json(JSON.stringify(r, null, 2)) };
    }
    case 'add_task': {
      const r = await client.addTask(args);
      return { content: json(JSON.stringify(r, null, 2)) };
    }
    case 'search_archive': {
      const r = await client.searchArchive(args);
      return { content: json(JSON.stringify(r, null, 2)) };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(msg) {
  const id = msg.id;
  try {
    switch (msg.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'weijiashi-mcp', version: '0.1.0' },
          },
        };
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'tools/call': {
        const { name, arguments: a } = msg.params || {};
        const result = await callTool(name, a || {});
        return { jsonrpc: '2.0', id, result };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${msg.method}` } };
    }
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  const res = await handle(msg);
  if (res) process.stdout.write(JSON.stringify(res) + '\n');
});

process.stderr.write('[mcp] weijiashi-mcp stdio server started\n');
