import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { VERSION, WORKSPACE_DIR } from './config.js';
import * as store from './store.js';
import { activity } from './activity.js';
import { TOOL_DEFS, runTool } from './tools.js';

const AGENT_NAME = 'wharf-workspace';
const AGENT_INFO = {
  name: AGENT_NAME,
  title: 'Wharf 工作区文件代理',
  description: '面向 AI 的工作区文件提供方：可读取/写入工作区文本文件，执行批量重命名、批量删除、发布与退回网盘等操作。',
  capabilities: { tools: TOOL_DEFS.map((tool) => tool.name) },
};

/* ------------------------------------------------------------------ */
/* ACP (Agent Client Protocol) fs/* —— JSON-RPC over HTTP             */
/* ------------------------------------------------------------------ */

function acpRel(p) {
  if (typeof p !== 'string' || !p.trim()) throw new store.Fail('缺少 path', { code: 'EPATH' });
  let value = p.replace(/\\/g, '/').trim();
  const base = WORKSPACE_DIR.replace(/\\/g, '/');
  if (value === base) value = '';
  else if (value.startsWith(`${base}/`)) value = value.slice(base.length + 1);
  value = value.replace(/^\/+/, '');
  return store.normRel(value);
}

function textOfFile(result, line, limit) {
  let text = result.content;
  if (line || limit) {
    const lines = text.split('\n');
    const start = Math.max(0, Number(line || 1) - 1);
    const end = limit ? start + Number(limit) : lines.length;
    text = lines.slice(start, end).join('\n');
  }
  return text;
}

async function acpDispatch(method, params, req) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          loadSession: false,
        },
        serverInfo: { name: 'wharf', title: 'Wharf 工作区', version: VERSION },
        authMethods: ['bearer'],
      };

    case 'fs/read_text_file': {
      const rel = acpRel(params.path);
      const result = await store.readText('workspace', rel);
      await activity.record({
        actor: 'ai',
        action: 'read',
        zone: 'workspace',
        items: [{ path: rel, zone: 'workspace', type: 'file' }],
        meta: { source: 'acp' },
      });
      return { content: textOfFile(result, params.line, params.limit) };
    }

    case 'fs/write_text_file': {
      const rel = acpRel(params.path);
      const written = await store.writeText(rel, params.content ?? '');
      await activity.record({
        actor: 'ai',
        action: 'write',
        zone: 'workspace',
        items: [{
          path: rel,
          zone: 'workspace',
          type: 'file',
          note: written.state === 'shared' ? '网盘视图同步变更（同一物理文件）' : '',
        }],
        meta: { source: 'acp' },
      });
      store.resetStatsCache();
      return null;
    }

    case 'fs/list_directory': {
      const rel = acpRel(params.path);
      const entries = await store.listDir('workspace', rel);
      return { entries };
    }

    case 'fs/stat_item': {
      const rel = acpRel(params.path);
      return await store.fileInfo('workspace', rel);
    }

    case 'fs/search': {
      const rel = acpRel(params.path || '');
      const entries = await store.searchItems('workspace', rel, params.query || '');
      return { entries };
    }

    case 'fs/create_folder': {
      const rel = acpRel(params.path);
      const created = await store.createFolder('workspace', rel);
      await activity.record({
        actor: 'ai',
        action: 'create_folder',
        zone: 'workspace',
        items: [{ path: created.path, zone: 'workspace', type: 'dir' }],
        meta: { source: 'acp' },
      });
      store.resetStatsCache();
      return created;
    }

    case 'fs/rename_items': {
      const items = (params.items || []).map((item) => ({
        from: acpRel(item.from),
        to: acpRel(item.to),
      }));
      const renamed = await store.renameItems('workspace', items);
      if (renamed.length) {
        await activity.record({
          actor: 'ai',
          action: 'rename',
          zone: 'workspace',
          items: renamed.map((r) => ({ path: r.to, zone: 'workspace', type: 'file', from: r.from, to: r.to, note: '两个视图一起改名' })),
          meta: { source: 'acp' },
        });
        store.resetStatsCache();
      }
      return { renamed };
    }

    case 'fs/delete_items': {
      const paths = (params.paths || []).map((p) => acpRel(p));
      const results = await store.deleteItems('workspace', paths, { purge: Boolean(params.purge) });
      const done = results.filter((r) => r.ok);
      if (done.length) {
        await activity.record({
          actor: 'ai',
          action: 'delete',
          zone: 'workspace',
          items: done.map((r) => ({ path: r.path, zone: 'workspace', type: r.type, note: r.note })),
          meta: { source: 'acp', purge: Boolean(params.purge) },
        });
        store.resetStatsCache();
      }
      return { results };
    }

    case 'fs/move_to_workspace': {
      const paths = (params.paths || []).map((p) => store.normRel(p));
      const results = [];
      for (const p of paths) {
        results.push({ path: p, ...(await store.linkInto('drive', p, 'workspace')) });
      }
      if (results.length) {
        await activity.record({
          actor: 'ai',
          action: 'link',
          zone: 'workspace',
          items: results.map((r) => ({ path: r.path, zone: 'workspace', type: r.type, note: '与网盘共用同一份数据' })),
          meta: { source: 'acp' },
        });
        store.resetStatsCache();
      }
      return { results };
    }

    case 'fs/publish_to_drive':
    case 'fs/sync_to_drive':
    case 'fs/release_to_drive': {
      const action = method.includes('publish') ? 'publish' : method.includes('sync') ? 'sync' : 'release';
      const paths = (params.paths || []).map((p) => acpRel(p));
      const results = [];
      for (const p of paths) {
        if (action === 'publish') results.push({ path: p, ...(await store.linkInto('workspace', p, 'drive')) });
        if (action === 'sync') results.push({ path: p, ...(await store.syncPath('workspace', p)) });
        if (action === 'release') results.push({ path: p, ...(await store.releasePath('workspace', p)) });
      }
      if (results.length) {
        const zone = action === 'release' ? 'drive' : 'workspace';
        await activity.record({
          actor: 'ai',
          action,
          zone,
          items: results.map((r) => ({ path: r.path, zone, type: r.type })),
          meta: { source: 'acp' },
        });
        store.resetStatsCache();
      }
      return { results };
    }

    default:
      throw { rpcCode: -32601, message: `不支持的 ACP 方法：${method}` };
  }
}

