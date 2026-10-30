import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DRIVE_DIR,
  WORKSPACE_DIR,
  TMP_DIR,
  MAX_TEXT_BYTES,
  MAX_IMPORT_BYTES,
} from './config.js';

export class Fail extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'Fail';
    this.code = opts.code || 'EINVAL';
    this.status = opts.status || 400;
    this.hint = opts.hint || '';
  }
}

const BASES = { drive: DRIVE_DIR, workspace: WORKSPACE_DIR };
const MIRROR = { drive: 'workspace', workspace: 'drive' };
const LABELS = { drive: '网盘', workspace: '工作区' };

const SHARED = 'shared';
const ONLY = 'only';
const DIVERGED = 'diverged';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);

export function zoneLabel(zone) {
  return LABELS[zone] || zone;
}

export function otherZone(zone) {
  return MIRROR[zone];
}

export function baseOf(zone) {
  const base = BASES[zone];
  if (!base) throw new Fail(`未知区域「${zone}」`, { code: 'EZONE' });
  return base;
}

export function normRel(rel) {
  if (rel == null) return '';
  if (typeof rel !== 'string') throw new Fail('路径必须是字符串', { code: 'EPATH' });
  if (rel.includes('\0')) throw new Fail('路径包含非法字符', { code: 'EPATH' });
  const parts = rel
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Fail('路径不能包含 “..”', { code: 'EPATH' });
  return parts.join('/');
}

export function absOf(zone, rel) {
  const base = baseOf(zone);
  const clean = normRel(rel);
  const abs = clean ? path.join(base, ...clean.split('/')) : base;
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Fail('路径越界', { code: 'EPATH' });
  }
  return abs;
}

function joinRel(rel, name) {
  return rel ? `${rel}/${name}` : name;
}

function tmpSuffix() {
  return `.wharf-${crypto.randomBytes(5).toString('hex')}`;
}

async function statOf(abs) {
  try {
    return await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function ensureDir(abs) {
  await fsp.mkdir(abs, { recursive: true });
}

async function linkOrCopy(src, dst) {
  try {
    await fsp.link(src, dst);
    return 'linked';
  } catch (err) {
    if (['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EMLINK'].includes(err.code)) {
      await fsp.copyFile(src, dst);
      return 'copied';
    }
    throw err;
  }
}

function sameInode(a, b) {
  return Boolean(a && b && a.ino && b.ino && a.ino === b.ino);
}

/** 计算某个条目在两个区域中的关系：only / shared / diverged */
export async function stateOf(zone, rel, localStat) {
  const mirrorAbs = absOf(otherZone(zone), rel);
  const mirrorStat = await statOf(mirrorAbs);
  if (!mirrorStat) return ONLY;
  const local = localStat || (await statOf(absOf(zone, rel)));
  if (!local) return ONLY;
  if (local.isDirectory() !== mirrorStat.isDirectory()) return DIVERGED;
  if (local.isDirectory()) return SHARED;
  return sameInode(local, mirrorStat) ? SHARED : DIVERGED;
}

export async function listDir(zone, rel = '') {
  const clean = normRel(rel);
  const abs = absOf(zone, clean);
  const st = await statOf(abs);
  if (!st) throw new Fail(`目录不存在：${clean || '/'}`, { status: 404, code: 'ENOENT' });
  if (!st.isDirectory()) throw new Fail(`不是目录：${clean}`, { code: 'ENOTDIR' });

  const names = await fsp.readdir(abs);
  const entries = await Promise.all(
    names.map(async (name) => {
      const childRel = joinRel(clean, name);
      const lst = await fsp.lstat(path.join(abs, name));
      if (!lst) return null;
      const isLink = lst.isSymbolicLink();
      const cst = isLink ? await statOf(path.join(abs, name)) : lst;
      if (!cst) return null;
      const isDir = cst.isDirectory();
      return {
        name,
        path: childRel,
        type: isDir ? 'dir' : 'file',
        size: isDir ? null : cst.size,
        mtime: cst.mtimeMs,
        state: isLink ? ONLY : await stateOf(zone, childRel, cst),
        symlink: isLink,
      };
    })
  );

  return entries
    .filter(Boolean)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
}

export async function listTree(zone, rel = '', { depth = 2, limit = 400 } = {}) {
  const rootRel = normRel(rel);
  const out = [];
  let count = 0;

  async function walk(dirRel, level) {
    if (count >= limit) return;
    const children = await listDir(zone, dirRel);
    for (const child of children) {
      if (count >= limit) return;
      count += 1;
      out.push(child);
      if (child.type === 'dir' && level < depth) await walk(child.path, level + 1);
    }
  }

  const st = await statOf(absOf(zone, rootRel));
  if (!st) throw new Fail(`目录不存在：${rootRel || '/'}`, { status: 404, code: 'ENOENT' });
  if (st.isDirectory()) await walk(rootRel, 0);
  return out;
}

export async function searchItems(zone, rel, query, { limit = 300 } = {}) {
  const rootRel = normRel(rel);
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) throw new Fail('搜索关键词不能为空');
  const out = [];
  const rootAbs = absOf(zone, rootRel);
  const st = await statOf(rootAbs);
  if (!st) throw new Fail(`目录不存在：${rootRel || '/'}`, { status: 404, code: 'ENOENT' });

  async function walk(dirRel, dirAbs) {
    if (out.length >= limit) return;
    let names;
    try {
      names = await fsp.readdir(dirAbs);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= limit) return;
      const childRel = joinRel(dirRel, name);
      const childAbs = path.join(dirAbs, name);
      const lst = await fsp.lstat(childAbs).catch(() => null);
      if (!lst) continue;
      const isDir = lst.isDirectory();
      if (name.toLowerCase().includes(needle)) {
        out.push({
          name,
          path: childRel,
          type: isDir ? 'dir' : 'file',
          size: isDir ? null : lst.size,
          mtime: lst.mtimeMs,
          state: await stateOf(zone, childRel, lst),
        });
      }
      if (isDir) await walk(childRel, childAbs);
    }
  }

  if (st.isDirectory()) await walk(rootRel, rootAbs);
  return out;
}

