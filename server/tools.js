import crypto from 'node:crypto';
import {
  AUTH_TOKEN,
  PUBLIC_URL,
  VERSION,
  MAX_TEXT_BYTES,
} from './config.js';
import * as store from './store.js';
import { activity } from './activity.js';

const zoneEnum = ['drive', 'workspace'];

function batchIdFor(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const pathsSchema = {
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: '区域内的相对路径列表，例如 ["notes/a.md"]',
};

export const TOOL_DEFS = [
  {
    name: 'vault_overview',
    description: '查看网盘与工作区的整体情况：文件数、占用空间、共用（硬链接）文件数、分叉文件数，以及最近 AI 活动摘要。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_items',
    description: '列出网盘或工作区某个目录下的文件与文件夹，并标注每个条目是「仅网盘」「仅工作区」「共用」还是「已分叉」。',
    inputSchema: {
      type: 'object',
      properties: {
        zone: { type: 'string', enum: zoneEnum, description: 'drive=网盘（只读区），workspace=工作区（可写区）', default: 'drive' },
        path: { type: 'string', description: '相对路径，留空表示根目录', default: '' },
        recursive: { type: 'boolean', description: '是否递归展开子目录', default: false },
        depth: { type: 'number', description: '递归深度，默认 2', default: 2 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_items',
    description: '按文件名片段在网盘或工作区中搜索（不区分大小写）。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '文件名关键词' },
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        path: { type: 'string', description: '搜索起点，默认根目录', default: '' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stat_item',
    description: '查看单个文件/文件夹的大小、修改时间、双视图状态和硬链接数。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: '读取文本文件内容（超过上限会截断）。二进制文件返回 base64。读取网盘文件是允许的，但修改必须先移到工作区。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        path: { type: 'string' },
        max_bytes: { type: 'number', description: `最多读取字节数，默认 ${MAX_TEXT_BYTES}`, default: MAX_TEXT_BYTES },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: '在工作区写入或追加文本文件。网盘是只读区：要修改网盘文件，先用 move_to_workspace 把它移到工作区。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: '工作区内的相对路径' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append'], default: 'overwrite' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_folder',
    description: '在指定区域新建文件夹（会自动创建父目录）。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'workspace' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'move_to_workspace',
    description: '把网盘条目移到工作区。使用硬链接实现：网盘与工作区出现两个条目，但磁盘上只有一份数据。目录会递归处理。',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: { paths: pathsSchema },
      additionalProperties: false,
    },
  },
  {
    name: 'publish_to_drive',
    description: '把工作区中新建的文件发布到网盘（建立硬链接，两边共用同一份数据）。',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: { paths: pathsSchema },
      additionalProperties: false,
    },
  },
  {
    name: 'sync_to_drive',
    description: '当工作区副本与网盘内容不一致时，把工作区内容覆盖写回网盘，并恢复为同一份数据。',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: { paths: pathsSchema },
      additionalProperties: false,
    },
  },
  {
    name: 'release_to_drive',
    description: '关闭工作区视图，把条目退回网盘。共用文件只删除工作区视图，数据仍在网盘；工作区独占文件会被移入网盘。',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: { paths: pathsSchema },
      additionalProperties: false,
    },
  },
  {
    name: 'rename_items',
    description: '批量重命名/移动同一区域内的条目。数组每项形如 {"from":"a.txt","to":"b.txt"}，会自动同步另一个视图的路径。',
    inputSchema: {
      type: 'object',
      required: ['items'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['from', 'to'],
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'delete_items',
    description: '批量删除条目。默认只删除当前区域的视图；purge=true 会同时删除另一个区域（彻底删除数据）。',
    inputSchema: {
      type: 'object',
      required: ['paths'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        paths: pathsSchema,
        purge: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'copy_item',
    description: '在同一区域内复制文件或文件夹。',
    inputSchema: {
      type: 'object',
      required: ['from', 'to'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        from: { type: 'string' },
        to: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'import_url',
    description: '从 http/https 链接抓取文件保存到网盘（内网地址会被拒绝），适合把远程素材放进网盘。',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        path: { type: 'string', description: '保存到的目录，默认根目录', default: '' },
        filename: { type: 'string', description: '可选，自定义文件名' },
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'download_link',
    description: '生成一个带令牌的下载链接，人类可以在浏览器里直接下载该文件。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        zone: { type: 'string', enum: zoneEnum, default: 'drive' },
        path: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

export async function runTool(name, args = {}, ctx = {}) {
  const actor = ctx.actor || 'ai';
  const batchId = ctx.batchId || batchIdFor('call');
  const origin = PUBLIC_URL || ctx.origin || '';

  switch (name) {
    case 'vault_overview': {
      const stats = await store.vaultStats(true);
      return {
        text: [
          `网盘：${stats.drive.files} 个文件 / ${stats.drive.dirs} 个文件夹 / ${formatBytes(stats.drive.bytes)}`,
          `工作区：${stats.workspace.files} 个文件 / ${stats.workspace.dirs} 个文件夹 / ${formatBytes(stats.workspace.bytes)}`,
          `共用（同一物理文件）：${stats.shared.files} 个 / ${formatBytes(stats.shared.bytes)}`,
          `分叉（两份副本）：${stats.diverged.files} 个 / ${formatBytes(stats.diverged.bytes)}`,
          `规则：网盘只读；改写文件必须先进工作区；发布/写回后恢复为一份数据。`,
        ].join('\n'),
      };
    }

    case 'list_items': {
      const zone = args.zone || 'drive';
      const rel = args.path || '';
      const entries = args.recursive
        ? await store.listTree(zone, rel, { depth: Number(args.depth || 2) })
        : await store.listDir(zone, rel);
      return { text: formatEntries(zone, rel, entries) };
    }

    case 'search_items': {
      const zone = args.zone || 'drive';
      const entries = await store.searchItems(zone, args.path || '', args.query);
      await activity.record({
        actor,
        batchId,
        action: 'search',
        zone,
        items: entries.slice(0, 20).map((e) => ({ path: e.path, zone, type: e.type })),
        meta: { query: args.query, total: entries.length },
      });
      return { text: entries.length ? formatEntries(zone, args.path || '', entries) : '没有匹配的文件。' };
    }

    case 'stat_item': {
      const zone = args.zone || 'drive';
      const info = await store.fileInfo(zone, args.path);
      return { text: JSON.stringify(info, null, 2) };
    }

    case 'read_file': {
      const zone = args.zone || 'drive';
      const result = await store.readText(zone, args.path, { maxBytes: Number(args.max_bytes || MAX_TEXT_BYTES) });
      await activity.record({
        actor,
        batchId,
        action: 'read',
        zone,
        items: [{ path: result.path, zone, type: 'file', note: formatBytes(result.size) }],
        meta: { truncated: result.truncated, encoding: result.encoding },
      });
      const header = result.truncated
        ? `[已截断，仅显示前 ${formatBytes(MAX_TEXT_BYTES)} / 共 ${formatBytes(result.size)}]\n`
        : '';
      return { text: `${header}${result.content}` };
    }

    case 'write_file': {
      const result = await store.writeText(args.path, args.content, args.mode || 'overwrite');
      await activity.record({
        actor,
        batchId,
        action: 'write',
        zone: 'workspace',
        items: [{
          path: result.path,
          zone: 'workspace',
          type: 'file',
          note: result.state === 'shared' ? '网盘视图同步变更（同一物理文件）' : formatBytes(result.size),
        }],
      });
      store.resetStatsCache();
      return { text: `已写入 ${result.path}（${formatBytes(result.size)}）` };
    }

    case 'create_folder': {
      const zone = args.zone || 'workspace';
      const created = await store.createFolder(zone, args.path);
      await activity.record({
        actor,
        batchId,
        action: 'create_folder',
        zone,
        items: [{ path: created.path, zone, type: 'dir' }],
      });
      store.resetStatsCache();
      return { text: `已创建文件夹 ${created.path}` };
    }

    case 'move_to_workspace':
      return runLinkBatch('drive', args.paths, 'link', actor, batchId);

    case 'publish_to_drive':
      return runLinkBatch('workspace', args.paths, 'publish', actor, batchId);

    case 'sync_to_drive': {
      const paths = args.paths || [];
      const done = [];
      const failed = [];
      for (const p of paths) {
        try {
          done.push(await store.syncPath('workspace', p));
        } catch (err) {
          failed.push(`${p}：${err.message}`);
        }
      }
      if (done.length) {
        await activity.record({
          actor,
          batchId,
          action: 'sync',
          zone: 'workspace',
          items: done.map((r) => ({ path: r.path, zone: 'workspace', type: r.type, note: '已恢复为同一份数据' })),
        });
        store.resetStatsCache();
      }
      return { text: reportBatch('写回', done, failed) };
    }

    case 'release_to_drive': {
      const paths = args.paths || [];
      const done = [];
      const failed = [];
      for (const p of paths) {
        try {
          done.push(await store.releasePath('workspace', p));
        } catch (err) {
          failed.push(`${p}：${err.message}`);
        }
      }
      if (done.length) {
        await activity.record({
          actor,
          batchId,
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
      return { text: reportBatch('退回', done, failed) };
    }

    case 'rename_items': {
      const zone = args.zone || 'drive';
      const renamed = await store.renameItems(zone, args.items || []);
      if (renamed.length) {
        await activity.record({
          actor,
          batchId,
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
      return {
        text: renamed.length
          ? renamed.map((r) => `${r.from} → ${r.to}`).join('\n')
          : '没有发生改名。',
      };
    }

    case 'delete_items': {
      const zone = args.zone || 'drive';
      const results = await store.deleteItems(zone, args.paths || [], { purge: Boolean(args.purge) });
      const done = results.filter((r) => r.ok);
      if (done.length) {
        await activity.record({
          actor,
          batchId,
          action: 'delete',
          zone,
          items: done.map((r) => ({ path: r.path, zone, type: r.type, note: r.note })),
          meta: { purge: Boolean(args.purge) },
        });
        store.resetStatsCache();
      }
      const failed = results.filter((r) => !r.ok).map((r) => `${r.path}：${r.message}`);
      return {
        text: [
          ...done.map((r) => `已删除 ${r.path}${r.note ? `（${r.note}）` : ''}`),
          ...failed.map((f) => `失败 ${f}`),
        ].join('\n') || '没有删除任何条目。',
      };
    }

    case 'copy_item': {
      const zone = args.zone || 'drive';
      const copied = await store.copyItem(zone, args.from, args.to);
      await activity.record({
        actor,
        batchId,
        action: 'copy',
        zone,
        items: [{ path: copied.path, zone, type: copied.type, note: `源：${args.from}` }],
      });
      store.resetStatsCache();
      return { text: `已复制到 ${copied.path}` };
    }

    case 'import_url': {
      const zone = args.zone || 'drive';
      const saved = await store.importUrl(args.url, {
        dir: args.path || '',
        zone,
        filename: args.filename,
      });
      await activity.record({
        actor,
        batchId,
        action: 'import',
        zone,
        items: [{ path: saved.path, zone, type: 'file', note: formatBytes(saved.size) }],
      });
      store.resetStatsCache();
      return { text: `已保存 ${saved.path}（${formatBytes(saved.size)}）` };
    }

    case 'download_link': {
      const zone = args.zone || 'drive';
      await store.fileInfo(zone, args.path);
      if (!origin) throw new store.Fail('服务端没有配置 PUBLIC_URL，无法生成对外链接', { code: 'ENOURL' });
      const url = `${origin}/api/fs/download?zone=${zone}&path=${encodeURIComponent(args.path)}&token=${encodeURIComponent(AUTH_TOKEN)}`;
      return { text: url };
    }

    default:
      throw new store.Fail(`未知工具：${name}`, { code: 'ENOTOOL', status: 404 });
  }
}

async function runLinkBatch(fromZone, paths = [], action, actor, batchId) {
  const done = [];
  const failed = [];
  for (const p of paths) {
    try {
      done.push({ path: p, ...(await store.linkInto(fromZone, p, fromZone === 'drive' ? 'workspace' : 'drive')) });
    } catch (err) {
      failed.push(`${p}：${err.message}`);
    }
  }
  if (done.length) {
    const targetZone = fromZone === 'drive' ? 'workspace' : 'drive';
    await activity.record({
      actor,
      batchId,
      action,
      zone: targetZone,
      items: done.map((r) => ({
        path: r.path,
        zone: targetZone,
        type: r.type,
        note: r.mode === 'copied' ? '跨文件系统，已复制副本' : '与另一区域共用同一份数据',
      })),
    });
    store.resetStatsCache();
  }
  return { text: reportBatch(action === 'link' ? '移到工作区' : '发布', done, failed) };
}

function reportBatch(label, done, failed) {
  const lines = done.map((r) => `${label}：${r.path}`);
  lines.push(...failed.map((f) => `失败 ${f}`));
  return lines.join('\n') || '没有处理任何条目。';
}

function formatEntries(zone, rel, entries) {
  if (entries.length === 0) return `${zone === 'drive' ? '网盘' : '工作区'} ${rel || '/'} 是空的。`;
  const stateLabel = { shared: '共用', only: '仅本区', diverged: '已分叉' };
  const lines = entries.map((e) => {
    const kind = e.type === 'dir' ? '文件夹' : formatBytes(e.size);
    return `${e.path}  [${kind}]  ${stateLabel[e.state] || e.state}`;
  });
  return lines.join('\n');
}

export const TOOL_NAMES = TOOL_DEFS.map((tool) => tool.name);
export const SERVER_INFO = { name: 'wharf', title: 'Wharf AI 网盘工作区', version: VERSION };