export async function handleAcpRpc(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无法解析 JSON-RPC 请求' } });
  }
  if (body.method && body.method.startsWith('notifications/')) return res.status(202).end();

  try {
    const result = await acpDispatch(body.method, body.params || {}, req);
    if (body.id === undefined) return res.status(202).end();
    res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (err) {
    if (err && err.rpcCode) {
      return res.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: err.rpcCode, message: err.message } });
    }
    const status = err instanceof store.Fail ? err.status : 500;
    res.json({
      jsonrpc: '2.0',
      id: body.id ?? null,
      error: { code: err.code || -32603, message: err.message, data: { hint: err.hint || '', status } },
    });
  }
}

/* ------------------------------------------------------------------ */
/* ACP REST（Agent Communication Protocol 风格：agents / runs）        */
/* ------------------------------------------------------------------ */

const runs = new Map();
const MAX_RUNS = 200;

function makeRunId() {
  return `run_${crypto.randomBytes(8).toString('hex')}`;
}

function parseRunInput(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new store.Fail('字符串输入必须是 JSON，例如 {"tool":"list_items","args":{}}', { code: 'EINPUT' });
    }
  }
  if (!value || typeof value !== 'object') {
    throw new store.Fail('缺少输入：{"tool":"...","args":{...}}', { code: 'EINPUT' });
  }
  const call = value.tool_call || value;
  const name = call.tool || call.name;
  const args = call.args || call.arguments || {};
  if (!name) throw new store.Fail('输入缺少 tool 名称', { code: 'EINPUT' });
  return { name, args };
}

const acpRouter = express.Router();

acpRouter.get('/', (req, res) => {
  res.json({
    protocol: 'acp',
    transports: ['json-rpc', 'rest'],
    agent: AGENT_INFO,
    endpoints: {
      jsonrpc: '/acp',
      agents: '/acp/agents',
      runs: '/acp/agents/wharf-workspace/runs',
    },
  });
});

acpRouter.post('/', handleAcpRpc);

acpRouter.get('/agents', (req, res) => {
  res.json({ agents: [{ ...AGENT_INFO, status: 'ready' }] });
});

acpRouter.get('/agents/:name', (req, res) => {
  if (req.params.name !== AGENT_NAME) {
    return res.status(404).json({ error: 'agent 不存在', code: 'EAGENT' });
  }
  res.json({ ...AGENT_INFO, status: 'ready' });
});

acpRouter.post('/agents/:name/runs', async (req, res, next) => {
  try {
    if (req.params.name !== AGENT_NAME) {
      return res.status(404).json({ error: 'agent 不存在', code: 'EAGENT' });
    }
    const { name, args } = parseRunInput(req.body?.input ?? req.body?.tool ?? req.body);
    const id = makeRunId();
    const run = {
      id,
      object: 'run',
      agent_name: AGENT_NAME,
      status: 'in_progress',
      created_at: new Date().toISOString(),
      finished_at: null,
      input: { tool: name, args },
      output: null,
    };
    runs.set(id, run);

    try {
      const result = await runTool(name, args, {
        actor: 'ai',
        batchId: `acp_${crypto.randomBytes(6).toString('hex')}`,
        origin: `${req.protocol}://${req.get('host')}`,
      });
      run.status = 'completed';
      run.output = { tool: name, content: [{ type: 'text', text: result.text }] };
    } catch (err) {
      run.status = 'failed';
      run.output = { tool: name, error: err.message, hint: err.hint || '' };
    }
    run.finished_at = new Date().toISOString();

    while (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next().value;
      runs.delete(oldest);
    }
    res.status(201).json(run);
  } catch (err) {
    next(err);
  }
});

acpRouter.get('/runs', (req, res) => {
  const limit = Math.min(100, Number(req.query.limit || 30));
  res.json({ runs: Array.from(runs.values()).slice(-limit).reverse() });
});

acpRouter.get('/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'run 不存在', code: 'ERUN' });
  res.json(run);
});

acpRouter.use((err, req, res, next) => {
  if (err instanceof store.Fail) {
    return res.status(err.status).json({ error: err.message, code: err.code, hint: err.hint });
  }
  console.error('[acp]', err);
  res.status(500).json({ error: '服务器内部错误', code: 'EINTERNAL' });
});

export { acpRouter };
export const ACP_INFO = { agent: AGENT_INFO, workspaceDir: path.basename(WORKSPACE_DIR) };
