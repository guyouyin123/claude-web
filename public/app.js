const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const PAGE_SIZE = 20;
const LS_PINNED = 'claude_viewer.pinned';
const LS_FAVORITE = 'claude_viewer.favorite';

function loadIdSet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveIdSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch {}
}

const LS_TIME_RANGE = 'cv.timeRange';
const LS_TIME_FROM = 'cv.timeFrom';
const LS_TIME_TO = 'cv.timeTo';
const state = {
  allSessions: [],     // 服务端返回的原始顺序（按时间倒序）
  sessions: [],        // 经过筛选 + 置顶排序后的展示列表
  currentId: null,
  query: '',
  rendered: 0,
  filter: 'all',       // 'all' | 'pinned' | 'favorite'
  pinned: new Set(),      // 启动时从 /api/preferences 拉
  favorite: new Set(),    // 启动时从 /api/preferences 拉
  timeRange: localStorage.getItem(LS_TIME_RANGE) || 'all',
  timeFrom: localStorage.getItem(LS_TIME_FROM) || '',
  timeTo: localStorage.getItem(LS_TIME_TO) || '',
  tagLibrary: [],          // [{id, name, color}]
  selectedTagFilter: new Set(loadIdSet('cv.tagFilter')),
};

function tagById(id) {
  return state.tagLibrary.find(t => t.id === id);
}

async function loadPreferences() {
  try {
    const res = await fetch('/api/preferences');
    const data = await res.json();
    state.pinned = new Set(data.pinned || []);
    state.favorite = new Set(data.favorite || []);
  } catch (e) { console.warn('preferences 加载失败', e); }

  // 一次性迁移：若服务端为空，但旧 localStorage 还有，推到服务端
  try {
    const oldPin = JSON.parse(localStorage.getItem(LS_PINNED) || '[]');
    const oldFav = JSON.parse(localStorage.getItem(LS_FAVORITE) || '[]');
    let migrated = false;
    if (state.pinned.size === 0 && Array.isArray(oldPin) && oldPin.length) {
      state.pinned = new Set(oldPin);
      await persistPinned();
      migrated = true;
    }
    if (state.favorite.size === 0 && Array.isArray(oldFav) && oldFav.length) {
      state.favorite = new Set(oldFav);
      await persistFavorite();
      migrated = true;
    }
    if (migrated) {
      localStorage.removeItem(LS_PINNED);
      localStorage.removeItem(LS_FAVORITE);
      console.log('已将浏览器本地的置顶/收藏迁移到服务端');
    }
  } catch {}
}

async function loadTagLibrary() {
  try {
    const res = await fetch('/api/tags');
    const data = await res.json();
    state.tagLibrary = data.library || [];
  } catch (e) { console.warn('tag 加载失败', e); }
}