export async function fileInfo(zone, rel) {
  const clean = normRel(rel);
  const abs = absOf(zone, clean);
  const st = await statOf(abs);
  if (!st) throw new Fail(`找不到「${clean}」`, { status: 404, code: 'ENOENT' });
  return {
    name: path.basename(clean) || zoneLabel(zone),
    path: clean,
    zone,
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.isDirectory() ? null : st.size,
    mtime: st.mtimeMs,
    birthtime: st.birthtimeMs,
    state: await stateOf(zone, clean, st),
    hardlinks: st.nlink,
  };
}

async function readHead(abs, maxBytes) {
  const handle = await fsp.open(abs, 'r');
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    if (size > 0) await handle.read(buffer, 0, size, 0);
    return { buffer, size: stat.size };
  } finally {
    await handle.close();
  }
}

export async function previewFile(zone, rel) {
  const clean = normRel(rel);
  const abs = absOf(zone, clean);
  const st = await statOf(abs);
  if (!st) throw new Fail(`找不到「${clean}」`, { status: 404, code: 'ENOENT' });
  if (st.isDirectory()) throw new Fail('文件夹无法预览', { code: 'EISDIR' });

  const ext = path.extname(clean).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    return { kind: 'image', size: st.size, ext };
  }

  const { buffer, size } = await readHead(abs, MAX_TEXT_BYTES);
  if (buffer.includes(0)) {
    return { kind: 'binary', size, ext };
  }
  return {
    kind: 'text',
    size,
    ext,
    text: buffer.toString('utf8'),
    truncated: size > buffer.length,
    limit: MAX_TEXT_BYTES,
  };
}

