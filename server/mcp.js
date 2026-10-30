import crypto from 'node:crypto';
import { VERSION } from './config.js';
import { TOOL_DEFS, SERVER_INFO, runTool } from './tools.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function rpcId(id) {
  return id === undefined ? null : id;
}

function originOf(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function wantsSse(req) {
  return (req.get('accept') || '').includes('text/event-stream');
}

function respond(req, res, payload) {
  if (payload === null || payload === undefined) return res.status(202).end();
  res.set('MCP-Protocol-Version', PROTOCOL_VERSIONS[0]);
  if (!wantsSse(req)) {
    return res.status(200).json(payload);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id: rpcId(id), error: { code, message, ...(data ? { data } : {}) } };
}

async function dispatch(message, req) {
  const method = message.method;
  const params = message.params || {};

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          prompts: { listChanged: false },
        },
        serverInfo: { ...SERVER_INFO, title: 'Wharf AI 网盘工作区' },
        instructions: [
          '这是 Wharf：一个带“网盘”和“工作区”双视图的 AI 文件空间。',
          '网盘（zone=drive）只读，工作区（zone=workspace）可写。',
          '改写网盘文件：先 move_to_workspace，再在工作区用 write_file / rename_items 操作。',
          '完成后可 publish_to_drive（新文件发布）或 sync_to_drive（内容写回）。',
          'move_to_workspace 使用硬链接：两边各有一个条目，磁盘只有一份数据。',
          'delete_items 默认只删除当前视图，purge=true 才会彻底删除。',
        ].join('\n'),
      };
    }

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOL_DEFS };

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      if (!name) throw { rpcCode: -32602, message: '缺少工具名称' };
      const batchId = `mcp_${crypto.randomBytes(6).toString('hex')}`;
      try {
        const result = await runTool(name, args, {
          actor: 'ai',
          batchId,
          origin: originOf(req),
        });
        return { content: [{ type: 'text', text: result.text }] };
      } catch (err) {
        const text = err.hint ? `${err.message}\n提示：${err.hint}` : err.message;
        return {
          content: [{ type: 'text', text: `错误：${text}` }],
          isError: true,
        };
      }
    }

    case 'resources/list':
      return { resources: [] };

    case 'resources/templates/list':
      return { resourceTemplates: [] };

    case 'prompts/list':
      return { prompts: [] };

    case 'completion/complete':
      return { completion: { values: [], total: 0, hasMore: false } };

    default:
      throw { rpcCode: -32601, message: `不支持的方法：${method}` };
  }
}

export async function handleMcp(req, res) {
  const body = req.body;
  if (!body) {
    return res.status(400).json(rpcError(null, -32700, '无法解析 JSON-RPC 请求'));
  }

  const messages = Array.isArray(body) ? body : [body];
  const replies = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object' || typeof message.method !== 'string') {
      replies.push(rpcError(message?.id, -32600, '无效的 JSON-RPC 请求'));
      continue;
    }
    if (message.method.startsWith('notifications/')) continue;

    try {
      const result = await dispatch(message, req);
      if (message.id === undefined) continue;
      replies.push({ jsonrpc: '2.0', id: message.id, result });
    } catch (err) {
      if (err && err.rpcCode) {
        replies.push(rpcError(message.id, err.rpcCode, err.message));
      } else {
        console.error('[mcp]', err);
        replies.push(rpcError(message.id, -32603, err?.message || '内部错误'));
      }
    }
  }

  if (replies.length === 0) return res.status(202).end();
  respond(req, res, Array.isArray(body) ? replies : replies[0]);
}

export function mcpInfo(req, res) {
  res.status(405).json({
    error: 'MCP 端点仅支持 POST（Streamable HTTP）',
    endpoint: '/mcp',
    server: SERVER_INFO,
    tools: TOOL_DEFS.map((t) => t.name),
    version: VERSION,
  });
}