const searchInput = $('#search');
const listEl = $('#session-list');
const statsEl = $('#stats');
const detailContent = $('#detail-content');
const emptyTip = $('#empty-tip');
const detailHeader = $('#detail-header');
const messagesEl = $('#messages');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlight(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(new RegExp(q, 'ig'), m => `<span class="highlight-match">${m}</span>`);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${dd} ${hh}:${mm}`;
}

function shortProject(p) {
  if (!p) return '';
  const home = '/Users/jeff';
  if (p.startsWith(home)) p = '~' + p.slice(home.length);
  return p;
}

function fmtTokens(n) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 1).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// Claude 4.x 系列默认 200k 上下文窗口
const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-4-7': 200000,
  'claude-opus-4-6': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-haiku-4-5': 200000,
};
const DEFAULT_CONTEXT_WINDOW = 200000;
function contextWindowFor(model) {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  // 模型 id 形如 claude-opus-4-7-20251201；只取前缀匹配
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key)) return MODEL_CONTEXT_WINDOWS[key];
  }
  return DEFAULT_CONTEXT_WINDOW;
}

async function loadSessions(q = '') {
  state.query = q;
  statsEl.textContent = '加载中...';
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (state.selectedTagFilter.size) params.set('tags', [...state.selectedTagFilter].join(','));
    const url = '/api/sessions' + (params.toString() ? '?' + params.toString() : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.allSessions = data.sessions;
    applyFilterAndSort();
  } catch (e) {
    statsEl.textContent = '加载失败: ' + e.message;
    listEl.innerHTML = `<div style="padding:20px;color:#e88078;">${escapeHtml(e.message)}</div>`;
    console.error('loadSessions error', e);
  }
}

function getTimeRangeBounds() {
  // 返回 [fromISO, toISO]，null 表示不限
  const r = state.timeRange || 'all';
  if (r === 'all') return [null, null];
  const now = new Date();
  if (r === '7d' || r === '30d' || r === '90d') {
    const days = parseInt(r, 10);
    const from = new Date(now.getTime() - days * 24 * 3600 * 1000);
    return [from.toISOString(), null];
  }
  if (r === 'custom') {
    const f = state.timeFrom ? new Date(state.timeFrom + 'T00:00:00').toISOString() : null;
    const t = state.timeTo ? new Date(state.timeTo + 'T23:59:59').toISOString() : null;
    return [f, t];
  }
  return [null, null];
}

function applyFilterAndSort() {
  let list = state.allSessions;
  if (state.filter === 'pinned') {
    list = list.filter(s => state.pinned.has(s.sessionId));
  } else if (state.filter === 'favorite') {
    list = list.filter(s => state.favorite.has(s.sessionId));
  }
  const [tFrom, tTo] = getTimeRangeBounds();
  if (tFrom || tTo) {
    list = list.filter(s => {
      const end = s.endTime || s.startTime || '';
      if (tFrom && end < tFrom) return false;
      if (tTo && end > tTo) return false;
      return true;
    });
  }
  // 置顶项永远排最前；Array.sort 是稳定排序，其余顺序不变（仍是时间倒序）
  list = list.slice().sort((a, b) => {
    const ap = state.pinned.has(a.sessionId) ? 1 : 0;
    const bp = state.pinned.has(b.sessionId) ? 1 : 0;
    return bp - ap;
  });
  state.sessions = list;
  const total = list.length;
  const totalAll = state.allSessions.length;
  const timeNote = (tFrom || tTo) ? '（时间已过滤）' : '';
  let label;
  if (state.filter !== 'all') {
    const name = state.filter === 'pinned' ? '置顶' : '收藏';
    label = `${name} ${total} 个 ${timeNote}`;
  } else if (state.query) {
    label = `匹配 ${total} 个会话 ${timeNote}`;
  } else if (tFrom || tTo) {
    label = `${total} / ${totalAll} 个会话 ${timeNote}`;
  } else {
    label = `共 ${totalAll} 个会话`;
  }
  statsEl.textContent = label.trim();
  renderList();
}

function createSessionItem(s) {
  const item = document.createElement('div');
  const isPinned = state.pinned.has(s.sessionId);
  const isFav = state.favorite.has(s.sessionId);
  const cls = ['session-item'];
  if (s.sessionId === state.currentId) cls.push('active');
  if (isPinned) cls.push('is-pinned');
  if (isFav) cls.push('is-favorite');
  item.className = cls.join(' ');
  item.dataset.id = s.sessionId;
  const nameLine = s.customName
    ? `<div class="session-name">${highlight(s.customName, state.query)}</div>`
    : '';
  const tagChips = (s.tags || []).map(tid => {
    const t = tagById(tid); if (!t) return '';
    return `<span class="tag-chip" style="background:${t.color}22;border-color:${t.color};color:${t.color};">${escapeHtml(t.name)}</span>`;
  }).join('');
  const tagsLine = tagChips ? `<div class="session-tags">${tagChips}</div>` : '';
  const t = s.tokens || null;
  let tokenLine = '';
  if (t && (t.totalInput || t.totalOutput)) {
    const win = contextWindowFor(t.model);
    const pct = win ? Math.min(100, Math.round(t.lastContextSize * 100 / win)) : 0;
    tokenLine = `
      <div class="session-tokens">
        <span title="累计输入 / 输出">累计 ${fmtTokens(t.totalInput)}↑ ${fmtTokens(t.totalOutput)}↓</span>
        <span class="ctx-bar" title="末次上下文 ${fmtTokens(t.lastContextSize)} / ${fmtTokens(win)}">
          末次 ${fmtTokens(t.lastContextSize)}
          <span class="ctx-bar-bg"><span class="ctx-bar-fill" style="width:${pct}%;"></span></span>
          <span class="ctx-bar-pct">${pct}%</span>
        </span>
      </div>
    `;
  }
  item.innerHTML = `
    <div class="session-actions">
      <div class="session-actions-left">
        <button class="icon-btn pin-btn ${isPinned ? 'on' : ''}" title="${isPinned ? '取消置顶' : '置顶'}">📌</button>
        <button class="icon-btn fav-btn ${isFav ? 'on' : ''}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '★' : '☆'}</button>
        <button class="icon-btn session-copy-btn" title="复制 /resume 命令">复制resume命令</button>
      </div>
      <div class="session-actions-right">
        <button class="icon-btn session-delete-btn" title="删除该会话（不可恢复）">删除</button>
      </div>
    </div>
    ${nameLine}
    ${tagsLine}
    <div class="session-preview">${highlight(s.titlePreview, state.query)}</div>
    <div class="session-meta">
      <span>${fmtTime(s.endTime)}</span>
      <span>${s.userMessageCount} 问 / ${s.assistantMessageCount} 答</span>
    </div>
    ${tokenLine}
  `;
  item.querySelector('.pin-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePin(s.sessionId);
  });
  item.querySelector('.fav-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleFavorite(s.sessionId);
  });
  const copyBtn = item.querySelector('.session-copy-btn');
  copyBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    copyResumeCommand(s.sessionId, copyBtn);
  });
  const delBtn = item.querySelector('.session-delete-btn');
  delBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    deleteSession(s);
  });
  item.addEventListener('click', () => selectSession(s.sessionId));
  return item;
}

async function deleteSession(s) {
  const label = s.customName || s.titlePreview.slice(0, 40);
  if (!window.confirm(`确认删除会话？此操作不可恢复，会直接删除源文件。\n\n${label}\n${s.sessionId}`)) return;
  try {
    const res = await fetch(`/api/sessions/${s.sessionId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    state.allSessions = state.allSessions.filter(x => x.sessionId !== s.sessionId);
    // 服务端的 DELETE 已经清理了 pinned/favorite，前端同步内存即可
    state.pinned.delete(s.sessionId);
    state.favorite.delete(s.sessionId);
    if (state.currentId === s.sessionId) {
      state.currentId = null;
      detailContent.hidden = true;
      emptyTip.hidden = false;
    }
    applyFilterAndSort();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

async function persistPinned() {
  try {
    await fetch('/api/preferences/pinned', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...state.pinned] }),
    });
  } catch (e) { console.warn('保存置顶失败', e); }
}

async function persistFavorite() {
  try {
    await fetch('/api/preferences/favorite', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...state.favorite] }),
    });
  } catch (e) { console.warn('保存收藏失败', e); }
}

function togglePin(id) {
  if (state.pinned.has(id)) state.pinned.delete(id);
  else state.pinned.add(id);
  applyFilterAndSort();
  persistPinned();
}

function toggleFavorite(id) {
  if (state.favorite.has(id)) state.favorite.delete(id);
  else state.favorite.add(id);
  applyFilterAndSort();
  persistFavorite();
}

async function copyResumeCommand(sessionId, btn) {
  const text = `/resume ${sessionId}`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    const original = btn.textContent;
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1200);
  } catch (e) {
    btn.textContent = '失败';
    setTimeout(() => { btn.textContent = '复制resume命令'; }, 1200);
  }
}

const LS_PROJ_EXPANDED = 'cv.projectExpanded';
state.expandedProjects = loadIdSet(LS_PROJ_EXPANDED);

function renderList() {
  listEl.innerHTML = '';
  if (!state.sessions.length) {
    listEl.innerHTML = '<div style="padding:20px;color:#7a818c;text-align:center;">无匹配会话</div>';
    return;
  }
  // 按项目分组
  const groups = new Map();
  for (const s of state.sessions) {
    const key = s.projectPath || '(未知)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  // 按各组最新 endTime 倒序
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const at = a[1][0] && a[1][0].endTime || '';
    const bt = b[1][0] && b[1][0].endTime || '';
    return bt.localeCompare(at);
  });
  const isSearching = !!(state.query || state.selectedTagFilter.size || state.filter !== 'all');
  for (const [projectPath, sessions] of sortedGroups) {
    listEl.appendChild(createProjectNode(projectPath, sessions, isSearching));
  }
}