export async function readText(zone, rel, { maxBytes = MAX_TEXT_BYTES } = {}) {
  const clean = normRel(rel);
  const abs = absOf(zone, clean);
  const st = await statOf(abs);
  if (!st) throw new Fail(`找不到「${clean}」`, { status: 404, code: 'ENOENT' });
  if (st.isDirectory()) throw new Fail('这是一个文件夹', { code: 'EISDIR' });
  const { buffer, size } = await readHead(abs, maxBytes);
  const binary = buffer.includes(0);
  return {
    path: clean,
    zone,
    size,
    truncated: size > buffer.length,
    encoding: binary ? 'binary' : 'utf8',
    content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
  };
}

export async function writeText(rel, content, mode = 'overwrite') {
  const clean = normRel(rel);
  if (!clean) throw new Fail('需要文件路径', { code: 'EPATH' });
  const abs = absOf('workspace', clean);
  const st = await statOf(abs);
  if (st && st.isDirectory()) throw new Fail(`「${clean}」是一个文件夹`, { code: 'EISDIR' });
  await ensureDir(path.dirname(abs));

  const text = String(content ?? '');
  if (st && mode === 'append') {
    await fsp.appendFile(abs, text, 'utf8');
  } else {
    // writeFile 截断原 inode，硬链接的两处视图继续保持同一份数据
    await fsp.writeFile(abs, text, 'utf8');
  }
  const after = await fsp.stat(abs);
  return { path: clean, zone: 'workspace', size: after.size, state: await stateOf('workspace', clean, after) };
}

export function sanitizeName(name) {
  const raw = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\0/g, '')
    .trim();
  if (!raw || raw === '.' || raw === '..') throw new Fail('文件名无效', { code: 'ENAME' });
  return raw;
}

export async function saveUpload({ zone, dir = '', filename, tmpPath, overwrite = false }) {
  const cleanDir = normRel(dir);
  const name = sanitizeName(filename);
  const rel = joinRel(cleanDir, name);
  const target = absOf(zone, rel);
  const st = await statOf(target);

  try {
    if (st && st.isDirectory()) throw new Fail(`「${rel}」是文件夹，不能覆盖`, { code: 'EISDIR' });
    if (st && !overwrite) throw new Fail(`「${rel}」已存在`, { status: 409, code: 'EEXIST' });
    await ensureDir(path.dirname(target));
    if (st) {
      // 覆盖写同一 inode，已链接的工作区视图会同步看到新内容
      await fsp.copyFile(tmpPath, target);
      await fsp.unlink(tmpPath).catch(() => {});
    } else {
      try {
        await fsp.rename(tmpPath, target);
      } catch (err) {
        if (err.code !== 'EXDEV') throw err;
        await fsp.copyFile(tmpPath, target);
        await fsp.unlink(tmpPath).catch(() => {});
      }
    }
  } finally {
    await fsp.unlink(tmpPath).catch(() => {});
  }

  const after = await fsp.stat(target);
  return {
    name,
    path: rel,
    zone,
    size: after.size,
    mtime: after.mtimeMs,
    state: await stateOf(zone, rel, after),
  };
}

export async function createFolder(zone, rel) {
  const clean = normRel(rel);
  if (!clean) throw new Fail('文件夹名不能为空', { code: 'EPATH' });
  const abs = absOf(zone, clean);
  const st = await statOf(abs);
  if (st) throw new Fail(`「${clean}」已存在`, { status: 409, code: 'EEXIST' });
  await ensureDir(abs);
  return { path: clean, zone, type: 'dir', state: await stateOf(zone, clean) };
}

