import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  TMP_DIR,
  VERSION,
  PUBLIC_URL,
  MAX_UPLOAD_BYTES,
} from './config.js';
import * as store from './store.js';
import { activity } from './activity.js';
import { requireToken, actorOf } from './auth.js';

const router = express.Router();
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
});

function handle(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function decodeUploadName(name) {
  // busboy 以 latin1 解析文件名，这里还原成 UTF-8
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('\uFFFD') ? name : fixed;
  } catch {
    return name;
  }
}

function baseUrlOf(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

router.get('/health', (req, res) => {
  res.json({ ok: true, name: 'wharf', version: VERSION });
});

router.use(requireToken);

router.get('/state', handle(async (req, res) => {
  const stats = await store.vaultStats();
  res.json({
    ok: true,
    name: 'wharf',
    version: VERSION,
    baseUrl: baseUrlOf(req),
    zones: {
      drive: { ...stats.drive, label: '网盘' },
      workspace: { ...stats.workspace, label: '工作区' },
    },
    shared: stats.shared,
    diverged: stats.diverged,
    activity: activity.summary(),
  });
}));

router.get('/fs/list', handle(async (req, res) => {
  const zone = String(req.query.zone || 'drive');
  const rel = String(req.query.path || '');
  const entries = await store.listDir(zone, rel);
  res.json({ zone, path: store.normRel(rel), entries });
}));

router.get('/fs/search', handle(async (req, res) => {
  const zone = String(req.query.zone || 'drive');
  const rel = String(req.query.path || '');
  const query = String(req.query.q || '');
  const entries = await store.searchItems(zone, rel, query);
  res.json({ zone, path: store.normRel(rel), query, entries });
}));

router.get('/fs/stat', handle(async (req, res) => {
  const zone = String(req.query.zone || 'drive');
  res.json(await store.fileInfo(zone, String(req.query.path || '')));
}));

router.get('/fs/preview', handle(async (req, res) => {
  const zone = String(req.query.zone || 'drive');
  const rel = String(req.query.path || '');
  res.json(await store.previewFile(zone, rel));
}));

router.get('/fs/download', handle(async (req, res, next) => {
  const zone = String(req.query.zone || 'drive');
  const rel = String(req.query.path || '');
  const clean = store.normRel(rel);
  if (!clean) throw new store.Fail('需要文件路径', { code: 'EPATH' });
  const abs = store.absOf(zone, clean);
  const stat = await store.fileInfo(zone, clean);
  if (stat.type === 'dir') throw new store.Fail('文件夹无法直接下载', { code: 'EISDIR' });

  const inline = String(req.query.inline || '') === '1';
  await activity.record({
    actor: actorOf(req),
    action: inline ? 'read' : 'download',
    zone,
    items: [{ path: clean, zone, type: 'file' }],
    meta: { size: stat.size, inline },
  });

  const filename = path.basename(clean);
  if (inline) {
    res.set('Content-Type', mimeOf(filename));
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    return res.sendFile(abs);
  }
  res.download(abs, filename, (err) => {
    if (err && !res.headersSent) next(err);
  });
}));

router.post('/fs/upload', upload.array('files', 30), handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const dir = String(req.body.dir || '');
  const overwrite = String(req.body.overwrite || '') === 'true';
  const actor = actorOf(req);
  const batchId = `batch_${Math.random().toString(16).slice(2)}`;
  const files = req.files || [];
  if (files.length === 0) throw new store.Fail('没有收到文件');

  const results = [];
  const items = [];
  for (const file of files) {
    const name = decodeUploadName(file.originalname);
    try {
      const saved = await store.saveUpload({
        zone,
        dir,
        filename: name,
        tmpPath: file.path,
        overwrite,
      });
      results.push({ ok: true, ...saved });
      items.push({ path: saved.path, zone, type: 'file', note: `${formatBytes(saved.size)}` });
    } catch (err) {
      results.push({ ok: false, name, message: err.message });
      await fsp.unlink(file.path).catch(() => {});
    }
  }

  if (items.length) {
    await activity.record({
      actor,
      batchId,
      action: 'upload',
      zone,
      items,
      meta: { dir },
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/folder', handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const rel = String(req.body.path || '');
  const created = await store.createFolder(zone, rel);
  await activity.record({
    actor: actorOf(req),
    action: 'create_folder',
    zone,
    items: [{ path: created.path, zone, type: 'dir' }],
  });
  store.resetStatsCache();
  res.json(created);
}));

router.post('/fs/rename', handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const renamed = await store.renameItems(zone, items);
  if (renamed.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'rename',
      zone,
      items: renamed.map((r) => ({
        path: r.to,
        zone,
        type: 'file',
        from: r.from,
        to: r.to,
        note: r.mirror ? '两个视图一起改名' : '',
      })),
    });
    store.resetStatsCache();
  }
  res.json({ renamed });
}));

