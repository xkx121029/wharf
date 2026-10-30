'use strict';

/* ------------------------------------------------------------------ */
/* 工具函数                                                           */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  token: localStorage.getItem('wharf_token') || '',
  zone: 'drive',
  path: '',
  entries: [],
  selected: new Set(),
  searching: false,
  query: '',
  events: [],
  filter: 'all',
  stats: null,
  stream: null,
  pollTimer: null,
  streamErrors: 0,
  refreshTimer: null,
  menuEntry: null,
};

const ZONE_LABEL = { drive: '网盘', workspace: '工作区' };
const ACTOR_LABEL = { ai: 'AI', ui: '我', api: '接口', system: '系统' };
const STATE_LABEL = { shared: '共用', only: '单区', diverged: '已分叉' };
const STATE_TITLE = {
  shared: '网盘与工作区各有一个条目，磁盘上只有一份数据',
  only: '只存在于当前区域',
  diverged: '两个区域各有一份副本，内容不一致',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 45000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  if (diff < 172800000) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function fileTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function dirname(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function basename(p) {
  return String(p || '').split('/').filter(Boolean).pop() || '';
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------------ */
/* 图标                                                               */
/* ------------------------------------------------------------------ */

const ICONS = {
  drive: '<rect x="3.5" y="6" width="13" height="9.5" rx="1"/><path d="M3.5 8.5h13"/><path d="M6 12h3.5"/>',
  workspace: '<rect x="3" y="4" width="14" height="9" rx="1"/><path d="M6 16.5h8"/><path d="M10 13v3.5"/>',
  folder: '<path d="M3.5 6.5a1 1 0 011-1h3.4l1.8 2h6.3a1 1 0 011 1V14a1 1 0 01-1 1h-11a1 1 0 01-1-1z"/>',
  file: '<path d="M5 3.5h6l3.5 3.5V16a.5.5 0 01-.5.5H5a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/><path d="M11 3.5V7h3.5"/>',
  image: '<rect x="3.5" y="4" width="13" height="12" rx="1"/><circle cx="7" cy="8" r="1.3"/><path d="M4 14.5l3.5-3.5 3 3 2-2L16 15"/>',
  text: '<path d="M5 3.5h10V16a.5.5 0 01-.5.5h-9a.5.5 0 01-.5-.5V4a.5.5 0 01.5-.5z"/><path d="M7.5 8h5"/><path d="M7.5 11h5"/><path d="M7.5 14h3"/>',
  archive: '<rect x="4" y="4.5" width="12" height="11" rx="1"/><path d="M10 4.5v2.5"/><path d="M8.5 7h3v2.5h-3z"/><path d="M8.5 12h3"/>',
  plus: '<path d="M10 4.5v11"/><path d="M4.5 10h11"/>',
  refresh: '<path d="M4.5 9a5.5 5.5 0 019.5-3.5"/><path d="M14 3v3.5h-3.5"/><path d="M15.5 11a5.5 5.5 0 01-9.5 3.5"/><path d="M6 17v-3.5h3.5"/>',
  upload: '<path d="M10 14V4.5"/><path d="M6.5 8L10 4.5 13.5 8"/><path d="M4 16h12"/>',
  download: '<path d="M10 4v9.5"/><path d="M6.5 10L10 13.5 13.5 10"/><path d="M4 16.5h12"/>',
  link: '<path d="M4 10h12"/><path d="M12 6.5L15.5 10 12 13.5"/>',
  release: '<path d="M16 10H4"/><path d="M8 6.5L4.5 10 8 13.5"/>',
  sync: '<path d="M5 7.5a5.5 5.5 0 019.5-2"/><path d="M14.5 3v3h-3"/><path d="M15 12.5a5.5 5.5 0 01-9.5 2"/><path d="M5.5 17v-3h3"/>',
  trash: '<path d="M4.5 6h11"/><path d="M8 6V4h4v2"/><path d="M6.5 6l.8 10h5.4l.8-10"/>',
  rename: '<path d="M3.5 15.5L11 8l2.5 2.5-7.5 7.5H3.5z"/><path d="M10 5l3 3"/>',
  copy: '<path d="M7 3.5h6l3 3v8H7z"/><path d="M4.5 6.5v10h9"/>',
  eye: '<path d="M2.8 10c0 0 2.8-5 7.2-5s7.2 5 7.2 5-2.8 5-7.2 5-7.2-5-7.2-5z"/><circle cx="10" cy="10" r="2"/>',
  globe: '<circle cx="10" cy="10" r="6.5"/><path d="M3.5 10h13"/><path d="M10 3.5c2.2 2.2 2.2 10.8 0 13"/><path d="M10 3.5c-2.2 2.2-2.2 10.8 0 13"/>',
  more: '<circle cx="5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
  check: '<path d="M4 10.5l4 4 8-9"/>',
};

function icon(name, size = 18) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}

function fileIcon(entry) {
  if (entry.type === 'dir') return icon('folder');
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(ext)) return icon('image');
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return icon('archive');
  if (['txt', 'md', 'json', 'yaml', 'yml', 'csv', 'log', 'js', 'ts', 'py', 'go', 'rs', 'html', 'css', 'sh'].includes(ext)) return icon('text');
  return icon('file');
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let payload = body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) {
    openTokenDialog(true);
    throw Object.assign(new Error('需要访问令牌'), { code: 'EUNAUTH' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), { code: data.code, hint: data.hint });
  }
  return raw ? data : data;
}

function downloadUrl(zone, p, inline = false) {
  return `/api/fs/download?zone=${zone}&path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}&token=${encodeURIComponent(state.token)}`;
}