export async function renameItems(zone, items = []) {
  if (!Array.isArray(items) || items.length === 0) throw new Fail('没有要重命名的条目');
  const mirror = otherZone(zone);
  const tag = tmpSuffix();
  const prepared = [];
  // 本批次里会被移走的源路径：目标若恰好是其中之一，属于 a↔b 交换，不算冲突
  const movingSources = new Set(items.map((item) => normRel(item.from)).filter(Boolean));

  for (const item of items) {
    const from = normRel(item.from);
    const to = normRel(item.to);
    if (!from) throw new Fail('不能重命名根目录', { code: 'EPATH' });
    if (!to) throw new Fail('目标路径不能为空', { code: 'EPATH' });
    if (from === to) continue;
    if (to.startsWith(`${from}/`)) throw new Fail('不能把条目移动到它自己的子目录');

    const srcAbs = absOf(zone, from);
    const dstAbs = absOf(zone, to);
    const srcStat = await statOf(srcAbs);
    if (!srcStat) {
      // 条目不在指定区域时，提示它实际所在的区域，避免 AI 反复试错
      const inMirror = await statOf(absOf(mirror, from));
      const hint = inMirror ? `，它在${LABELS[mirror]}里，请设置 zone="${mirror}"` : '';
      throw new Fail(`找不到「${from}」（${LABELS[zone]}里没有${hint ? '它' : ''}）${hint}`, { status: 404, code: 'ENOENT' });
    }
    if ((await statOf(dstAbs)) && !movingSources.has(to)) throw new Fail(`目标已存在：${to}`, { status: 409, code: 'EEXIST' });

    const mirrorAbs = absOf(mirror, from);
    const mirrorStat = await statOf(mirrorAbs);
    const mirrorLinked = mirrorStat && (srcStat.isDirectory() === mirrorStat.isDirectory())
      && (srcStat.isDirectory() || sameInode(srcStat, mirrorStat));

    prepared.push({
      from,
      to,
      srcAbs,
      dstAbs,
      mirrorAbs,
      mirrorLinked,
      tmp: srcAbs + tag,
      mirrorTmp: mirrorAbs + tag,
    });
  }

  if (prepared.length === 0) return [];

  // 两阶段重命名，支持 a→b、b→a 这类交换
  for (const p of prepared) {
    await fsp.rename(p.srcAbs, p.tmp);
    if (p.mirrorLinked) await fsp.rename(p.mirrorAbs, p.mirrorTmp);
  }
  for (const p of prepared) {
    await ensureDir(path.dirname(p.dstAbs));
    await fsp.rename(p.tmp, p.dstAbs);
    if (p.mirrorLinked) {
      const mirrorDst = absOf(mirror, p.to);
      await ensureDir(path.dirname(mirrorDst));
      await fsp.rename(p.mirrorTmp, mirrorDst);
    }
  }

  return prepared.map((p) => ({ from: p.from, to: p.to, zone, mirror: p.mirrorLinked }));
}

export async function deleteItems(zone, paths = [], { purge = false } = {}) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Fail('没有要删除的条目');
  const results = [];

  for (const raw of paths) {
    const clean = normRel(raw);
    if (!clean) {
      results.push({ path: '', ok: false, message: '不能删除根目录' });
      continue;
    }
    const abs = absOf(zone, clean);
    const st = await statOf(abs);
    if (!st) {
      results.push({ path: clean, ok: false, message: '条目不存在' });
      continue;
    }
    const state = await stateOf(zone, clean, st);
    await fsp.rm(abs, { recursive: true, force: true });

    let note = '';
    if (purge) {
      await fsp.rm(absOf(otherZone(zone), clean), { recursive: true, force: true });
      note = '两个区域的视图都已删除';
    } else if (state === SHARED) {
      note = `只删除了${zoneLabel(zone)}的视图，文件内容仍在${zoneLabel(otherZone(zone))}`;
    }
    results.push({
      path: clean,
      ok: true,
      type: st.isDirectory() ? 'dir' : 'file',
      state,
      note,
    });
  }

  return results;
}

/** 在 fromZone 的条目上建立到 toZone 的硬链接（目录递归） */
export async function linkInto(fromZone, rel, toZone) {
  const clean = normRel(rel);
  if (!clean) throw new Fail('不能链接根目录', { code: 'EPATH' });
  const srcAbs = absOf(fromZone, clean);
  const dstAbs = absOf(toZone, clean);
  const srcStat = await statOf(srcAbs);
  if (!srcStat) throw new Fail(`找不到「${clean}」`, { status: 404, code: 'ENOENT' });

  if (srcStat.isDirectory()) {
    await ensureDir(dstAbs);
    const children = await fsp.readdir(srcAbs);
    for (const child of children) {
      await linkInto(fromZone, joinRel(clean, child), toZone);
    }
    return { path: clean, type: 'dir', mode: 'shared' };
  }

  const dstStat = await statOf(dstAbs);
  if (dstStat) {
    if (sameInode(srcStat, dstStat)) {
      return { path: clean, type: 'file', mode: 'shared' };
    }
    throw new Fail(
      `目标区域的「${clean}」已存在且不是同一个文件。先删除或改名再试。`,
      { status: 409, code: 'EEXIST' }
    );
  }

  await ensureDir(path.dirname(dstAbs));
  const mode = await linkOrCopy(srcAbs, dstAbs);
  return { path: clean, type: 'file', mode: mode === 'linked' ? 'shared' : 'copied' };
}