router.post('/fs/delete', handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const purge = Boolean(req.body.purge);
  const results = await store.deleteItems(zone, paths, { purge });
  const done = results.filter((r) => r.ok);
  if (done.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'delete',
      zone,
      items: done.map((r) => ({
        path: r.path,
        zone,
        type: r.type,
        note: r.note,
      })),
      meta: { purge },
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/link', handle(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const results = [];
  for (const p of paths) {
    try {
      const linked = await store.linkInto('drive', p, 'workspace');
      results.push({ ok: true, ...linked });
    } catch (err) {
      results.push({ ok: false, path: p, message: err.message });
    }
  }
  const done = results.filter((r) => r.ok);
  if (done.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'link',
      zone: 'workspace',
      items: done.map((r) => ({
        path: r.path,
        zone: 'workspace',
        type: r.type,
        note: r.mode === 'copied' ? '跨文件系统，已复制副本' : '与网盘共用同一份数据',
      })),
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/publish', handle(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const results = [];
  for (const p of paths) {
    try {
      const linked = await store.linkInto('workspace', p, 'drive');
      results.push({ ok: true, ...linked });
    } catch (err) {
      results.push({ ok: false, path: p, message: err.message });
    }
  }
  const done = results.filter((r) => r.ok);
  if (done.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'publish',
      zone: 'drive',
      items: done.map((r) => ({
        path: r.path,
        zone: 'drive',
        type: r.type,
        note: r.mode === 'copied' ? '跨文件系统，已复制副本' : '与工作区共用同一份数据',
      })),
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/release', handle(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const results = [];
  for (const p of paths) {
    try {
      const out = await store.releasePath('workspace', p);
      results.push({ ok: true, ...out });
    } catch (err) {
      results.push({ ok: false, path: p, message: err.message });
    }
  }
  const done = results.filter((r) => r.ok);
  if (done.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'release',
      zone: 'drive',
      items: done.map((r) => ({
        path: r.path,
        zone: 'drive',
        type: r.type,
        note: r.mode === 'moved' ? '文件内容已移入网盘' : '只关闭了工作区视图',
      })),
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/sync', handle(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  const results = [];
  for (const p of paths) {
    try {
      const out = await store.syncPath('workspace', p);
      results.push({ ok: true, ...out });
    } catch (err) {
      results.push({ ok: false, path: p, message: err.message });
    }
  }
  const done = results.filter((r) => r.ok);
  if (done.length) {
    await activity.record({
      actor: actorOf(req),
      action: 'sync',
      zone: 'workspace',
      items: done.map((r) => ({ path: r.path, zone: 'workspace', type: r.type, note: '已恢复为同一份数据' })),
    });
    store.resetStatsCache();
  }
  res.json({ results });
}));

router.post('/fs/copy', handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const copied = await store.copyItem(zone, String(req.body.from || ''), String(req.body.to || ''));
  await activity.record({
    actor: actorOf(req),
    action: 'copy',
    zone,
    items: [{ path: copied.path, zone, type: copied.type, note: `源：${req.body.from}` }],
  });
  store.resetStatsCache();
  res.json(copied);
}));

router.post('/fs/import', handle(async (req, res) => {
  const zone = String(req.body.zone || 'drive');
  const dir = String(req.body.dir || '');
  const saved = await store.importUrl(String(req.body.url || ''), {
    dir,
    zone,
    filename: req.body.filename ? String(req.body.filename) : undefined,
  });
  await activity.record({
    actor: actorOf(req),
    action: 'import',
    zone,
    items: [{ path: saved.path, zone, type: 'file', note: formatBytes(saved.size) }],
  });
  store.resetStatsCache();
  res.json(saved);
}));

router.get('/activity', handle(async (req, res) => {
  const events = activity.list({
    limit: Number(req.query.limit || 120),
    actor: String(req.query.actor || ''),
    since: Number(req.query.since || 0),
    zone: String(req.query.zone || ''),
  });
  res.json({ events, summary: activity.summary() });
}));

router.get('/activity/summary', (req, res) => {
  res.json(activity.summary());
});

router.get('/activity/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const unsubscribe = activity.subscribe(send);
  const timer = setInterval(() => res.write(`: ping\n\n`), 25000);

  req.on('close', () => {
    clearInterval(timer);
    unsubscribe();
  });
});

router.use((err, req, res, next) => {
  if (err instanceof store.Fail) {
    return res.status(err.status).json({ error: err.message, code: err.code, hint: err.hint });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件超过上传上限', code: 'ETOOBIG' });
  }
  if (err && err.name === 'MulterError') {
    return res.status(400).json({ error: `上传失败：${err.message}`, code: err.code });
  }
  console.error('[api]', err);
  res.status(500).json({ error: '服务器内部错误', code: 'EINTERNAL' });
});

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

export default router;