function triggerDownload(zone, p) {
  const a = document.createElement('a');
  a.href = downloadUrl(zone, p);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ------------------------------------------------------------------ */
/* Toast                                                              */
/* ------------------------------------------------------------------ */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 3200);
}

/* ------------------------------------------------------------------ */
/* 渲染：区域 / 用量 / 文件                                             */
/* ------------------------------------------------------------------ */

function renderZones() {
  const zones = [
    { key: 'drive', label: '网盘', desc: '只读仓库' },
    { key: 'workspace', label: '工作区', desc: 'AI 可写' },
  ];
  $('#zones').innerHTML = zones
    .map((z) => {
      const stat = state.stats?.zones?.[z.key];
      const meta = stat ? `${stat.files} 文件` : '';
      return `<button class="zone ${state.zone === z.key ? 'on' : ''}" data-zone="${z.key}">
        <span class="zicon">${icon(z.key)}</span>
        <span class="ztext"><span class="zlabel">${z.label}</span><span class="zmeta">${z.desc}</span></span>
        <span class="zmeta">${meta}</span>
      </button>`;
    })
    .join('');
}

function renderUsage() {
  const usage = $('#usage');
  if (!state.stats) {
    usage.innerHTML = '';
    return;
  }
  const d = state.stats.zones.drive;
  const w = state.stats.zones.workspace;
  usage.innerHTML = `
    <div class="usage-row"><span>网盘占用</span><b>${formatBytes(d.bytes)}</b></div>
    <div class="usage-row"><span>工作区占用</span><b>${formatBytes(w.bytes)}</b></div>
    <div class="usage-row usage-shared"><span>共用一份</span><b>${state.stats.shared.files} 个文件</b></div>
    ${state.stats.diverged.files ? `<div class="usage-row"><span>已分叉</span><b>${state.stats.diverged.files} 个文件</b></div>` : ''}
  `;
}

function renderCrumbs() {
  const parts = state.path ? state.path.split('/') : [];
  const pieces = [`<button class="root" data-crumb="-1">${ZONE_LABEL[state.zone]}</button>`];
  parts.forEach((part, index) => {
    pieces.push(`<span class="sep">/</span><button data-crumb="${index}">${escapeHtml(part)}</button>`);
  });
  if (state.searching) {
    pieces.push(`<span class="sep">·</span><span class="zmeta" style="color:var(--muted)">搜索「${escapeHtml(state.query)}」</span>`);
  }
  $('#crumbs').innerHTML = pieces.join('');
}

function statePill(entry) {
  const cls = entry.state === 'shared' ? 'shared' : entry.state === 'diverged' ? 'diverged' : '';
  const label = entry.state === 'shared' ? '共用' : entry.state === 'diverged' ? '已分叉' : `仅${ZONE_LABEL[state.zone]}`;
  return `<span class="state ${cls}" title="${STATE_TITLE[entry.state] || ''}">${label}</span>`;
}

function renderFiles() {
  const files = $('#files');
  if (state.entries.length === 0) {
    const text = state.searching
      ? ['没有匹配的文件', '换个关键词，或清除搜索回到目录浏览。']
      : state.zone === 'drive'
        ? ['网盘是只读仓库', '上传文件，或让 AI 通过 MCP / ACP 把网盘文件移进工作区后再改写。']
        : ['工作区是 AI 的操作台', '把网盘文件移到这里，AI 就能直接读写。改完可以写回网盘或发布。'];
    files.innerHTML = `<div class="empty">
      <div class="big">${text[0]}</div>
      <p>${text[1]}</p>
    </div>`;
    return;
  }

  files.innerHTML = state.entries
    .map((entry) => {
      const selected = state.selected.has(entry.path);
      const sub = state.searching ? `${dirname(entry.path) || '根目录'} · ${STATE_LABEL[entry.state] || ''}` : '';
      return `<div class="frow ${selected ? 'selected' : ''}" data-path="${escapeHtml(entry.path)}" data-type="${entry.type}">
        <span class="col-check"><input type="checkbox" ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(entry.name)}"></span>
        <span class="col-name">
          <span class="file-ico ${entry.type === 'dir' ? 'folder' : ''}">${fileIcon(entry)}</span>
          <span class="ntext">
            <span class="name" data-open="1">${escapeHtml(entry.name)}</span>
            ${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ''}
          </span>
        </span>
        <span class="col-state">${statePill(entry)}</span>
        <span class="col-size">${entry.type === 'dir' ? '—' : formatBytes(entry.size)}</span>
        <span class="col-time">${entry.mtime ? fileTime(entry.mtime) : '—'}</span>
        <span class="col-more"><button class="more-btn" data-more="1" aria-label="更多操作">···</button></span>
      </div>`;
    })
    .join('');

  const selectAll = $('#selectAll');
  selectAll.checked = state.entries.every((e) => state.selected.has(e.path)) && state.entries.length > 0;
}

function selectedEntries() {
  return state.entries.filter((e) => state.selected.has(e.path));
}

function renderBulk() {
  const bulk = $('#bulk');
  const count = state.selected.size;
  bulk.hidden = count === 0;
  if (count === 0) return;

  $('#bulkCount').textContent = `已选 ${count} 项`;
  const entries = selectedEntries();
  const anyDiverged = entries.some((e) => e.state === 'diverged');
  const singleFile = entries.length === 1 && entries[0].type === 'file';
  const buttons = [];

  if (state.zone === 'drive') {
    buttons.push({ act: 'link', label: '移到工作区', cls: 'primary' });
    if (singleFile) buttons.push({ act: 'download', label: '下载' });
    buttons.push({ act: 'rename', label: '重命名' });
    buttons.push({ act: 'delete', label: '删除', cls: 'danger' });
  } else {
    buttons.push({ act: 'publish', label: '发布到网盘', cls: 'primary' });
    if (anyDiverged) buttons.push({ act: 'sync', label: '写回网盘' });
    buttons.push({ act: 'release', label: '退回网盘' });
    if (singleFile) buttons.push({ act: 'download', label: '下载' });
    buttons.push({ act: 'rename', label: '重命名' });
    buttons.push({ act: 'delete', label: '删除', cls: 'danger' });
  }

  $('#bulkActions').innerHTML = buttons
    .map((b) => `<button class="btn sm ${b.cls === 'primary' ? 'primary' : b.cls === 'danger' ? 'danger' : 'ghost'}" data-bulk="${b.act}">${b.label}</button>`)
    .join('');
}