/** 工作区条目退回网盘：同 inode 只移除工作区视图；独占文件则移入网盘 */
export async function releasePath(zone, rel) {
  if (zone !== 'workspace') throw new Fail('只有工作区条目可以退回网盘');
  const clean = normRel(rel);
  if (!clean) throw new Fail('不能操作根目录', { code: 'EPATH' });
  const wAbs = absOf('workspace', clean);
  const dAbs = absOf('drive', clean);
  const wStat = await statOf(wAbs);
  if (!wStat) throw new Fail(`工作区里没有「${clean}」`, { status: 404, code: 'ENOENT' });
  const dStat = await statOf(dAbs);

  if (wStat.isDirectory()) {
    if (!dStat) {
      await ensureDir(path.dirname(dAbs));
      await fsp.mkdir(dAbs, { recursive: true });
    }
    const children = await fsp.readdir(wAbs);
    for (const child of children) {
      await releasePath('workspace', joinRel(clean, child));
    }
    await fsp.rmdir(wAbs).catch(() => {});
    return { path: clean, type: 'dir', mode: 'released' };
  }

  if (dStat && sameInode(wStat, dStat)) {
    await fsp.unlink(wAbs);
    return { path: clean, type: 'file', mode: 'released' };
  }
  if (!dStat) {
    await ensureDir(path.dirname(dAbs));
    await fsp.rename(wAbs, dAbs);
    return { path: clean, type: 'file', mode: 'moved' };
  }
  throw new Fail(
    `工作区里的「${clean}」和网盘内容不一致，请先“写回网盘”。`,
    { code: 'EDIVERGED', hint: 'sync_to_drive' }
  );
}

/** 工作区内容写回网盘，并恢复硬链接（保证只有一个物理文件） */
export async function syncPath(zone, rel) {
  if (zone !== 'workspace') throw new Fail('只有工作区条目可以写回网盘');
  const clean = normRel(rel);
  if (!clean) throw new Fail('不能操作根目录', { code: 'EPATH' });
  const wAbs = absOf('workspace', clean);
  const dAbs = absOf('drive', clean);
  const wStat = await statOf(wAbs);
  if (!wStat) throw new Fail(`工作区里没有「${clean}」`, { status: 404, code: 'ENOENT' });
  const dStat = await statOf(dAbs);

  if (wStat.isDirectory()) {
    if (!dStat) await fsp.mkdir(dAbs, { recursive: true });
    const children = await fsp.readdir(wAbs);
    for (const child of children) {
      await syncPath('workspace', joinRel(clean, child));
    }
    return { path: clean, type: 'dir', mode: 'synced' };
  }

  await ensureDir(path.dirname(dAbs));
  if (dStat) {
    // 覆盖写保留网盘 inode，然后再把工作区视图重建为硬链接
    await fsp.copyFile(wAbs, dAbs);
    await fsp.unlink(wAbs);
  } else {
    await fsp.rename(wAbs, dAbs);
  }
  const mode = await linkOrCopy(dAbs, wAbs);
  return { path: clean, type: 'file', mode: mode === 'linked' ? 'synced' : 'copied' };
}

