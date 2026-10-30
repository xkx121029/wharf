import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EVENTS_FILE } from './config.js';

const MAX_MEMORY = 2500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const ACTOR_LABELS = { ai: 'AI', ui: '我', api: '接口', system: '系统' };

function nameOf(items) {
  if (!items || items.length === 0) return '';
  const first = items[0];
  const name = first.name || (first.path ? first.path.split('/').pop() : '');
  return name;
}

function buildTitle(action, items = [], meta = {}) {
  const n = items.length;
  const single = n === 1;
  const name = nameOf(items);
  switch (action) {
    case 'upload':
      return single ? `上传了「${name}」` : `上传了 ${n} 个文件`;
    case 'download':
      return single ? `下载了「${name}」` : `下载了 ${n} 个文件`;
    case 'read':
      return single ? `读取了「${name}」` : `读取了 ${n} 个文件`;
    case 'write':
      return `写入了「${name}」`;
    case 'create_folder':
      return single ? `新建了文件夹「${name}」` : `新建了 ${n} 个文件夹`;
    case 'link':
      return single ? `把「${name}」移到工作区` : `把 ${n} 个文件移到工作区`;
    case 'publish':
      return single ? `把「${name}」发布到网盘` : `把 ${n} 个文件发布到网盘`;
    case 'release':
      return single ? `把「${name}」退回网盘` : `把 ${n} 个文件退回网盘`;
    case 'sync':
      return single ? `把「${name}」写回网盘` : `把 ${n} 个文件写回网盘`;
    case 'rename': {
      if (single) {
        const from = items[0].from || items[0].path;
        const to = items[0].to || items[0].path;
        return `把「${from.split('/').pop()}」改名为「${to.split('/').pop()}」`;
      }
      return `重命名了 ${n} 个条目`;
    }
    case 'delete':
      return single ? `删除了「${name}」` : `删除了 ${n} 个条目`;
    case 'copy':
      return single ? `复制了「${name.split('/').pop() || name}」` : `复制了 ${n} 个条目`;
    case 'import':
      return single ? `从链接保存了「${name}」` : `从链接保存了 ${n} 个文件`;
    case 'search':
      return `搜索了「${meta.query || ''}」`;
    default:
      return meta.title || action;
  }
}

class ActivityFeed {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-MAX_MEMORY);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 跳过损坏的行 */
        }
      }
      this.events = events;
    } catch {
      this.events = [];
    }
  }

  rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_FILE_BYTES) {
        fs.renameSync(this.file, this.file.replace(/\.jsonl$/, '.1.jsonl'));
        this.events = this.events.slice(-500);
      }
    } catch {
      /* ignore */
    }
  }

  record(entry = {}) {
    const items = Array.isArray(entry.items)
      ? entry.items.map((item) => ({
          path: item.path || '',
          zone: item.zone || entry.zone || 'drive',
          type: item.type || 'file',
          from: item.from || undefined,
          to: item.to || undefined,
          note: item.note || '',
        }))
      : [];

    const base = {
      id: `ev_${crypto.randomBytes(8).toString('hex')}`,
      ts: entry.ts || Date.now(),
      actor: ACTOR_LABELS[entry.actor] ? entry.actor : 'api',
      batchId: entry.batchId || `batch_${crypto.randomBytes(6).toString('hex')}`,
      action: entry.action || 'update',
      zone: entry.zone || items[0]?.zone || null,
      items,
      meta: entry.meta || {},
    };
    base.title = entry.title || buildTitle(base.action, items, base.meta);

    this.events.push(base);
    if (this.events.length > MAX_MEMORY) this.events.splice(0, this.events.length - MAX_MEMORY);

    this.queue = this.queue
      .then(async () => {
        this.rotateIfNeeded();
        await fs.promises.appendFile(this.file, `${JSON.stringify(base)}\n`, 'utf8');
      })
      .catch(() => {});

    for (const listener of this.listeners) {
      try {
        listener(base);
      } catch {
        /* ignore */
      }
    }
    return base;
  }

  list({ limit = 100, actor = '', since = 0, zone = '' } = {}) {
    let out = this.events;
    if (actor) out = out.filter((e) => e.actor === actor);
    if (zone) out = out.filter((e) => e.zone === zone || e.items.some((i) => i.zone === zone));
    if (since) out = out.filter((e) => e.ts >= since);
    return out.slice(-Math.max(1, Math.min(1000, Number(limit) || 100))).reverse();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  summary() {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const recent = this.events.filter((e) => now - e.ts <= day && e.actor !== 'ui');
    const touched = new Set();
    let actions = 0;
    for (const e of recent) {
      actions += 1;
      for (const item of e.items) touched.add(`${item.zone}:${item.path}`);
    }
    return { actions, files: touched.size, windowMs: day };
  }
}

export const activity = new ActivityFeed(EVENTS_FILE);