function createProjectNode(projectPath, sessions, autoExpand) {
  const wrap = document.createElement('div');
  wrap.className = 'project-node';
  const expanded = autoExpand || state.expandedProjects.has(projectPath);
  if (expanded) wrap.classList.add('open');

  const header = document.createElement('div');
  header.className = 'project-header';
  const latest = sessions[0]?.endTime;
  header.innerHTML = `
    <span class="proj-caret">▶</span>
    <span class="proj-path" title="${escapeHtml(projectPath)}">${escapeHtml(shortProject(projectPath))}</span>
    <span class="proj-count">${sessions.length}</span>
    <span class="proj-time">${fmtTime(latest)}</span>
  `;
  header.addEventListener('click', () => {
    const willOpen = !wrap.classList.contains('open');
    wrap.classList.toggle('open');
    if (willOpen) {
      state.expandedProjects.add(projectPath);
      if (!body.dataset.rendered) renderProjectSessions(body, sessions);
    } else {
      state.expandedProjects.delete(projectPath);
    }
    saveIdSet(LS_PROJ_EXPANDED, state.expandedProjects);
  });

  const body = document.createElement('div');
  body.className = 'project-body';
  if (expanded) renderProjectSessions(body, sessions);

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function renderProjectSessions(body, sessions) {
  body.dataset.rendered = '1';
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  // 直接渲染（每组通常 < 50 条），超大时也只在展开后才渲染
  for (const s of sessions) frag.appendChild(createSessionItem(s));
  body.appendChild(frag);
}

async function selectSession(id) {
  state.currentId = id;
  $$('.session-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  emptyTip.hidden = true;
  detailContent.hidden = false;
  messagesEl.innerHTML = '<div style="color:#7a818c;padding:40px;text-align:center;">加载中...</div>';
  detailHeader.innerHTML = '';

  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) throw new Error('加载失败');
    const data = await res.json();
    renderDetail(data);
  } catch (e) {
    messagesEl.innerHTML = `<div style="color:#e88078;padding:20px;">${escapeHtml(e.message)}</div>`;
  }
}

function renderDetail(data) {
  const m = data.meta;
  const nameDisplay = m.customName
    ? `<span class="h-name">${escapeHtml(m.customName)}</span>`
    : `<span class="h-name h-name-empty">（未命名）</span>`;
  const t = m.tokens || null;
  let tokenSummary = '';
  if (t && (t.totalInput || t.totalOutput)) {
    const win = contextWindowFor(t.model);
    const pct = win ? Math.min(100, Math.round(t.lastContextSize * 100 / win)) : 0;
    const cacheTotal = t.totalCacheRead + t.totalCacheCreation + t.totalInputUncached;
    const hitRate = cacheTotal ? Math.round(t.totalCacheRead * 100 / cacheTotal) : 0;
    tokenSummary = `
      <div class="h-tokens">
        <span class="tk-chip">累计输入 <b>${fmtTokens(t.totalInput)}</b></span>
        <span class="tk-chip">累计输出 <b>${fmtTokens(t.totalOutput)}</b></span>
        <span class="tk-chip">缓存命中 <b>${hitRate}%</b></span>
        <span class="tk-chip ctx-chip">
          末次上下文 <b>${fmtTokens(t.lastContextSize)}</b> / ${fmtTokens(win)}
          <span class="ctx-bar-bg ctx-bar-lg"><span class="ctx-bar-fill" style="width:${pct}%;"></span></span>
          <b>${pct}%</b>
        </span>
        ${t.model ? `<span class="tk-chip tk-model">${escapeHtml(t.model)}</span>` : ''}
      </div>
    `;
  }
  const currentTagIds = new Set(m.tags || []);
  const tagBadges = [...currentTagIds].map(tid => {
    const t = tagById(tid); if (!t) return '';
    return `<span class="tag-chip removable" data-id="${t.id}" style="background:${t.color}22;border-color:${t.color};color:${t.color};">${escapeHtml(t.name)} <span class="tag-x">×</span></span>`;
  }).join('');
  const addOptions = state.tagLibrary
    .filter(t => !currentTagIds.has(t.id))
    .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  const tagsRow = `
    <div class="h-tags-row">
      <span class="filter-label">标签</span>
      <span class="h-tags-chips" id="h-tags-chips">${tagBadges || '<span class="h-tags-empty">无</span>'}</span>
      <select id="h-tag-add" class="h-tag-select">
        <option value="">+ 添加…</option>
        ${addOptions}
      </select>
      <button id="h-tag-manage" class="h-tag-manage-btn" title="打开标签管理">管理</button>
    </div>
  `;
  detailHeader.innerHTML = `
    <div class="h-project">${escapeHtml(shortProject(m.projectPath))}</div>
    <div class="h-title-row">
      ${nameDisplay}
      <button class="rename-btn" title="重命名当前会话">✎ 重命名</button>
    </div>
    <div class="h-info">
      ${fmtTime(m.startTime)} → ${fmtTime(m.endTime)}　·
      ${m.userMessageCount} 问 / ${m.assistantMessageCount} 答　·
      <span style="font-family:ui-monospace,monospace;">${m.sessionId}</span>
    </div>
    ${tokenSummary}
    ${tagsRow}
  `;
  detailHeader.querySelector('.rename-btn').addEventListener('click', () => {
    promptRename(m.sessionId, m.customName || '');
  });
  detailHeader.querySelector('#h-tag-add').addEventListener('change', (ev) => {
    const tid = ev.target.value;
    if (!tid) return;
    const newTags = [...currentTagIds, tid];
    updateSessionTags(m.sessionId, newTags);
  });
  detailHeader.querySelectorAll('.tag-chip.removable').forEach(el => {
    el.addEventListener('click', () => {
      const newTags = [...currentTagIds].filter(t => t !== el.dataset.id);
      updateSessionTags(m.sessionId, newTags);
    });
  });
  detailHeader.querySelector('#h-tag-manage').addEventListener('click', openTagsModal);

  messagesEl.innerHTML = '';
  // 过滤规则：
  // - 工具结果 (tool_result) 完全隐藏
  // - assistant 消息：有文字/思考 → 显示；否则看是否含"有视觉价值"的工具（Edit/Write 等），有则显示，否则隐藏
  const visible = data.messages.filter(m => {
    if (HIDDEN_ROLES.has(m.role)) return false;
    if (m.role === 'assistant') {
      const hasContent = m.blocks.some(b => b.type === 'text' || b.type === 'thinking');
      if (hasContent) return true;
      const hasVisibleTool = m.blocks.some(b => b.type === 'tool_use' && VISIBLE_TOOLS.has(b.name));
      return hasVisibleTool;
    }
    return true;
  });
  const start = Math.max(0, visible.length - MSG_PAGE_SIZE);
  state.detail = { messages: visible, start };
  renderInitialBatch(messagesEl);
  // 滚到底（要等浏览器布局完成）
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

const MSG_PAGE_SIZE = 100;
const HIDDEN_ROLES = new Set(['tool_result']);
// "有视觉价值"的工具：即便消息里没有文字，也要展示这些工具调用（因为有 diff 等可视化）
const VISIBLE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function renderMessageGroup(container, slice) {
  // 按 sidechain 连续分组渲染；返回首个新建节点
  const firstBefore = container.firstChild;
  let i = 0;
  while (i < slice.length) {
    const msg = slice[i];
    if (!msg.sidechain) {
      container.appendChild(renderMessage(msg));
      i++;
      continue;
    }
    let j = i;
    while (j < slice.length && slice[j].sidechain) j++;
    container.appendChild(renderSidechainGroup(slice.slice(i, j)));
    i = j;
  }
  return firstBefore; // 用于"挂上方" sentinel 的参考节点
}

function ensureTopSentinel(container) {
  // 移除旧 sentinel
  const old = container.querySelector('.msg-sentinel');
  if (old) old.remove();
  const d = state.detail;
  if (!d || d.start <= 0) return;
  const sentinel = document.createElement('div');
  sentinel.className = 'msg-sentinel';
  sentinel.textContent = `▲ 上方还有 ${d.start} 条更早的消息，向上滚动加载`;
  container.insertBefore(sentinel, container.firstChild);
  msgObserver.observe(sentinel);
}

function renderInitialBatch(container) {
  const d = state.detail;
  if (!d) return;
  const slice = d.messages.slice(d.start, d.messages.length);
  renderMessageGroup(container, slice);
  ensureTopSentinel(container);
  highlightNewCodeBlocks(container);
}

function renderEarlierBatch(container) {
  const d = state.detail;
  if (!d || d.start <= 0) return;
  const newStart = Math.max(0, d.start - MSG_PAGE_SIZE);
  const slice = d.messages.slice(newStart, d.start);
  // 记录当前滚动位置（基于第一条已渲染消息的位置）
  const anchor = container.querySelector('.msg, .sidechain-group');
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
  // 把新批次构建在 fragment 里，避免中途触发滚动
  const frag = document.createDocumentFragment();
  renderMessageGroup(frag, slice);
  // 移除旧 sentinel
  const oldSentinel = container.querySelector('.msg-sentinel');
  if (oldSentinel) oldSentinel.remove();
  // 在顶部插入
  container.insertBefore(frag, container.firstChild);
  d.start = newStart;
  ensureTopSentinel(container);
  highlightNewCodeBlocks(container);
  // 恢复滚动位置（让原 anchor 元素停在原视觉位置）
  if (anchor) {
    requestAnimationFrame(() => {
      const newTop = anchor.getBoundingClientRect().top;
      container.scrollTop += (newTop - anchorTop);
    });
  }
}

function highlightNewCodeBlocks(container) {
  $$('pre code', container).forEach(el => {
    if (!el.dataset.highlighted) {
      try { hljs.highlightElement(el); el.dataset.highlighted = '1'; } catch {}
    }
  });
}

const msgObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      msgObserver.unobserve(e.target);
      renderEarlierBatch(messagesEl);
    }
  }
}, { root: messagesEl, rootMargin: '300px' });

