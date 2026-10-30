import express from 'express';
import path from 'node:path';
import {
  PORT,
  AUTH_TOKEN,
  DATA_DIR,
  PUBLIC_DIR,
  PUBLIC_URL,
  DRIVE_DIR,
  WORKSPACE_DIR,
  VERSION,
} from './config.js';
import apiRouter from './api.js';
import { handleMcp, mcpInfo } from './mcp.js';
import { acpRouter } from './acp.js';
import { cors, requireToken } from './auth.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

const jsonBody = express.json({ limit: '8mb' });

app.use('/api', cors, jsonBody, apiRouter);

app.route('/mcp')
  .options(cors, (req, res) => res.status(204).end())
  .get(cors, mcpInfo)
  .post(cors, jsonBody, requireToken, handleMcp);

app.use('/acp', cors, jsonBody, requireToken, acpRouter);

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path.startsWith('/acp')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON 解析失败', code: 'EJSON' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大', code: 'ETOOBIG' });
  }
  console.error('[wharf]', err);
  res.status(500).json({ error: '服务器内部错误', code: 'EINTERNAL' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log(`  Wharf ${VERSION} 已启动`);
  console.log(`  网盘目录    : ${DRIVE_DIR}`);
  console.log(`  工作区目录  : ${WORKSPACE_DIR}`);
  console.log(`  数据目录    : ${DATA_DIR}`);
  const openUrl = `${PUBLIC_URL || `http://localhost:${PORT}`}/?token=${AUTH_TOKEN}`;
  console.log(`  Web 界面    : ${PUBLIC_URL || `http://localhost:${PORT}`}`);
  console.log(`  带令牌入口  : ${openUrl}`);
  console.log(`  MCP 端点    : http://<host>:${PORT}/mcp`);
  console.log(`  ACP 端点    : http://<host>:${PORT}/acp  (JSON-RPC 与 REST)`);
  if (PUBLIC_URL) console.log(`  对外地址    : ${PUBLIC_URL}`);
  console.log(`  访问令牌    : ${AUTH_TOKEN}`);
  console.log('');
});