export async function copyItem(zone, from, to) {
  const srcRel = normRel(from);
  const dstRel = normRel(to);
  if (!srcRel || !dstRel) throw new Fail('需要源路径和目标路径', { code: 'EPATH' });
  const srcAbs = absOf(zone, srcRel);
  const dstAbs = absOf(zone, dstRel);
  const srcStat = await statOf(srcAbs);
  if (!srcStat) throw new Fail(`找不到「${srcRel}」`, { status: 404, code: 'ENOENT' });
  if (await statOf(dstAbs)) throw new Fail(`目标已存在：${dstRel}`, { status: 409, code: 'EEXIST' });
  await ensureDir(path.dirname(dstAbs));
  await fsp.cp(srcAbs, dstAbs, { recursive: true, force: false, errorOnExist: true });
  return { path: dstRel, zone, type: srcStat.isDirectory() ? 'dir' : 'file' };
}

function assertPublicUrl(url) {
  const host = url.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || bare === '::1' || bare === '0.0.0.0') {
    throw new Fail('不允许访问本机地址', { code: 'ESSRF' });
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(bare)) {
    throw new Fail('不允许访问内网地址', { code: 'ESSRF' });
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(bare)) {
    throw new Fail('不允许访问内网地址', { code: 'ESSRF' });
  }
}

export async function importUrl(url, { dir = '', filename, zone = 'drive' } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Fail('链接格式不正确', { code: 'EURL' });
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Fail('只支持 http/https 链接', { code: 'EURL' });
  assertPublicUrl(parsed);

  const res = await fetch(parsed, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Wharf/1.0 (+ai-drive)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Fail(`下载失败：HTTP ${res.status}`, { status: 502, code: 'EIMPORT' });

  const length = Number(res.headers.get('content-length') || 0);
  if (length && length > MAX_IMPORT_BYTES) throw new Fail('文件超过导入上限', { status: 413, code: 'ETOOBIG' });
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > MAX_IMPORT_BYTES) throw new Fail('文件超过导入上限', { status: 413, code: 'ETOOBIG' });

  const tmpPath = path.join(TMP_DIR, `import-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.writeFile(tmpPath, body);

  let name = filename;
  if (!name) {
    const base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    name = base || 'imported-file';
  }
  return saveUpload({ zone, dir, filename: name, tmpPath, overwrite: false });
}

async function walkStats(dirAbs) {
  const files = new Map();
  let bytes = 0;
  let dirs = 0;

  async function walk(abs, rel) {
    let names;
    try {
      names = await fsp.readdir(abs);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith('.wharf-tmp') || name.includes('.wharf-')) continue;
      const childAbs = path.join(abs, name);
      const childRel = joinRel(rel, name);
      const st = await fsp.lstat(childAbs).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        dirs += 1;
        await walk(childAbs, childRel);
      } else {
        files.set(childRel, { size: st.size, ino: st.ino });
        bytes += st.size;
      }
    }
  }

  await walk(dirAbs, '');
  return { files, dirs, bytes };
}

let statsCache = { at: 0, value: null };

export async function vaultStats(force = false) {
  if (!force && statsCache.value && Date.now() - statsCache.at < 20000) return statsCache.value;

  const [drive, workspace] = await Promise.all([walkStats(DRIVE_DIR), walkStats(WORKSPACE_DIR)]);
  let sharedFiles = 0;
  let sharedBytes = 0;
  let divergedFiles = 0;
  let divergedBytes = 0;

  for (const [rel, d] of drive.files) {
    const w = workspace.files.get(rel);
    if (!w) continue;
    if (d.ino && w.ino && d.ino === w.ino) {
      sharedFiles += 1;
      sharedBytes += d.size;
    } else {
      divergedFiles += 1;
      divergedBytes += d.size + w.size;
    }
  }

  const value = {
    drive: { files: drive.files.size, dirs: drive.dirs, bytes: drive.bytes },
    workspace: { files: workspace.files.size, dirs: workspace.dirs, bytes: workspace.bytes },
    shared: { files: sharedFiles, bytes: sharedBytes },
    diverged: { files: divergedFiles, bytes: divergedBytes },
    at: Date.now(),
  };
  statsCache = { at: Date.now(), value };
  return value;
}

export function resetStatsCache() {
  statsCache = { at: 0, value: null };
}