/* ------------------------------------------------------------------ */
/* 渲染：AI 动态                                                       */
/* ------------------------------------------------------------------ */

function feedTitleFor(action, items, fallback) {
  const n = items.length;
  const first = items[0];
  const name = first?.path?.split('/').pop() || '';
  if (n > 1) {
    if (action === 'read') return `读取了 ${n} 个文件`;
    if (action === 'download') return `下载了 ${n} 个文件`;
  }
  return fallback;
}

function renderFeed() {
  const box = $('#events');
  let events = state.events;
  if (state.filter !== 'all') {
    events = events.filter((e) => e.actor === state.filter);
  }

  const cards = [];
  for (const ev of events) {
    const last = cards[cards.length - 1];
    const mergeable = last
      && last.action === ev.action
      && last.actor === ev.actor
      && (ev.action === 'read' || ev.action === 'download')
      && Math.abs(last.ts - ev.ts) < 10 * 60 * 1000
      && last.items.length < 12;
    if (mergeable) {
      last.items.push(...ev.items);
      last.ts = Math.max(last.ts, ev.ts);
      last.title = feedTitleFor(ev.action, last.items, last.title);
      last.merged += 1;
    } else {
      cards.push({ ...ev, items: [...ev.items], merged: 0 });
    }
  }

  if (cards.length === 0) {
    box.innerHTML = `<div class="feed-empty">AI 还没有动手。<br>接好 MCP / ACP 后，它的每一次读写都会在这里变成一句话。</div>`;
  } else {
    box.innerHTML = cards
      .map((card) => {
        const chips = card.items.slice(0, 6)
          .map((item) => `<button class="chip" data-goto-zone="${item.zone}" data-goto-path="${escapeHtml(item.path)}" title="${escapeHtml(item.path)}">${escapeHtml(basename(item.path))}</button>`)
          .join('');
        const more = card.items.length > 6 ? `<span class="chip more">+${card.items.length - 6}</span>` : '';
        const note = card.items.find((i) => i.note)?.note;
        return `<article class="event">
          <div class="event-top">
            <span class="actor ${card.actor}">${ACTOR_LABEL[card.actor] || card.actor}</span>
            <span class="event-time" title="${new Date(card.ts).toLocaleString('zh-CN')}">${timeAgo(card.ts)}</span>
          </div>
          <p class="event-title">${escapeHtml(card.title)}</p>
          <div class="chips">${chips}${more}</div>
          ${note ? `<div class="event-note">${escapeHtml(note)}</div>` : ''}
        </article>`;
      })
      .join('');
  }

  const dayEvents = state.events.filter((e) => e.actor === 'ai' && Date.now() - e.ts < 86400000);
  const touched = new Set();
  dayEvents.forEach((e) => e.items.forEach((i) => touched.add(`${i.zone}:${i.path}`)));
  $('#feedSum').textContent = dayEvents.length
    ? `过去 24 小时，AI 操作 ${dayEvents.length} 次，涉及 ${touched.size} 个文件`
    : '过去 24 小时，AI 暂无动作';
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                           */
/* ------------------------------------------------------------------ */

async function loadState() {
  const data = await api('/api/state');
  state.stats = data;
  renderZones();
  renderUsage();
}

async function loadList() {
  if (state.searching && state.query) {
    const data = await api(`/api/fs/search?zone=${state.zone}&path=${encodeURIComponent(state.path)}&q=${encodeURIComponent(state.query)}`);
    state.entries = data.entries;
  } else {
    const data = await api(`/api/fs/list?zone=${state.zone}&path=${encodeURIComponent(state.path)}`);
    state.entries = data.entries;
  }
  state.selected = new Set(Array.from(state.selected).filter((p) => state.entries.some((e) => e.path === p)));
  renderCrumbs();
  renderFiles();
  renderBulk();
}

async function loadEvents() {
  const data = await api('/api/activity?limit=120');
  state.events = data.events || [];
  renderFeed();
}

async function refreshAll() {
  try {
    await loadState();
    await loadList();
    await loadEvents();
    connectStream();
    setConn('on', '已连接');
  } catch (err) {
    if (err.code !== 'EUNAUTH') toast(err.message, 'err');
  }
}

const scheduleTreeRefresh = debounce(async () => {
  try {
    await loadState();
    await loadList();
  } catch {
    /* 静默 */
  }
}, 700);

/* ------------------------------------------------------------------ */
/* 底部面板（预览 / 表单）                                              */
/* ------------------------------------------------------------------ */

let sheetPrimary = null;
let sheetOpenTimer = null;

function openSheet({ title, meta = '', body = '', foot = '', wide = false, primary = null }) {
  $('#sheetTitle').textContent = title;
  $('#sheetMeta').innerHTML = meta;
  $('#sheetBody').innerHTML = body;
  $('#sheetFoot').innerHTML = foot;
  $('#sheet').classList.toggle('wide', wide);
  sheetPrimary = primary;
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
  clearTimeout(sheetOpenTimer);
}

function closeSheet() {
  const sheet = $('#sheet');
  sheet.classList.remove('open');
  $('#scrim').hidden = true;
  sheetPrimary = null;
  clearTimeout(sheetOpenTimer);
  sheetOpenTimer = setTimeout(() => {
    sheet.hidden = true;
    $('#sheetBody').innerHTML = '';
    $('#sheetFoot').innerHTML = '';
  }, 280);
}

/* ------------------------------------------------------------------ */
/* 预览                                                               */
/* ------------------------------------------------------------------ */

async function openPreview(entry) {
  if (entry.type === 'dir') return enterDir(entry.path);

  const zone = state.zone;
  const meta = [
    ZONE_LABEL[zone],
    formatBytes(entry.size),
    entry.mtime ? fileTime(entry.mtime) : '',
    entry.state === 'shared' ? '与另一区域共用一份' : entry.state === 'diverged' ? '两个区域已分叉' : '',
  ].filter(Boolean).join(' · ');

  openSheet({
    title: entry.name,
    meta,
    body: '<div class="preview-note">正在读取…</div>',
    foot: '<button class="btn ghost" data-sheet="close">关闭</button>',
  });

  try {
    const data = await api(`/api/fs/preview?zone=${zone}&path=${encodeURIComponent(entry.path)}`);
    let body = '';
    if (data.kind === 'text') {
      body = `<pre class="preview-text">${escapeHtml(data.text)}</pre>`;
      if (data.truncated) body += `<div class="event-note" style="margin-top:8px">文件较大，仅显示前 ${formatBytes(data.limit)}，共 ${formatBytes(data.size)}。下载可拿到完整内容。</div>`;
    } else if (data.kind === 'image') {
      body = `<img class="preview-image" src="${downloadUrl(zone, entry.path, true)}" alt="${escapeHtml(entry.name)}">`;
    } else {
      body = `<div class="preview-note">这是二进制文件（${formatBytes(data.size)}），无法直接预览。<br>可以下载到本地打开。</div>`;
    }

    const buttons = [`<button class="btn ghost" data-sheet="download" data-zone="${zone}" data-path="${escapeHtml(entry.path)}">下载</button>`];
    if (zone === 'drive') {
      buttons.push(`<button class="btn ghost" data-sheet="link" data-zone="${zone}" data-path="${escapeHtml(entry.path)}">移到工作区</button>`);
    } else {
      if (entry.state === 'only') {
        buttons.push(`<button class="btn ghost" data-sheet="publish" data-zone="${zone}" data-path="${escapeHtml(entry.path)}">发布到网盘</button>`);
      }
      buttons.push(`<button class="btn ghost" data-sheet="sync" data-zone="${zone}" data-path="${escapeHtml(entry.path)}">写回网盘</button>`);
      buttons.push(`<button class="btn ghost" data-sheet="release" data-zone="${zone}" data-path="${escapeHtml(entry.path)}">退回网盘</button>`);
    }
    buttons.push('<button class="btn primary" data-sheet="close">完成</button>');

    openSheet({ title: entry.name, meta, body, foot: buttons.join('') });
  } catch (err) {
    openSheet({
      title: entry.name,
      meta,
      body: `<div class="preview-note">${escapeHtml(err.message)}</div>`,
      foot: '<button class="btn primary" data-sheet="close">关闭</button>',
    });
  }
}

/* ------------------------------------------------------------------ */
/* 目录导航                                                           */
/* ------------------------------------------------------------------ */

async function enterDir(rel) {
  state.path = rel;
  state.searching = false;
  state.query = '';
  $('#search').value = '';
  state.selected = new Set();
  await loadList();
}

async function gotoItem(zone, p) {
  const exists = await (async () => {
    if (zone === state.zone && dirname(p) === state.path) return true;
    return false;
  })();
  state.zone = zone;
  state.path = dirname(p);
  state.searching = false;
  state.query = '';
  $('#search').value = '';
  state.selected = new Set();
  renderZones();
  await loadList();
  const row = $(`#files .frow[data-path="${CSS.escape(p)}"]`);
  if (row) {
    row.classList.add('flash');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (!exists) {
    toast('该文件已不在这个区域');
  }
}

/* ------------------------------------------------------------------ */
/* 选择                                                               */
/* ------------------------------------------------------------------ */

function toggleSelect(p, force) {
  const shouldSelect = force ?? !state.selected.has(p);
  if (shouldSelect) state.selected.add(p);
  else state.selected.delete(p);
  const row = $(`#files .frow[data-path="${CSS.escape(p)}"]`);
  if (row) {
    row.classList.toggle('selected', shouldSelect);
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = shouldSelect;
  }
  renderBulk();
}

function clearSelection() {
  state.selected = new Set();
  document.querySelectorAll('#files .frow.selected').forEach((row) => row.classList.remove('selected'));
  document.querySelectorAll('#files input[type="checkbox"]').forEach((box) => { box.checked = false; });
  const all = $('#selectAll');
  if (all) all.checked = false;
  renderBulk();
}

/* ------------------------------------------------------------------ */
/* 行操作菜单                                                          */
/* ------------------------------------------------------------------ */

let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

function showMenu(anchor, entry) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';

  const items = [['预览', 'preview']];
  if (entry.type === 'file') items.push(['下载', 'download']);
  if (state.zone === 'drive') items.push(['移到工作区', 'link']);
  else {
    if (entry.state === 'only') items.push(['发布到网盘', 'publish']);
    items.push(['写回网盘', 'sync']);
    items.push(['退回网盘', 'release']);
  }
  items.push(['重命名', 'rename']);
  items.push(['删除', 'delete']);

  menu.innerHTML = items
    .map(([label, act]) => `<button data-act="${act}" class="${act === 'delete' ? 'danger' : ''}">${label}</button>`)
    .join('');

  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 240)}px`;
  menu.style.left = `${Math.min(rect.left - 140, window.innerWidth - 196)}px`;
  document.body.appendChild(menu);
  openMenu = menu;
  state.menuEntry = entry;
}

/* ------------------------------------------------------------------ */
/* 操作                                                               */
/* ------------------------------------------------------------------ */

async function reportResults(results, label) {
  const ok = results.filter((r) => r.ok);
  const fails = results.filter((r) => !r.ok);
  if (fails.length === 0) {
    toast(`${label} ${ok.length} 项`, 'ok');
  } else {
    toast(`${label} ${ok.length} 项，${fails.length} 项失败：${fails[0].message}`, 'err');
  }
}

async function afterMutation() {
  await loadState();
  await loadList();
}

async function doLink(paths) {
  try {
    const data = await api('/api/fs/link', { method: 'POST', body: { paths } });
    await reportResults(data.results, '移到工作区');
    await afterMutation();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doPublish(paths) {
  try {
    const data = await api('/api/fs/publish', { method: 'POST', body: { paths } });
    await reportResults(data.results, '发布到网盘');
    await afterMutation();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doSync(paths) {
  try {
    const data = await api('/api/fs/sync', { method: 'POST', body: { paths } });
    await reportResults(data.results, '写回网盘');
    await afterMutation();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doRelease(paths) {
  try {
    const data = await api('/api/fs/release', { method: 'POST', body: { paths } });
    await reportResults(data.results, '退回网盘');
    await afterMutation();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function doDelete(paths, purge = false) {
  try {
    const data = await api('/api/fs/delete', { method: 'POST', body: { zone: state.zone, paths, purge } });
    await reportResults(data.results, '删除');
    clearSelection();
    await afterMutation();
  } catch (err) {
    toast(err.message, 'err');
  }
}

let pendingDelete = [];

function confirmDelete(entries) {
  pendingDelete = entries;
  const shared = entries.filter((e) => e.state === 'shared');
  const body = `
    ${shared.length
      ? `<div class="danger-note">其中有 ${shared.length} 项与另一个区域共用同一份数据。默认只删除${ZONE_LABEL[state.zone]}的视图，文件内容仍会保留在${ZONE_LABEL[state.zone === 'drive' ? 'workspace' : 'drive']}。</div>`
      : '<p class="event-note">删除后不可恢复。</p>'}
    <div class="chips" style="margin-top:10px">${entries.slice(0, 8).map((e) => `<span class="chip">${escapeHtml(e.name)}</span>`).join('')}${entries.length > 8 ? `<span class="chip more">+${entries.length - 8}</span>` : ''}</div>
  `;
  const foot = `
    ${shared.length ? '<button class="btn ghost" data-sheet="delete-purge">连同另一区域一起删除</button>' : ''}
    <button class="btn ghost" data-sheet="close">取消</button>
    <button class="btn danger" data-sheet="delete-confirm">仅删除当前视图</button>
  `;
  openSheet({
    title: `删除 ${entries.length} 项？`,
    meta: `当前区域：${ZONE_LABEL[state.zone]}`,
    body,
    foot,
    primary: () => doDelete(entries.map((e) => e.path)),
  });
}

/* ------------------------------------------------------------------ */
/* 批量重命名                                                          */
/* ------------------------------------------------------------------ */

function openRename(entries) {
  if (!entries.length) return;

  const body = `
    <div class="field"><label>查找文本</label><input type="text" id="rnFind" placeholder="留空则不替换" spellcheck="false"></div>
    <div class="field"><label>替换为</label><input type="text" id="rnReplace" placeholder="留空则删除匹配文本" spellcheck="false"></div>
    <div class="field"><label>前缀 / 后缀</label>
      <div style="display:flex;gap:8px"><input type="text" id="rnPrefix" placeholder="前缀" spellcheck="false"><input type="text" id="rnSuffix" placeholder="后缀（保留扩展名）" spellcheck="false"></div>
    </div>
    <div class="rename-preview" id="rnPreview"></div>
    <div class="event-note" id="rnHint" style="margin-top:8px"></div>
  `;
  const foot = `
    <button class="btn ghost" data-sheet="close">取消</button>
    <button class="btn primary" data-sheet="rename-apply" id="rnApply">应用改名</button>
  `;
  openSheet({
    title: `重命名 ${entries.length} 项`,
    meta: '只改文件名，保留原目录；网盘与工作区的视图会一起改名。',
    body,
    foot,
    wide: true,
  });

  const find = $('#rnFind');
  const replace = $('#rnReplace');
  const prefix = $('#rnPrefix');
  const suffix = $('#rnSuffix');
  const preview = $('#rnPreview');
  const hint = $('#rnHint');

  const buildMapping = () => {
    return entries.map((entry) => {
      const oldName = entry.name;
      const dot = oldName.lastIndexOf('.');
      const hasExt = dot > 0 && entry.type === 'file';
      const stem = hasExt ? oldName.slice(0, dot) : oldName;
      const ext = hasExt ? oldName.slice(dot) : '';
      let nextStem = stem;
      const needle = find.value;
      if (needle) nextStem = nextStem.split(needle).join(replace.value);
      nextStem = prefix.value + nextStem + suffix.value;
      const nextName = nextStem + ext;
      const dir = dirname(entry.path);
      return { entry, from: entry.path, to: dir ? `${dir}/${nextName}` : nextName, oldName, nextName };
    });
  };

  const update = () => {
    const mapping = buildMapping();
    const names = new Set();
    let bad = false;
    preview.innerHTML = mapping
      .map((m) => {
        let invalid = '';
        if (!m.nextName.trim()) invalid = '名称不能为空';
        else if (m.nextName.includes('/')) invalid = '名称不能包含斜杠';
        else if (names.has(m.to)) invalid = '与本次改名重复';
        else if (m.nextName === m.oldName) invalid = '';
        names.add(m.to);
        if (invalid) bad = true;
        return `<div class="rename-row ${invalid ? 'bad' : ''}">
          <span class="old">${escapeHtml(m.oldName)}</span>
          <span class="arrow">→</span>
          <span class="new">${escapeHtml(m.nextName || '（空）')}${invalid ? ` · ${invalid}` : ''}</span>
        </div>`;
      })
      .join('');
    hint.textContent = bad ? '有无效名称，请调整后再应用。' : '只改名，不修改文件内容。';
    $('#rnApply').disabled = bad;
  };

  [find, replace, prefix, suffix].forEach((input) => input.addEventListener('input', update));
  update();

  sheetPrimary = async () => {
    const mapping = buildMapping().filter((m) => m.from !== m.to);
    if (mapping.length === 0) {
      closeSheet();
      return;
    }
    try {
      const data = await api('/api/fs/rename', {
        method: 'POST',
        body: { zone: state.zone, items: mapping.map((m) => ({ from: m.from, to: m.to })) },
      });
      toast(`已重命名 ${data.renamed.length} 项`, 'ok');
      clearSelection();
      closeSheet();
      await afterMutation();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ------------------------------------------------------------------ */
/* 新建文件夹                                                          */
/* ------------------------------------------------------------------ */

function openNewFolder() {
  const base = state.path;
  const body = `
    <div class="field">
      <label>文件夹名称</label>
      <input type="text" id="folderName" placeholder="例如 素材 / 2026-10" spellcheck="false">
    </div>
    <div class="event-note">将创建在 ${ZONE_LABEL[state.zone]} / ${escapeHtml(base || '根目录')}</div>
  `;
  openSheet({
    title: '新建文件夹',
    meta: ZONE_LABEL[state.zone],
    body,
    foot: '<button class="btn ghost" data-sheet="close">取消</button><button class="btn primary" data-sheet="folder-create">创建</button>',
  });
  const input = $('#folderName');
  input.focus();
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return toast('请填写文件夹名称', 'err');
    try {
      await api('/api/fs/folder', { method: 'POST', body: { zone: state.zone, path: base ? `${base}/${name}` : name } });
      closeSheet();
      toast('文件夹已创建', 'ok');
      await afterMutation();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  sheetPrimary = submit;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

/* ------------------------------------------------------------------ */
/* 令牌与接入信息                                                      */
/* ------------------------------------------------------------------ */

function openTokenDialog(forced = false) {
  const body = `
    <div class="field">
      <label>访问令牌</label>
      <input type="password" id="tokenInput" value="${escapeHtml(state.token)}" placeholder="wharf_..." spellcheck="false">
      <div class="desc">令牌在容器日志（docker logs wharf）或数据目录的 <code>.token</code> 文件中。Web、REST、MCP、ACP 使用同一个令牌。</div>
    </div>
    ${forced ? '<div class="danger-note">需要有效的访问令牌才能读取文件与动态。</div>' : ''}
  `;
  openSheet({
    title: '访问令牌',
    meta: 'Bearer Token',
    body,
    foot: '<button class="btn ghost" data-sheet="close">取消</button><button class="btn primary" data-sheet="token-save">保存并连接</button>',
  });
  const input = $('#tokenInput');
  input.focus();
  const save = () => {
    const token = input.value.trim();
    if (!token) return toast('令牌不能为空', 'err');
    state.token = token;
    localStorage.setItem('wharf_token', token);
    closeSheet();
    stopStream();
    refreshAll();
  };
  sheetPrimary = save;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
}

function openAccess() {
  const base = state.stats?.baseUrl || location.origin;
  const token = state.token;
  const body = `
    <p class="event-note" style="margin-bottom:12px">网盘只读、工作区可写。AI 通过下面任一协议接入；所有请求都带同一个 Bearer 令牌。</p>

    <div class="field" style="margin-bottom:10px"><label>MCP（Streamable HTTP）</label></div>
    <div class="copy-line"><div class="code">${escapeHtml(base)}/mcp</div><button class="btn ghost sm" data-sheet="copy" data-copy="${escapeHtml(base)}/mcp">复制</button></div>

    <div class="field" style="margin:16px 0 10px"><label>ACP · JSON-RPC</label></div>
    <div class="copy-line"><div class="code">${escapeHtml(base)}/acp</div><button class="btn ghost sm" data-sheet="copy" data-copy="${escapeHtml(base)}/acp">复制</button></div>

    <div class="field" style="margin:16px 0 10px"><label>ACP · REST（agents / runs）</label></div>
    <div class="copy-line"><div class="code">POST ${escapeHtml(base)}/acp/agents/wharf-workspace/runs</div><button class="btn ghost sm" data-sheet="copy" data-copy="POST ${escapeHtml(base)}/acp/agents/wharf-workspace/runs">复制</button></div>

    <div class="field" style="margin:16px 0 10px"><label>访问令牌</label></div>
    <div class="copy-line"><div class="code">${escapeHtml(token)}</div><button class="btn ghost sm" data-sheet="copy" data-copy="${escapeHtml(token)}">复制</button></div>

    <div class="field" style="margin:18px 0 0"><label>MCP 客户端配置</label></div>
    <div class="code">${escapeHtml(`{
  "mcpServers": {
    "wharf": {
      "type": "http",
      "url": "${base}/mcp",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`)}</div>

    <div class="field" style="margin:18px 0 0"><label>ACP REST 调用示例</label></div>
    <div class="code">${escapeHtml(`curl -X POST ${base}/acp/agents/wharf-workspace/runs \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"input":{"tool":"list_items","args":{"zone":"workspace"}}}'`)}</div>

    <div class="field" style="margin:18px 0 10px"><label>给 AI 的接入提示词</label></div>
    <div class="copy-line"><div class="code">复制后直接粘给 agent，它会自己连上来并遵守工作区规则</div><button class="btn ghost sm" data-sheet="copy" data-copy="${escapeHtml(agentPrompt(base, token))}">复制提示词</button></div>
  `;

  openSheet({
    title: '接入信息',
    meta: 'MCP · ACP · REST',
    body,
    foot: '<button class="btn primary" data-sheet="close">知道了</button>',
    wide: true,
  });
}

function agentPrompt(base, token) {
  return `你是 Wharf 网盘的 AI 操作员，通过 MCP 接入。