function renderSidechainGroup(segment) {
  const wrap = document.createElement('div');
  wrap.className = 'sidechain-group';
  const userCount = segment.filter(m => m.role === 'user').length;
  const asstCount = segment.filter(m => m.role === 'assistant').length;
  const firstUserText = (segment.find(m => m.role === 'user')?.blocks || [])
    .filter(b => b.type === 'text').map(b => b.text).join(' ').slice(0, 80).replace(/\s+/g, ' ');
  const header = document.createElement('div');
  header.className = 'sidechain-header';
  header.innerHTML = `
    <span class="sc-caret">▶</span>
    <span class="sc-label">🤖 子 Agent (Task)</span>
    <span class="sc-meta">${segment.length} 条 · ${userCount} 问 / ${asstCount} 答</span>
    <span class="sc-preview">${escapeHtml(firstUserText)}</span>
  `;
  const body = document.createElement('div');
  body.className = 'sidechain-body';
  for (const m of segment) body.appendChild(renderMessage(m));
  header.addEventListener('click', () => wrap.classList.toggle('open'));
  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

async function promptRename(sessionId, current) {
  const input = window.prompt('输入会话名称（留空则清除）:', current);
  if (input === null) return; // 取消
  const name = input.trim();
  try {
    const res = await fetch(`/api/sessions/${sessionId}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // 更新内存中的会话数据
    for (const s of state.allSessions) {
      if (s.sessionId === sessionId) s.customName = data.customName;
    }
    applyFilterAndSort();
    // 重新渲染详情页头部
    const cur = state.allSessions.find(s => s.sessionId === sessionId);
    if (cur) {
      const headerName = detailHeader.querySelector('.h-name');
      if (headerName) {
        if (cur.customName) {
          headerName.classList.remove('h-name-empty');
          headerName.textContent = cur.customName;
        } else {
          headerName.classList.add('h-name-empty');
          headerName.textContent = '（未命名）';
        }
      }
    }
  } catch (e) {
    alert('重命名失败: ' + e.message);
  }
}

function renderMessage(msg) {
  const wrap = document.createElement('div');
  const cssRole = msg.role === 'tool_result' ? 'tool-result'
                 : msg.role === 'command_output' ? 'command-output'
                 : msg.role;
  wrap.className = 'msg msg-' + cssRole;

  let roleLabel, roleClass;
  if (msg.role === 'user' && msg.kind === 'command') {
    roleLabel = '我（命令）'; roleClass = 'user';
  } else if (msg.role === 'user') {
    roleLabel = '我'; roleClass = 'user';
  } else if (msg.role === 'assistant') {
    roleLabel = 'Claude'; roleClass = 'assistant';
  } else if (msg.role === 'tool_result') {
    roleLabel = '工具结果'; roleClass = 'tool';
  } else if (msg.role === 'command_output') {
    roleLabel = '命令输出'; roleClass = 'tool';
  } else {
    roleLabel = msg.role; roleClass = 'tool';
  }

  const header = document.createElement('div');
  header.className = 'msg-header';
  let usageHtml = '';
  if (msg.role === 'assistant' && msg.usage) {
    const u = msg.usage;
    const ctxIn = u.input + u.cacheRead + u.cacheCreation;
    usageHtml = `<span class="msg-usage" title="本轮上下文 ${ctxIn} (input ${u.input} / cache_read ${u.cacheRead} / cache_creation ${u.cacheCreation}) · 输出 ${u.output}">↑ ${fmtTokens(ctxIn)} ↓ ${fmtTokens(u.output)}</span>`;
  }
  header.innerHTML = `
    <span class="msg-role ${roleClass}">${roleLabel}</span>
    <span>${fmtTime(msg.timestamp)}</span>
    ${msg.model ? `<span style="font-family:ui-monospace,monospace;">${escapeHtml(msg.model)}</span>` : ''}
    ${usageHtml}
  `;
  wrap.appendChild(header);

  for (const block of msg.blocks) {
    if (msg.kind === 'command' && block.type === 'text') {
      const el = document.createElement('pre');
      el.className = 'cmd-line';
      el.textContent = block.text;
      wrap.appendChild(el);
    } else {
      wrap.appendChild(renderBlock(block, msg.role));
    }
  }
  return wrap;
}

function renderBlock(block, role) {
  if (block.type === 'text') {
    const el = document.createElement('div');
    el.className = 'msg-text';
    el.innerHTML = renderMarkdownLite(block.text);
    return el;
  }
  if (block.type === 'thinking') {
    const el = document.createElement('details');
    el.className = 'thinking-block';
    el.innerHTML = `<summary>💭 思考过程（点击展开）</summary><div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(block.text)}</div>`;
    return el;
  }
  if (block.type === 'tool_use') {
    return renderToolUse(block);
  }
  if (block.type === 'tool_result') {
    return renderToolResult(block);
  }
  const el = document.createElement('div');
  el.textContent = JSON.stringify(block);
  return el;
}

function renderToolUse(block) {
  const el = document.createElement('div');
  el.className = 'tool-block';
  const preview = buildToolPreview(block.name, block.input);

  el.innerHTML = `
    <div class="tool-summary">
      <span class="tool-caret">▶</span>
      <span class="tool-name">${escapeHtml(block.name)}</span>
      <span class="tool-preview">${escapeHtml(preview)}</span>
    </div>
    <div class="tool-detail"></div>
  `;
  const detail = el.querySelector('.tool-detail');

  // Edit / Write / MultiEdit 渲染成可视化 diff；其他工具显示 JSON 参数
  if (block.name === 'Edit' && block.input) {
    detail.appendChild(buildEditDiff(block.input));
  } else if (block.name === 'Write' && block.input) {
    detail.appendChild(buildWriteDiff(block.input));
  } else if (block.name === 'MultiEdit' && block.input && Array.isArray(block.input.edits)) {
    const pathRow = document.createElement('div');
    pathRow.className = 'diff-filepath';
    pathRow.textContent = block.input.file_path || '';
    detail.appendChild(pathRow);
    block.input.edits.forEach((e, i) => {
      const sep = document.createElement('div');
      sep.className = 'diff-section-label';
      sep.textContent = `编辑 ${i + 1}/${block.input.edits.length}`;
      detail.appendChild(sep);
      detail.appendChild(buildDiffView(e.old_string || '', e.new_string || ''));
    });
  } else {
    const inputStr = typeof block.input === 'object' ? JSON.stringify(block.input, null, 2) : String(block.input);
    const label = document.createElement('div');
    label.className = 'tool-label';
    label.textContent = '参数';
    detail.appendChild(label);
    const pre = document.createElement('pre');
    pre.textContent = inputStr;
    detail.appendChild(pre);
  }

  el.querySelector('.tool-summary').addEventListener('click', () => el.classList.toggle('open'));
  return el;
}

function buildEditDiff(input) {
  const wrap = document.createDocumentFragment();
  if (input.file_path) {
    const p = document.createElement('div');
    p.className = 'diff-filepath';
    p.textContent = input.file_path + (input.replace_all ? '   （替换全部匹配）' : '');
    wrap.appendChild(p);
  }
  wrap.appendChild(buildDiffView(input.old_string || '', input.new_string || ''));
  return wrap;
}

function buildWriteDiff(input) {
  const wrap = document.createDocumentFragment();
  if (input.file_path) {
    const p = document.createElement('div');
    p.className = 'diff-filepath';
    p.textContent = input.file_path + '   （整文件写入）';
    wrap.appendChild(p);
  }
  // Write 视为全部新增
  wrap.appendChild(buildDiffView('', input.content || ''));
  return wrap;
}

const DIFF_MAX_LINES = 800;

function buildDiffView(oldStr, newStr) {
  const view = document.createElement('div');
  view.className = 'diff-view';
  if (!window.Diff || typeof Diff.diffLines !== 'function') {
    // 降级：左旧右新两栏纯文本
    view.innerHTML = `
      <div class="diff-fallback">
        <div><div class="diff-section-label">原内容</div><pre>${escapeHtml(oldStr)}</pre></div>
        <div><div class="diff-section-label">新内容</div><pre>${escapeHtml(newStr)}</pre></div>
      </div>
    `;
    return view;
  }
  const parts = Diff.diffLines(oldStr, newStr);
  let rendered = 0;
  let truncated = false;
  for (const p of parts) {
    const lines = p.value.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const cls = p.added ? 'diff-add' : p.removed ? 'diff-del' : 'diff-eq';
    const mark = p.added ? '+' : p.removed ? '-' : ' ';
    for (const line of lines) {
      if (rendered >= DIFF_MAX_LINES) { truncated = true; break; }
      const row = document.createElement('div');
      row.className = 'diff-line ' + cls;
      row.innerHTML = `<span class="diff-mark">${mark}</span><span class="diff-text">${escapeHtml(line) || '&#8203;'}</span>`;
      view.appendChild(row);
      rendered++;
    }
    if (truncated) break;
  }
  if (truncated) {
    const t = document.createElement('div');
    t.className = 'diff-truncated';
    t.textContent = `…（已截断，超过 ${DIFF_MAX_LINES} 行）`;
    view.appendChild(t);
  }
  return view;
}

function renderToolResult(block) {
  const el = document.createElement('div');
  el.className = 'tool-block' + (block.is_error ? ' is-error' : '');
  const preview = (block.text || '').slice(0, 120).replace(/\s+/g, ' ');
  el.innerHTML = `
    <div class="tool-summary">
      <span class="tool-caret">▶</span>
      <span class="tool-name" style="background:${block.is_error ? '#e8807833' : '#5cb87a33'};color:${block.is_error ? '#e88078' : '#8fd9a0'};">
        ${block.is_error ? '✗ 工具结果' : '✓ 工具结果'}
      </span>
      <span class="tool-preview">${escapeHtml(preview)}</span>
    </div>
    <div class="tool-detail">
      <pre>${escapeHtml(block.text || '(空)')}</pre>
    </div>
  `;
  el.querySelector('.tool-summary').addEventListener('click', () => el.classList.toggle('open'));
  return el;
}

function buildToolPreview(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.pattern) return input.pattern;
  if (input.query) return input.query;
  if (input.url) return input.url;
  if (input.description) return input.description;
  const keys = Object.keys(input);
  if (keys.length) return keys.map(k => `${k}=...`).join(', ');
  return '';
}

// 用 marked 渲染完整 Markdown；失败时退化为转义文本
if (window.marked) {
  marked.setOptions({
    breaks: true,        // 换行直接换行（GFM 风格）
    gfm: true,
    headerIds: false,
    mangle: false,
  });
}
function renderMarkdownLite(text) {
  if (!text) return '';
  if (!window.marked) return escapeHtml(text).replace(/\n/g, '<br>');
  try {
    return marked.parse(text);
  } catch (e) {
    console.warn('markdown 渲染失败', e);
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

// 防抖搜索
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSessions(searchInput.value.trim()), 200);
});

$('#refresh').addEventListener('click', async () => {
  statsEl.textContent = '重扫中...';
  await fetch('/api/refresh', { method: 'POST' });
  await loadSessions(state.query);
});

$('#filter-tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('.filter-tab');
  if (!btn) return;
  const f = btn.dataset.filter;
  if (state.filter === f) return;
  state.filter = f;
  $$('#filter-tabs .filter-tab').forEach(el => el.classList.toggle('active', el.dataset.filter === f));
  applyFilterAndSort();
});

// 时间范围过滤
const timeRangeSelect = $('#time-range');
const timeFromInput = $('#time-from');
const timeToInput = $('#time-to');
function syncTimeUI() {
  timeRangeSelect.value = state.timeRange;
  timeFromInput.value = state.timeFrom;
  timeToInput.value = state.timeTo;
  const showCustom = state.timeRange === 'custom';
  timeFromInput.hidden = !showCustom;
  timeToInput.hidden = !showCustom;
}
syncTimeUI();
timeRangeSelect.addEventListener('change', () => {
  state.timeRange = timeRangeSelect.value;
  localStorage.setItem(LS_TIME_RANGE, state.timeRange);
  syncTimeUI();
  applyFilterAndSort();
});
timeFromInput.addEventListener('change', () => {
  state.timeFrom = timeFromInput.value;
  localStorage.setItem(LS_TIME_FROM, state.timeFrom);
  applyFilterAndSort();
});
timeToInput.addEventListener('change', () => {
  state.timeTo = timeToInput.value;
  localStorage.setItem(LS_TIME_TO, state.timeTo);
  applyFilterAndSort();
});

// ---- 设置（claudeDir 路径）----
const settingsModal = $('#settings-modal');
const claudeDirInput = $('#claude-dir-input');
const settingsMsg = $('#settings-msg');
const settingsSaveBtn = $('#settings-save');

async function openSettings() {
  settingsMsg.textContent = '';
  settingsMsg.className = 'form-msg';
  claudeDirInput.value = '加载中...';
  claudeDirInput.disabled = true;
  settingsModal.hidden = false;
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    claudeDirInput.value = data.claudeDir || '';
    if (data.projectsDirExists === false) {
      settingsMsg.textContent = `⚠ 当前路径下不存在 projects 子目录: ${data.projectsDir}`;
      settingsMsg.className = 'form-msg err';
    }
  } catch (e) {
    settingsMsg.textContent = '读取配置失败: ' + e.message;
    settingsMsg.className = 'form-msg err';
    claudeDirInput.value = '';
  } finally {
    claudeDirInput.disabled = false;
    claudeDirInput.focus();
    claudeDirInput.select();
  }
}

function closeSettings() {
  settingsModal.hidden = true;
}

async function saveSettings() {
  const claudeDir = claudeDirInput.value.trim();
  if (!claudeDir) {
    settingsMsg.textContent = '路径不能为空';
    settingsMsg.className = 'form-msg err';
    return;
  }
  settingsMsg.textContent = '保存中...';
  settingsMsg.className = 'form-msg';
  settingsSaveBtn.disabled = true;
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeDir }),
    });
    const data = await res.json();
    if (!res.ok) {
      settingsMsg.textContent = data.error || '保存失败';
      settingsMsg.className = 'form-msg err';
      return;
    }
    let msg = `✓ 已保存，扫描到 ${data.total} 个会话`;
    if (data.projectsDirExists === false) {
      msg += `（注意：${data.projectsDir} 不存在，索引为空）`;
    }
    settingsMsg.textContent = msg;
    settingsMsg.className = 'form-msg ok';
    // 旧的当前会话可能已不在新路径下，清空选中
    state.currentId = null;
    detailContent.hidden = true;
    emptyTip.hidden = false;
    await loadSessions(state.query);
    setTimeout(closeSettings, 800);
  } catch (e) {
    settingsMsg.textContent = '请求失败: ' + e.message;
    settingsMsg.className = 'form-msg err';
  } finally {
    settingsSaveBtn.disabled = false;
  }
}

$('#settings-btn').addEventListener('click', openSettings);
$('#settings-cancel').addEventListener('click', closeSettings);
$('#settings-save').addEventListener('click', saveSettings);
$('.modal-backdrop', settingsModal).addEventListener('click', closeSettings);
claudeDirInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') saveSettings();
  else if (ev.key === 'Escape') closeSettings();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !settingsModal.hidden) closeSettings();
});

// ---- Tag 系统：弹窗、过滤、详情绑定 ----
const tagsModal = $('#tags-modal');
const tagsLibraryList = $('#tag-library-list');
const tagNewName = $('#tag-new-name');
const tagNewColor = $('#tag-new-color');
const tagCreateMsg = $('#tag-create-msg');
const tagFilterRow = $('#tag-filter-row');
const tagFilterChips = $('#tag-filter-chips');
const tagFilterClear = $('#tag-filter-clear');

function openTagsModal() {
  tagsModal.hidden = false;
  tagNewName.value = '';
  tagCreateMsg.textContent = '';
  renderTagLibrary();
  setTimeout(() => tagNewName.focus(), 50);
}
function closeTagsModal() { tagsModal.hidden = true; }

function renderTagLibrary() {
  if (!state.tagLibrary.length) {
    tagsLibraryList.innerHTML = '<div class="tag-empty">还没有标签，新增一个开始使用。</div>';
    return;
  }
  tagsLibraryList.innerHTML = state.tagLibrary.map(t => `
    <div class="tag-row" data-id="${t.id}">
      <span class="tag-chip" style="background:${t.color}22;border-color:${t.color};color:${t.color};">${escapeHtml(t.name)}</span>
      <input type="color" class="tag-row-color" value="${t.color}" />
      <button class="tag-row-rename btn">重命名</button>
      <button class="tag-row-delete btn btn-danger">删除</button>
    </div>
  `).join('');
  tagsLibraryList.querySelectorAll('.tag-row').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('.tag-row-color').addEventListener('change', (ev) => updateTag(id, { color: ev.target.value }));
    row.querySelector('.tag-row-rename').addEventListener('click', () => {
      const t = tagById(id); if (!t) return;
      const newName = prompt('新名称:', t.name);
      if (newName === null) return;
      updateTag(id, { name: newName.trim() });
    });
    row.querySelector('.tag-row-delete').addEventListener('click', () => {
      const t = tagById(id); if (!t) return;
      if (!confirm(`删除标签「${t.name}」？\n所有会话上的此标签都会被解绑。`)) return;
      deleteTag(id);
    });
  });
}

async function createTag() {
  const name = tagNewName.value.trim();
  const color = tagNewColor.value;
  if (!name) { tagCreateMsg.textContent = '名称必填'; tagCreateMsg.className = 'form-msg err'; return; }
  try {
    const res = await fetch('/api/tags', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, color }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    state.tagLibrary = data.library;
    tagCreateMsg.textContent = '已添加';
    tagCreateMsg.className = 'form-msg ok';
    tagNewName.value = '';
    renderTagLibrary();
    renderTagFilterRow();
    applyFilterAndSort();
    if (state.currentId) refreshCurrentDetail();
  } catch (e) {
    tagCreateMsg.textContent = '失败: ' + e.message;
    tagCreateMsg.className = 'form-msg err';
  }
}

async function updateTag(id, patch) {
  try {
    const res = await fetch(`/api/tags/${id}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    state.tagLibrary = data.library;
    renderTagLibrary();
    renderTagFilterRow();
    applyFilterAndSort();
    if (state.currentId) refreshCurrentDetail();
  } catch (e) { alert('更新失败: ' + e.message); }
}

async function deleteTag(id) {
  try {
    const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    state.tagLibrary = data.library;
    state.selectedTagFilter.delete(id);
    saveIdSet('cv.tagFilter', state.selectedTagFilter);
    // 本地从 allSessions 里清除该 tag
    for (const s of state.allSessions) {
      if (s.tags) s.tags = s.tags.filter(t => t !== id);
    }
    renderTagLibrary();
    renderTagFilterRow();
    loadSessions(state.query);
    if (state.currentId) refreshCurrentDetail();
  } catch (e) { alert('删除失败: ' + e.message); }
}

async function updateSessionTags(sessionId, tagIds) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/tags`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ tags: tagIds }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    // 更新内存
    const s = state.allSessions.find(x => x.sessionId === sessionId);
    if (s) s.tags = data.tags || [];
    applyFilterAndSort();
    if (state.currentId === sessionId) refreshCurrentDetail();
  } catch (e) { alert('绑定 tag 失败: ' + e.message); }
}

function renderTagFilterRow() {
  if (!state.tagLibrary.length) { tagFilterRow.hidden = true; return; }
  tagFilterRow.hidden = false;
  tagFilterChips.innerHTML = state.tagLibrary.map(t => {
    const on = state.selectedTagFilter.has(t.id);
    return `<button class="tag-chip filter-tag ${on ? 'on' : ''}" data-id="${t.id}" style="background:${on ? t.color+'33' : 'transparent'};border-color:${t.color};color:${t.color};">${escapeHtml(t.name)}</button>`;
  }).join('');
  tagFilterChips.querySelectorAll('.filter-tag').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (state.selectedTagFilter.has(id)) state.selectedTagFilter.delete(id);
      else state.selectedTagFilter.add(id);
      saveIdSet('cv.tagFilter', state.selectedTagFilter);
      renderTagFilterRow();
      loadSessions(state.query);
    });
  });
  tagFilterClear.hidden = state.selectedTagFilter.size === 0;
}

tagFilterClear.addEventListener('click', () => {
  state.selectedTagFilter.clear();
  saveIdSet('cv.tagFilter', state.selectedTagFilter);
  renderTagFilterRow();
  loadSessions(state.query);
});
$('#tags-btn').addEventListener('click', openTagsModal);
$('#tags-close').addEventListener('click', closeTagsModal);
$('#tag-create-btn').addEventListener('click', createTag);
tagNewName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') createTag(); });
tagsModal.querySelector('.modal-backdrop').addEventListener('click', closeTagsModal);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !tagsModal.hidden) closeTagsModal();
});

// ---- 全局统计仪表盘 ----
const statsOverlay = $('#stats-overlay');
const statsBody = $('#stats-body');

async function openStats() {
  statsOverlay.hidden = false;
  statsBody.innerHTML = '<div style="padding:40px;color:#7a818c;text-align:center;">加载中...</div>';
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderStats(data);
  } catch (e) {
    statsBody.innerHTML = `<div style="padding:40px;color:#e88078;">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function closeStats() { statsOverlay.hidden = true; }

function renderStats(data) {
  const T = data.totals;
  const hitPct = Math.round(T.cacheHitRate * 100);
  // 顶部卡片
  const topCards = `
    <div class="stats-cards">
      <div class="stat-card"><div class="sc-label">总会话</div><div class="sc-value">${T.sessions}</div></div>
      <div class="stat-card"><div class="sc-label">总问答</div><div class="sc-value">${T.userMessages} / ${T.assistantMessages}</div><div class="sc-sub">问 / 答</div></div>
      <div class="stat-card"><div class="sc-label">累计输入</div><div class="sc-value">${fmtTokens(T.input)}</div><div class="sc-sub">cache hit ${hitPct}%</div></div>
      <div class="stat-card"><div class="sc-label">累计输出</div><div class="sc-value">${fmtTokens(T.output)}</div></div>
    </div>
  `;

  // 按项目（柱状）
  const maxProjInput = Math.max(...data.topProjects.map(p => p.totalInput), 1);
  const projRows = data.topProjects.map(p => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(p.project)}">${escapeHtml(shortProject(p.project))}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(p.totalInput / maxProjInput * 100).toFixed(1)}%;"></span></span>
      <span class="bar-meta">${p.count} 会话 · ${fmtTokens(p.totalInput)}↑ ${fmtTokens(p.totalOutput)}↓</span>
    </div>
  `).join('');

  // 按日（迷你柱）
  const maxDayInput = Math.max(...data.daily.map(d => d.totalInput), 1);
  const dayBars = data.daily.map(d => `
    <div class="day-bar" title="${d.day} · ${d.count} 会话 · ${fmtTokens(d.totalInput)}↑">
      <span class="day-bar-fill" style="height:${(d.totalInput / maxDayInput * 100).toFixed(1)}%;"></span>
      <span class="day-bar-label">${d.day.slice(5)}</span>
    </div>
  `).join('');

  // Top 会话
  const topSessRows = data.topSessions.slice(0, 10).map(s => {
    const label = s.customName || s.titlePreview.slice(0, 50);
    return `<div class="top-sess" data-id="${s.sessionId}">
      <span class="ts-label">${escapeHtml(label)}</span>
      <span class="ts-proj">${escapeHtml(shortProject(s.projectPath))}</span>
      <span class="ts-tokens">${fmtTokens(s.totalInput)}↑ ${fmtTokens(s.totalOutput)}↓</span>
    </div>`;
  }).join('');

  // 模型分布
  const modelRows = data.byModel.map(m => `
    <div class="model-row"><span>${escapeHtml(m.model)}</span><span>${m.count}</span></div>
  `).join('');

  statsBody.innerHTML = `
    ${topCards}
    <div class="stats-grid">
      <section class="stats-section">
        <h3>按项目 (Top ${data.topProjects.length})</h3>
        <div class="bar-list">${projRows || '<div class="stats-empty">无数据</div>'}</div>
      </section>
      <section class="stats-section">
        <h3>按日活跃度（输入 token 趋势）</h3>
        <div class="day-bars">${dayBars || '<div class="stats-empty">无数据</div>'}</div>
      </section>
      <section class="stats-section">
        <h3>消耗最大的会话 (Top 10)</h3>
        <div class="top-sess-list">${topSessRows || '<div class="stats-empty">无数据</div>'}</div>
      </section>
      <section class="stats-section">
        <h3>模型分布</h3>
        <div class="model-list">${modelRows || '<div class="stats-empty">无数据</div>'}</div>
      </section>
    </div>
  `;
  // 点击 Top 会话定位
  statsBody.querySelectorAll('.top-sess').forEach(el => {
    el.addEventListener('click', () => {
      closeStats();
      selectSession(el.dataset.id);
    });
  });
}

$('#stats-btn').addEventListener('click', openStats);
$('#stats-close').addEventListener('click', closeStats);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !statsOverlay.hidden) closeStats();
});

// ---- 主题切换（右上角下拉框） ----
const THEMES = ['dark', 'mid', 'light'];
const LS_THEME = 'cv.theme';
const themeSelect = $('#theme-select');

function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  themeSelect.value = t;
  localStorage.setItem(LS_THEME, t);
}
applyTheme(localStorage.getItem(LS_THEME) || 'dark');
themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

// 启动顺序：tag 库 + 用户偏好（pin/fav）→ 再拉会话列表
Promise.all([loadTagLibrary(), loadPreferences()]).then(() => {
  renderTagFilterRow();
  loadSessions();
});

// ---- SSE：文件变化自动同步（离开页面时暂停）----
let eventSource = null;
let detailRefreshTimer = null;

function applySessionUpdate(meta) {
  const idx = state.allSessions.findIndex(s => s.sessionId === meta.sessionId);
  if (idx >= 0) {
    state.allSessions[idx] = meta;
  } else {
    state.allSessions.unshift(meta);
  }
  applyFilterAndSort();
  if (state.currentId === meta.sessionId) {
    // 当前正在看这个会话，去抖刷新详情（800ms 内多次只刷一次）
    clearTimeout(detailRefreshTimer);
    detailRefreshTimer = setTimeout(() => refreshCurrentDetail(), 800);
  }
}

function applySessionRemoved(sessionId) {
  state.allSessions = state.allSessions.filter(s => s.sessionId !== sessionId);
  state.pinned.delete(sessionId);
  state.favorite.delete(sessionId);
  applyFilterAndSort();
  if (state.currentId === sessionId) {
    state.currentId = null;
    detailContent.hidden = true;
    emptyTip.hidden = false;
  }
}

async function refreshCurrentDetail() {
  if (!state.currentId) return;
  try {
    const res = await fetch(`/api/sessions/${state.currentId}`);
    if (!res.ok) return;
    const data = await res.json();
    renderDetail(data); // renderDetail 自己会滚到末尾
  } catch (e) {
    console.warn('详情刷新失败', e);
  }
}

function startSSE() {
  if (eventSource) return;
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('session-updated', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && data.meta) applySessionUpdate(data.meta);
    } catch {}
  });
  eventSource.addEventListener('session-removed', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data && data.sessionId) applySessionRemoved(data.sessionId);
    } catch {}
  });
  eventSource.onerror = () => {
    // 浏览器会自动重连
  };
}

function stopSSE() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSSE();
  } else {
    // 回到页面时拉一次最新列表，再开 SSE
    loadSessions(state.query).then(startSSE);
  }
});

if (!document.hidden) startSSE();