连接：
- MCP 端点 ${base}/mcp
- 请求头 Authorization: Bearer ${token}

先调用 vault_overview 看现状，然后按下面的规矩工作：
1. 网盘（zone=drive）只读。要修改任何文件，先 move_to_workspace 把它链接进工作区。
2. 所有写入只发生在 zone=workspace，write_file 不能写网盘。
3. 删除默认只删当前区域视图；除非我明确说“彻底删除”，不要用 purge。
4. 批量操作一次传多个 paths/items，不要逐条循环。
5. 收工前：新成果用 publish_to_drive，改过的网盘文件用 sync_to_drive；不确定的草稿先留下。
6. 每步用一句中文说明改了什么、在哪、怎么撤回；不确定路径时先 list_items / stat_item，不要猜。

我的任务：<在这里写你要做的事>`;
}

/* ------------------------------------------------------------------ */
/* 上传                                                               */
/* ------------------------------------------------------------------ */

function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'urow';
    row.innerHTML = `
      <span class="uname">${escapeHtml(file.name)}</span>
      <span class="ubar"><i></i></span>
      <span class="ustat">0%</span>
    `;
    $('#uploads').appendChild(row);
    const bar = row.querySelector('.ubar i');
    const stat = row.querySelector('.ustat');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/fs/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      bar.style.width = `${pct}%`;
      stat.textContent = `${pct}%`;
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      const result = data.results?.[0];
      if (xhr.status >= 200 && xhr.status < 300 && result?.ok) {
        bar.style.width = '100%';
        stat.textContent = '完成';
        setTimeout(() => row.remove(), 2600);
      } else {
        row.classList.add('fail');
        bar.style.width = '100%';
        stat.textContent = '失败';
        toast(data.error || result?.message || `上传失败（${xhr.status}）`, 'err');
      }
      afterMutation();
    };
    xhr.onerror = () => {
      row.classList.add('fail');
      stat.textContent = '失败';
      toast('上传中断', 'err');
    };

    const form = new FormData();
    form.append('zone', state.zone);
    form.append('dir', state.path);
    form.append('files', file);
    xhr.send(form);
  }
}

/* ------------------------------------------------------------------ */
/* 实时流                                                             */
/* ------------------------------------------------------------------ */

function setConn(kind, text) {
  const conn = $('#conn');
  conn.classList.toggle('on', kind === 'on');
  conn.classList.toggle('off', kind === 'off');
  $('#connText').textContent = text;
  $('#liveDot').style.opacity = kind === 'on' ? '1' : '0.4';
}

function stopStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function connectStream() {
  stopStream();
  if (!state.token) return;

  try {
    const es = new EventSource(`/api/activity/stream?token=${encodeURIComponent(state.token)}`);
    state.stream = es;
    es.onopen = () => {
      state.streamErrors = 0;
      setConn('on', '已连接');
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    };
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (state.events.some((e) => e.id === payload.id)) return;
        state.events.unshift(payload);
        if (state.events.length > 200) state.events.length = 200;
        renderFeed();
        if (payload.actor !== 'ui') scheduleTreeRefresh();
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      state.streamErrors += 1;
      setConn('off', '重连中');
      if (state.streamErrors >= 2) {
        stopStream();
        setConn('off', '轮询中');
        state.pollTimer = setInterval(async () => {
          try {
            await loadEvents();
            setConn('off', '轮询中');
          } catch {
            /* ignore */
          }
        }, 8000);
      }
    };
  } catch {
    setConn('off', '离线');
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

function bind() {
  $('#zones').addEventListener('click', async (event) => {
    const button = event.target.closest('.zone');
    if (!button) return;
    const zone = button.dataset.zone;
    if (zone === state.zone) return;
    state.zone = zone;
    state.path = '';
    state.searching = false;
    state.query = '';
    $('#search').value = '';
    clearSelection();
    renderZones();
    renderCrumbs();
    await loadList();
  });

  $('#crumbs').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-crumb]');
    if (!button) return;
    const index = Number(button.dataset.crumb);
    state.searching = false;
    state.query = '';
    $('#search').value = '';
    state.path = index < 0 ? '' : state.path.split('/').slice(0, index + 1).join('/');
    clearSelection();
    await loadList();
  });

  $('#files').addEventListener('click', (event) => {
    const row = event.target.closest('.frow');
    if (!row) return;
    const entry = state.entries.find((e) => e.path === row.dataset.path);
    if (!entry) return;

    if (event.target.closest('.more-btn')) {
      showMenu(event.target.closest('.more-btn'), entry);
      return;
    }
    if (event.target.closest('input[type="checkbox"]')) {
      toggleSelect(entry.path, event.target.checked);
      return;
    }
    if (event.target.closest('.name')) {
      if (entry.type === 'dir') enterDir(entry.path);
      else openPreview(entry);
      return;
    }
    if (event.target.closest('.frow')) {
      toggleSelect(entry.path);
    }
  });

  $('#selectAll').addEventListener('change', (event) => {
    if (event.target.checked) {
      state.entries.forEach((e) => state.selected.add(e.path));
    } else {
      state.selected.clear();
    }
    renderFiles();
    renderBulk();
  });

  $('#bulkActions').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-bulk]');
    if (!button) return;
    const act = button.dataset.bulk;
    const entries = selectedEntries();
    if (!entries.length) return;
    const paths = entries.map((e) => e.path);

    if (act === 'link') return doLink(paths);
    if (act === 'publish') return doPublish(paths);
    if (act === 'sync') return doSync(paths);
    if (act === 'release') return doRelease(paths);
    if (act === 'download') return triggerDownload(state.zone, paths[0]);
    if (act === 'rename') return openRename(entries);
    if (act === 'delete') return confirmDelete(entries);
  });

  $('#btnRefresh').addEventListener('click', async () => {
    await loadState();
    await loadList();
    await loadEvents();
    toast('已刷新', 'ok');
  });

  $('#btnNewFolder').addEventListener('click', () => openNewFolder());
  $('#btnToken').addEventListener('click', () => openTokenDialog(false));
  $('#btnAccess').addEventListener('click', () => openAccess());
  $('#btnUpload').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (event) => {
    uploadFiles(event.target.files);
    event.target.value = '';
  });

  $('#btnFeedToggle').addEventListener('click', () => {
    state.feedOpen = !state.feedOpen;
    $('#feed').classList.toggle('show', state.feedOpen);
    $('.app').classList.toggle('feed-open', state.feedOpen);
    if (state.feedOpen) $('#events').scrollTop = 0;
  });

  $('#filters').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b === button));
    renderFeed();
  });

  $('#events').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip[data-goto-path]');
    if (!chip) return;
    gotoItem(chip.dataset.gotoZone, chip.dataset.gotoPath);
  });

  const searchInput = $('#search');
  searchInput.addEventListener('input', debounce(async () => {
    const value = searchInput.value.trim();
    state.query = value;
    state.searching = Boolean(value);
    if (!value) {
      await loadList();
      return;
    }
    await loadList();
  }, 320));

  $('#scrim').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);

  $('#sheetFoot').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-sheet]');
    if (!button) return;
    const action = button.dataset.sheet;
    if (action === 'close') return closeSheet();
    if (action === 'download') return triggerDownload(button.dataset.zone, button.dataset.path);
    if (action === 'copy') {
      copyText(button.dataset.copy).then(() => toast('已复制', 'ok')).catch(() => toast('复制失败', 'err'));
      return;
    }
    if (action === 'link') {
      closeSheet();
      return doLink([button.dataset.path]);
    }
    if (action === 'publish') {
      closeSheet();
      return doPublish([button.dataset.path]);
    }
    if (action === 'sync') {
      closeSheet();
      return doSync([button.dataset.path]);
    }
    if (action === 'release') {
      closeSheet();
      return doRelease([button.dataset.path]);
    }
    if (action === 'delete-confirm') {
      const entries = pendingDelete.slice();
      pendingDelete = [];
      closeSheet();
      return doDelete(entries.map((e) => e.path), false);
    }
    if (action === 'delete-purge') {
      const entries = pendingDelete.slice();
      pendingDelete = [];
      closeSheet();
      return doDelete(entries.map((e) => e.path), true);
    }
    if (action === 'rename-apply') {
      if (sheetPrimary) sheetPrimary();
      return;
    }
    if (action === 'folder-create') {
      if (sheetPrimary) sheetPrimary();
      return;
    }
    if (action === 'token-save') {
      if (sheetPrimary) sheetPrimary();
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu') && !event.target.closest('.more-btn')) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      if (!$('#sheet').hidden) closeSheet();
    }
  });

  window.addEventListener('resize', closeMenu);

  // 拖拽上传
  const main = $('.main');
  let dragDepth = 0;
  main.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepth += 1;
    main.classList.add('dragging');
  });
  main.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
  });
  main.addEventListener('dragleave', () => {
    dragDepth -= 1;
    if (dragDepth <= 0) {
      dragDepth = 0;
      main.classList.remove('dragging');
    }
  });
  main.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    main.classList.remove('dragging');
    if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
  });

  // 点击菜单项
  document.body.addEventListener('click', (event) => {
    const button = event.target.closest('.menu button[data-act]');
    if (!button) return;
    const entry = state.menuEntry;
    const act = button.dataset.act;
    closeMenu();
    if (!entry) return;

    if (act === 'preview') return openPreview(entry);
    if (act === 'download') return triggerDownload(state.zone, entry.path);
    if (act === 'link') return doLink([entry.path]);
    if (act === 'publish') return doPublish([entry.path]);
    if (act === 'sync') return doSync([entry.path]);
    if (act === 'release') return doRelease([entry.path]);
    if (act === 'rename') return openRename([entry]);
    if (act === 'delete') return confirmDelete([entry]);
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  // 支持用 ?token=... 的链接直接打开，令牌只留在本机，地址栏随即抹掉
  const fromUrl = new URLSearchParams(location.search).get('token');
  if (fromUrl) {
    state.token = fromUrl;
    try { localStorage.setItem('wharf_token', fromUrl); } catch { /* 忽略隐私模式限制 */ }
    const clean = location.pathname + (() => {
      const q = new URLSearchParams(location.search);
      q.delete('token');
      const s = q.toString();
      return s ? `?${s}` : '';
    })();
    history.replaceState(null, '', clean);
  }

  bind();
  renderZones();
  renderCrumbs();
  renderFiles();
  renderFeed();
  setConn('off', '未连接');

  if (!state.token) {
    openTokenDialog(true);
    return;
  }
  await refreshAll();
  setInterval(async () => {
    try {
      await loadState();
    } catch {
      /* ignore */
    }
  }, 60000);
}

boot();
