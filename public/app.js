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
const LS_VIEW_MODE = 'cv.messageView'; // 默认模式改为只看对话时换了键名，旧键 cv.viewMode 里的选择不再生效
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
  viewMode: localStorage.getItem(LS_VIEW_MODE) || 'chat', // 'chat' | 'default' | 'tools' | 'errors'
  showContext: localStorage.getItem('cv.showContext') === '1',
  search: { query: '', hits: [], current: -1 },               // 会话内搜索；hits 是展示列表的下标
  drawer: null,            // null | { kind: 'files' | 'agents' | 'agent', agentId? }
  openFiles: new Set(),    // 改动文件面板里已展开的文件
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
  const home = state.homeDir;
  if (home && p.startsWith(home) && (p.length === home.length || /[\\/]/.test(p[home.length]))) {
    p = '~' + p.slice(home.length);
  }
  return p;
}

function fmtTokens(n) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 1).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// 上下文窗口（2026-10 核对）；模型 id 可能带日期后缀，只取前缀匹配。未知模型返回 0，界面不显示占比
const CONTEXT_1M = /^claude-(fable|mythos|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/;
const CONTEXT_200K = /^claude-(opus-4|sonnet-4|haiku-4|3)/;
function contextWindowFor(model) {
  if (CONTEXT_1M.test(model || '')) return 1000000;
  if (CONTEXT_200K.test(model || '')) return 200000;
  return 0;
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
  const title = s.customName || s.aiTitle;
  const nameLine = title
    ? `<div class="session-name">${highlight(title, state.query)}</div>`
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
    const costStr = fmtUSD(s.estimatedCostUSD || 0);
    tokenLine = `
      <div class="session-tokens">
        <span title="累计输入 / 输出">累计 ${fmtTokens(t.totalInput)}↑ ${fmtTokens(t.totalOutput)}↓</span>
        <span class="ctx-bar" title="末次上下文 ${fmtTokens(t.lastContextSize)}${win ? ' / ' + fmtTokens(win) : ''}">
          末次 ${fmtTokens(t.lastContextSize)}
          ${win ? `<span class="ctx-bar-bg"><span class="ctx-bar-fill" style="width:${pct}%;"></span></span>
          <span class="ctx-bar-pct">${pct}%</span>` : ''}
        </span>
      </div>
      <div class="session-cost-line" title="预计花费（按 Anthropic 官方单价估算）">
        <span class="scl-ico">≈</span> 预计花费 <b>${costStr}</b>
      </div>
    `;
  }
  item.innerHTML = `
    <div class="session-actions">
      <div class="session-actions-left">
        <button class="icon-btn pin-btn ${isPinned ? 'on' : ''}" title="${isPinned ? '取消置顶' : '置顶'}">📌</button>
        <button class="icon-btn fav-btn ${isFav ? 'on' : ''}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '★' : '☆'}</button>
        <button class="icon-btn session-copy-btn" title="复制 /resume 命令">复制命令</button>
      </div>
      <div class="session-actions-right">
        <button class="icon-btn session-delete-btn" title="删除该会话（不可恢复）">删除</button>
      </div>
    </div>
    ${nameLine}
    ${tagsLine}
    <div class="session-preview ${title ? 'has-title' : ''}">${highlight(s.titlePreview, state.query)}</div>
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
  const label = s.customName || s.aiTitle || s.titlePreview.slice(0, 40);
  const ok = await askDialog({
    title: '删除会话',
    message: `此操作不可恢复，会直接删除源文件。\n\n${label}\n${s.sessionId}`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
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
    showError('删除失败: ' + e.message);
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
    setTimeout(() => { btn.textContent = '复制命令'; }, 1200);
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
  clearMsgSearch();
  if (state.drawer && state.drawer.kind === 'agent') state.drawer = { kind: 'agents' };

  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) throw new Error('加载失败');
    const data = await res.json();
    if (state.currentId !== id) return; // 加载期间已切到别的会话
    // 从全局搜索结果点进来：定位到第一处命中（命中的可能只是路径或标签，这时不带入）
    renderDetail(data, () => { if (state.query) searchFromGlobal(state.query); });
  } catch (e) {
    if (state.currentId !== id) return;
    messagesEl.innerHTML = `<div style="color:#e88078;padding:20px;">${escapeHtml(e.message)}</div>`;
  }
}

function renderDetailHeader(m) {
  const nameDisplay = m.customName
    ? `<span class="h-name">${escapeHtml(m.customName)}</span>`
    : m.aiTitle
      ? `<span class="h-name">${escapeHtml(m.aiTitle)}</span><span class="h-auto-title">自动标题</span>`
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
        <span class="tk-chip tk-cost" title="预计花费（按 Anthropic 官方单价估算）">预计花费 <b>${fmtUSD(m.estimatedCostUSD || 0)}</b></span>
        <span class="tk-chip">缓存命中 <b>${hitRate}%</b></span>
        <span class="tk-chip ctx-chip">
          末次上下文 <b>${fmtTokens(t.lastContextSize)}</b>${win ? ` / ${fmtTokens(win)}
          <span class="ctx-bar-bg ctx-bar-lg"><span class="ctx-bar-fill" style="width:${pct}%;"></span></span>
          <b>${pct}%</b>` : ''}
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
}

// 由接口数据整理出渲染所需的上下文；子 Agent 面板用同样的结构
function buildDetailCtx(data, showResults) {
  const results = new Map(); // tool_use_id -> tool_result 块
  for (const m of data.messages) {
    for (const b of m.blocks) if (b.type === 'tool_result') results.set(b.tool_use_id, b);
  }
  const agents = data.agents || [];
  const agentByTool = new Map(agents.filter(a => a.toolUseId).map(a => [a.toolUseId, a.agentId]));
  return { raw: data.messages, meta: data.meta, timeline: data.timeline || [], agents, results, agentByTool, showResults };
}

function resultsShownIn(mode) {
  return mode === 'tools' || mode === 'errors';
}

// 一条消息在某显示模式下要展示的块，null 表示整条隐藏。工具结果不单独成条，显示在对应的工具块内
function viewBlocks(m, ctx, mode) {
  if (HIDDEN_ROLES.has(m.role)) return null;
  const keep = (pred) => {
    const blocks = m.blocks.filter(pred);
    return blocks.length ? blocks : null;
  };
  if (mode === 'errors') {
    if (m.role === 'command_output') return m.blocks.some(b => b.isError) ? m.blocks : null;
    if (m.role !== 'assistant') return null;
    return keep(b => b.type === 'tool_use' && ctx.results.get(b.id)?.is_error);
  }
  if (m.role !== 'assistant') return mode === 'chat' && m.role === 'command_output' ? null : m.blocks;
  if (mode === 'chat') return keep(b => b.type === 'text');
  if (mode === 'tools') return m.blocks;
  // 默认：有文字/思考 → 显示；否则看是否含"有视觉价值"的工具（Edit/Write、子 Agent 等）
  const visible = m.blocks.some(b => b.type === 'text' || b.type === 'thinking'
    || (b.type === 'tool_use' && (VISIBLE_TOOLS.has(b.name) || ctx.results.get(b.id)?.agentId || ctx.agentByTool.has(b.id))));
  return visible ? m.blocks : null;
}

function buildView(ctx, mode) {
  const out = [];
  ctx.raw.forEach((m, rawIndex) => {
    const blocks = viewBlocks(m, ctx, mode);
    if (blocks) out.push({ ...m, blocks, rawIndex, i: out.length });
  });
  return out;
}

function renderEmptyView(container) {
  if (state.detail.messages.length) return;
  const el = document.createElement('div');
  el.className = 'view-empty';
  el.textContent = state.viewMode === 'errors' ? '本会话没有失败的工具调用' : '当前模式下没有内容';
  container.appendChild(el);
}

// afterLayout：滚到底之后执行，用于接着定位到搜索结果
function renderDetail(data, afterLayout) {
  renderDetailHeader(data.meta);
  messagesEl.innerHTML = '';
  const ctx = buildDetailCtx(data, resultsShownIn(state.viewMode));
  const visible = buildView(ctx, state.viewMode);
  const start = Math.max(0, visible.length - MSG_PAGE_SIZE);
  state.detail = { ...ctx, messages: visible, start };
  renderInitialBatch(messagesEl);
  renderEmptyView(messagesEl);
  refreshPanels();
  rerunMsgSearch();
  // 滚到底（要等浏览器布局完成）
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (afterLayout) afterLayout();
  });
}

const MSG_PAGE_SIZE = 100;
const HIDDEN_ROLES = new Set(['tool_result']);
// "有视觉价值"的工具：即便消息里没有文字，也要展示这些工具调用（因为有 diff 等可视化）
const VISIBLE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']);

function renderMessageGroup(container, slice, ctx = state.detail) {
  // 按 sidechain 连续分组渲染；返回首个新建节点
  const firstBefore = container.firstChild;
  let i = 0;
  while (i < slice.length) {
    const msg = slice[i];
    if (!msg.sidechain) {
      container.appendChild(renderMessage(msg, ctx));
      i++;
      continue;
    }
    let j = i;
    while (j < slice.length && slice[j].sidechain) j++;
    container.appendChild(renderSidechainGroup(slice.slice(i, j), ctx));
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

// upTo：至少渲染到这条消息（定位时用，定位方自己负责滚动）
function renderEarlierBatch(container, upTo) {
  const d = state.detail;
  if (!d || d.start <= 0) return;
  const newStart = Math.max(0, Math.min(d.start - MSG_PAGE_SIZE, upTo === undefined ? Infinity : upTo));
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
  markSearchHits();
  // 恢复滚动位置（让原 anchor 元素停在原视觉位置）
  if (anchor && upTo === undefined) {
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

function renderSidechainGroup(segment, ctx) {
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
  for (const m of segment) body.appendChild(renderMessage(m, ctx));
  header.addEventListener('click', () => wrap.classList.toggle('open'));
  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

async function promptRename(sessionId, current) {
  const input = await askDialog({ title: '重命名会话', message: '输入会话名称（留空则清除）', input: current });
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
    if (state.currentId === sessionId) refreshCurrentDetail();
  } catch (e) {
    showError('重命名失败: ' + e.message);
  }
}

function renderMessage(msg, ctx = state.detail) {
  const wrap = document.createElement('div');
  const cssRole = msg.role === 'tool_result' ? 'tool-result'
                 : msg.role === 'command_output' ? 'command-output'
                 : msg.role;
  wrap.className = 'msg msg-' + cssRole;
  wrap.dataset.i = msg.i;

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
      wrap.appendChild(renderBlock(block, msg.role, ctx));
    }
  }
  return wrap;
}

function renderImage(src) {
  const link = document.createElement('a');
  link.className = 'msg-image-link';
  link.href = src;
  link.title = '查看大图';
  link.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openImageViewer(src, link);
  });
  const img = document.createElement('img');
  img.className = 'msg-image';
  img.src = src;
  img.alt = '消息中的图片';
  img.loading = 'lazy';
  link.appendChild(img);
  return link;
}

function renderBlock(block, role, ctx) {
  if (block.type === 'image') return renderImage(block.src);
  if (block.type === 'text') {
    const el = document.createElement('div');
    el.className = 'msg-text';
    if (role === 'assistant') {
      el.innerHTML = renderMarkdownLite(block.text);
    } else {
      // 用户输入和命令输出原样显示，粘贴的日志、标签不当作 Markdown/HTML 解析
      el.classList.add('msg-plain');
      el.textContent = block.text;
    }
    return el;
  }
  if (block.type === 'thinking') {
    const el = document.createElement('details');
    el.className = 'thinking-block';
    el.innerHTML = `<summary>💭 思考过程（点击展开）</summary><div style="margin-top:6px;white-space:pre-wrap;">${escapeHtml(block.text)}</div>`;
    return el;
  }
  if (block.type === 'tool_use') {
    return renderToolUse(block, ctx);
  }
  if (block.type === 'tool_result') {
    return renderToolResult(block);
  }
  const el = document.createElement('div');
  el.textContent = JSON.stringify(block);
  return el;
}

// 工具块上和结果相关的部分（失败标记、子 Agent 入口、结果内容）。结果可能晚于调用到达，所以可重复执行
function attachToolResult(el, block, ctx) {
  const result = ctx.results.get(block.id);
  const agentId = (result && result.agentId) || ctx.agentByTool.get(block.id);
  const summary = el.querySelector('.tool-summary');
  if (agentId && !summary.querySelector('.tool-agent-btn')) {
    const btn = document.createElement('button');
    btn.className = 'tool-agent-btn';
    btn.textContent = '查看子 Agent 过程';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openDrawer({ kind: 'agent', agentId });
    });
    summary.appendChild(btn);
  }
  if (!result) {
    el.dataset.pending = '1';
    return;
  }
  delete el.dataset.pending;
  if (result.is_error) {
    el.classList.add('has-error');
    const badge = document.createElement('span');
    badge.className = 'tool-error-badge';
    badge.textContent = '✗ 失败';
    summary.insertBefore(badge, summary.querySelector('.tool-preview'));
  }
  if (!ctx.showResults) return;
  const detail = el.querySelector('.tool-detail');
  const label = document.createElement('div');
  label.className = 'tool-label';
  label.textContent = result.is_error ? '错误信息' : '结果';
  detail.appendChild(label);
  const pre = document.createElement('pre');
  pre.textContent = result.text || '(空)';
  detail.appendChild(pre);
  for (const src of result.images || []) detail.appendChild(renderImage(src));
}

function renderToolUse(block, ctx) {
  const el = document.createElement('div');
  el.className = 'tool-block';
  // 只看错误时，错误信息就是要看的内容，默认展开
  if (ctx === state.detail && state.viewMode === 'errors') el.classList.add('open');
  el.dataset.toolId = block.id;
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

  attachToolResult(el, block, ctx);
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
  // 消息里的 HTML 一律按文字显示
  marked.use({ renderer: { html: (html) => escapeHtml(typeof html === 'string' ? html : html.text) } });
}
function renderMarkdownLite(text) {
  if (!text) return '';
  // DOMPurify 没加载到时不信任 marked 的输出（如 javascript: 链接），退化为纯文本
  if (!window.marked || !window.DOMPurify) return escapeHtml(text).replace(/\n/g, '<br>');
  try {
    return DOMPurify.sanitize(marked.parse(text));
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

// ---- 图片弹窗 ----
const imageViewer = $('#image-viewer');
const imageViewerImg = $('#image-viewer-img');
let imageViewerOpener = null;

// 按原始清晰度显示：1 个图片像素对应 1 个屏幕物理像素，不缩放，比窗口大时滚动查看。
// 不能直接设 width = 原图宽 / 屏幕倍率：结果不是整数时（如 1919 / 2）浏览器布局会取整，图片被轻微拉伸而变糊。
// 所以布局上保持原图的整数尺寸，用 transform 缩放，位置也对齐到物理像素
function layoutImageViewer() {
  const dpr = window.devicePixelRatio;
  const offset = (space, size) => Math.max(24, Math.floor((space - size / dpr) / 2 * dpr) / dpr);
  const x = offset(imageViewer.clientWidth, imageViewerImg.naturalWidth);
  const y = offset(imageViewer.clientHeight, imageViewerImg.naturalHeight);
  imageViewerImg.style.transform = `translate(${x}px, ${y}px) scale(${1 / dpr})`;
  $('#image-viewer-info').textContent = `原图 ${imageViewerImg.naturalWidth}×${imageViewerImg.naturalHeight} · 未缩放 · 屏幕倍率 ${+dpr.toFixed(2)}x`;
}
imageViewerImg.addEventListener('load', () => {
  layoutImageViewer();
  imageViewerImg.style.visibility = 'visible';
});
window.addEventListener('resize', () => {
  if (!imageViewer.hidden && imageViewerImg.naturalWidth) layoutImageViewer();
});

function openImageViewer(src, opener) {
  imageViewerImg.style.visibility = 'hidden'; // 算好尺寸再显示，避免闪一下
  imageViewerImg.src = src;
  imageViewer.hidden = false;
  imageViewer.scrollTo(0, 0);
  imageViewerOpener = opener;
  $('#image-viewer-close').focus();
}

function closeImageViewer() {
  imageViewer.hidden = true;
  imageViewerImg.removeAttribute('src');
  if (imageViewerOpener) imageViewerOpener.focus();
  imageViewerOpener = null;
}

// 点击任意位置都关闭，包括图片本身
imageViewer.addEventListener('click', closeImageViewer);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !imageViewer.hidden) closeImageViewer();
});

// ---- 消息定位 ----
const msgSearchInput = $('#msg-search');
const msgSearchCount = $('#msg-search-count');
const msgSearchHint = $('#msg-search-hint');
const viewModesEl = $('#view-modes');

// 滚到展示列表第 i 条：未渲染的先渲染，折叠的先展开，优先对准其中的搜索命中
function revealMessage(i, { flash = true } = {}) {
  const d = state.detail;
  if (!d || !d.messages[i]) return null;
  if (i < d.start) renderEarlierBatch(messagesEl, i);
  const el = messagesEl.querySelector(`.msg[data-i="${i}"]`);
  if (!el) return null;
  const group = el.closest('.sidechain-group');
  if (group) group.classList.add('open');
  const mark = el.querySelector('.msg-mark');
  if (mark) {
    const details = mark.closest('details');
    if (details) details.open = true;
    const tool = mark.closest('.tool-block');
    if (tool) tool.classList.add('open');
    mark.scrollIntoView({ block: 'center' });
  } else {
    el.scrollIntoView({ block: 'start' });
  }
  if (flash) {
    el.classList.remove('msg-flash');
    void el.offsetWidth; // 重复定位同一条时也重新播放动画
    el.classList.add('msg-flash');
  }
  return el;
}

// 按原始消息下标定位：这条在当前模式下被隐藏时，取其后最近的一条
function revealRaw(rawIndex, options) {
  const msgs = state.detail ? state.detail.messages : [];
  if (!msgs.length) return;
  const target = msgs.find(m => m.rawIndex >= rawIndex) || msgs[msgs.length - 1];
  revealMessage(target.i, options);
}

// ---- 显示模式 ----
function syncViewModeButtons() {
  $$('.view-mode', viewModesEl).forEach(b => b.classList.toggle('on', b.dataset.mode === state.viewMode));
}

function setViewMode(mode) {
  if (mode === state.viewMode) return;
  state.viewMode = mode;
  localStorage.setItem(LS_VIEW_MODE, mode);
  syncViewModeButtons();
  const d = state.detail;
  if (!d || !state.currentId) return;
  // 切换后停留在原来看的位置
  const box = messagesEl.getBoundingClientRect();
  const firstVisible = $$('.msg', messagesEl).find(el => el.getBoundingClientRect().bottom > box.top);
  const anchor = firstVisible && d.messages[Number(firstVisible.dataset.i)];
  d.showResults = resultsShownIn(mode);
  d.messages = buildView(d, mode);
  d.start = Math.max(0, d.messages.length - MSG_PAGE_SIZE);
  messagesEl.innerHTML = '';
  renderInitialBatch(messagesEl);
  renderEmptyView(messagesEl);
  rerunMsgSearch();
  if (anchor) revealRaw(anchor.rawIndex, { flash: false });
}

viewModesEl.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.view-mode');
  if (btn) setViewMode(btn.dataset.mode);
});
syncViewModeButtons();

// ---- 会话内搜索 ----
function messageSearchText(m, ctx) {
  const parts = [];
  for (const b of m.blocks) {
    if (b.type === 'text' || b.type === 'thinking') parts.push(b.text);
    else if (b.type === 'tool_use') {
      parts.push(b.name, JSON.stringify(b.input));
      const result = ctx.results.get(b.id);
      if (ctx.showResults && result) parts.push(result.text);
    }
  }
  return parts.join('\n').toLowerCase();
}

function findHits(messages, ctx, query) {
  const q = query.toLowerCase();
  return messages.filter(m => messageSearchText(m, ctx).includes(q)).map(m => m.i);
}

function clearSearchMarks() {
  $$('.msg-mark', messagesEl).forEach(mark => {
    const parent = mark.parentNode;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  $$('.msg[data-marked]', messagesEl).forEach(el => { delete el.dataset.marked; });
  $$('.msg-current', messagesEl).forEach(el => el.classList.remove('msg-current'));
}

function markTextIn(root, query) {
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'msg-mark';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// 给已渲染的命中消息加高亮；新一批消息渲染后也会调用
function markSearchHits() {
  const { query, hits } = state.search;
  if (!query) return;
  for (const i of hits) {
    const el = messagesEl.querySelector(`.msg[data-i="${i}"]:not([data-marked])`);
    if (!el) continue;
    el.dataset.marked = '1';
    markTextIn(el, query);
  }
}

function updateSearchStatus(altCount = 0) {
  const { query, hits, current } = state.search;
  msgSearchCount.textContent = !query ? '' : hits.length ? `${current + 1} / ${hits.length}` : '无结果';
  msgSearchHint.hidden = !altCount;
  msgSearchHint.textContent = altCount ? `全部工具下有 ${altCount} 条` : '';
}

function goToHit(index) {
  const { hits } = state.search;
  if (!hits.length) return;
  state.search.current = (index + hits.length) % hits.length;
  $$('.msg-current', messagesEl).forEach(el => el.classList.remove('msg-current'));
  const el = revealMessage(hits[state.search.current]);
  if (el) el.classList.add('msg-current');
  updateSearchStatus();
}

// 重新计算命中。jump：跳到第一条；否则尽量留在当前这条（实时更新、切模式时）
function runMsgSearch(query, { jump = false } = {}) {
  const d = state.detail;
  const previous = state.search.hits[state.search.current];
  clearSearchMarks();
  const hits = query && d ? findHits(d.messages, d, query) : [];
  state.search = { query, hits, current: hits.length ? Math.max(0, hits.indexOf(previous)) : -1 };
  markSearchHits();
  let altCount = 0;
  if (query && d && !hits.length && state.viewMode !== 'tools') {
    // 当前模式没搜到时，提示切到全部工具可能有
    const allCtx = { ...d, showResults: true };
    altCount = findHits(buildView(allCtx, 'tools'), allCtx, query).length;
  }
  updateSearchStatus(altCount);
  if (jump) goToHit(0);
  else if (state.search.current >= 0) {
    const el = messagesEl.querySelector(`.msg[data-i="${hits[state.search.current]}"]`);
    if (el) el.classList.add('msg-current');
  }
}

function rerunMsgSearch() {
  if (state.search.query) runMsgSearch(state.search.query);
}

function clearMsgSearch() {
  msgSearchInput.value = '';
  runMsgSearch('');
}

function searchFromGlobal(query) {
  const d = state.detail;
  if (!d || !findHits(d.messages, d, query).length) return;
  msgSearchInput.value = query;
  runMsgSearch(query, { jump: true });
}

let msgSearchTimer = null;
msgSearchInput.addEventListener('input', () => {
  clearTimeout(msgSearchTimer);
  msgSearchTimer = setTimeout(() => runMsgSearch(msgSearchInput.value.trim(), { jump: true }), 150);
});
msgSearchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    clearTimeout(msgSearchTimer);
    const q = msgSearchInput.value.trim();
    if (q !== state.search.query) runMsgSearch(q, { jump: true });
    else goToHit(state.search.current + (ev.shiftKey ? -1 : 1));
  } else if (ev.key === 'Escape') {
    clearMsgSearch();
    msgSearchInput.blur();
  }
});
$('#msg-search-next').addEventListener('click', () => goToHit(state.search.current + 1));
$('#msg-search-prev').addEventListener('click', () => goToHit(state.search.current - 1));
msgSearchHint.addEventListener('click', () => {
  setViewMode('tools');
  runMsgSearch(state.search.query, { jump: true });
});
// ⌘F / Ctrl+F：消息是分批渲染的，浏览器自带查找搜不全，先进入会话内搜索；已在搜索框里再按一次则用浏览器的
document.addEventListener('keydown', (ev) => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== 'f') return;
  if (detailContent.hidden || !statsOverlay.hidden || $('.modal:not([hidden])')) return;
  if (document.activeElement === msgSearchInput) return;
  ev.preventDefault();
  msgSearchInput.focus();
  msgSearchInput.select();
});

// ---- 上下文曲线 ----
const contextPanel = $('#context-panel');
const toggleContextBtn = $('#toggle-context');

// 单系列折线：hover 时显示竖线和当前点，两张图联动
function contextChartSVG(values, width, height, fmt) {
  const padL = 46, padR = 12, padT = 10, padB = 8;
  const max = Math.max(...values, 1);
  const xAt = i => padL + (values.length === 1 ? (width - padL - padR) / 2 : i * (width - padL - padR) / (values.length - 1));
  const yAt = v => padT + (height - padT - padB) * (1 - v / max);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(' ');
  const gridLines = [0, max / 2, max].map(v => `
    <line class="cc-grid" x1="${padL}" x2="${width - padR}" y1="${yAt(v)}" y2="${yAt(v)}"/>
    <text class="cc-axis" x="${padL - 6}" y="${yAt(v) + 3}" text-anchor="end">${escapeHtml(fmt(v))}</text>`).join('');
  return {
    xAt,
    yAt,
    svg: `<svg class="cc-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      ${gridLines}
      <path class="cc-line" d="${line}"/>
      <line class="cc-cross" y1="${padT}" y2="${height - padB}" visibility="hidden"/>
      <circle class="cc-dot" r="4" visibility="hidden"/>
    </svg>`,
  };
}

function renderContextPanel() {
  contextPanel.hidden = !state.showContext;
  toggleContextBtn.classList.toggle('on', state.showContext);
  const d = state.detail;
  if (!state.showContext || !d) return;
  const points = d.timeline;
  if (!points.length) {
    contextPanel.innerHTML = '<div class="stats-empty">本会话没有 token 记录</div>';
    return;
  }
  let total = 0;
  const cumulative = points.map(p => (total += p.costUSD));
  const contexts = points.map(p => p.context);
  const peak = Math.max(...contexts);
  const lastModel = points[points.length - 1].model;
  const win = contextWindowFor(lastModel);
  contextPanel.innerHTML = `
    <div class="cc-chart">
      <div class="cc-title">上下文大小 <b>峰值 ${fmtTokens(peak)}</b>${win ? ` <span>/ ${fmtTokens(win)}（${Math.round(peak * 100 / win)}%）</span>` : ''}</div>
      <div class="cc-plot" role="img" aria-label="上下文大小随轮次变化，共 ${points.length} 轮，峰值 ${fmtTokens(peak)}"></div>
    </div>
    <div class="cc-chart">
      <div class="cc-title">累计花费 <b>${fmtUSD(total)}</b> <span>共 ${points.length} 轮</span></div>
      <div class="cc-plot" role="img" aria-label="累计花费随轮次变化，合计 ${fmtUSD(total)}"></div>
    </div>
    <div class="cc-tooltip" hidden></div>
  `;
  const plots = $$('.cc-plot', contextPanel);
  const tooltip = $('.cc-tooltip', contextPanel);
  const charts = [
    { values: contexts, fmt: fmtTokens },
    { values: cumulative, fmt: total < 10 ? fmtUSD : fmtUSDShort }, // 金额小时取整会出现重复刻度
  ].map((c, n) => {
    const chart = contextChartSVG(c.values, Math.max(240, plots[n].clientWidth), 96, c.fmt);
    plots[n].innerHTML = chart.svg;
    return { ...chart, values: c.values, plot: plots[n] };
  });
  const indexAt = (ev, plot) => {
    const x = ev.clientX - plot.getBoundingClientRect().left;
    let best = 0;
    for (let i = 0; i < points.length; i++) {
      if (Math.abs(charts[0].xAt(i) - x) < Math.abs(charts[0].xAt(best) - x)) best = i;
    }
    return best;
  };
  const hide = () => {
    tooltip.hidden = true;
    $$('.cc-cross, .cc-dot', contextPanel).forEach(el => el.setAttribute('visibility', 'hidden'));
  };
  for (const { plot } of charts) {
    plot.addEventListener('pointermove', (ev) => {
      const i = indexAt(ev, plot);
      for (const c of charts) {
        const cross = $('.cc-cross', c.plot);
        const dot = $('.cc-dot', c.plot);
        cross.setAttribute('x1', c.xAt(i));
        cross.setAttribute('x2', c.xAt(i));
        cross.setAttribute('visibility', 'visible');
        dot.setAttribute('cx', c.xAt(i));
        dot.setAttribute('cy', c.yAt(c.values[i]));
        dot.setAttribute('visibility', 'visible');
      }
      const p = points[i];
      tooltip.innerHTML = `
        <div class="cc-tip-head">第 ${i + 1} 轮 · ${fmtTime(p.timestamp)}</div>
        <div>上下文 <b>${fmtTokens(p.context)}</b></div>
        <div>本轮输出 <b>${fmtTokens(p.output)}</b> · 花费 <b>${fmtUSD(p.costUSD)}</b></div>
        <div>累计花费 <b>${fmtUSD(cumulative[i])}</b></div>
        <div class="cc-tip-foot">${escapeHtml(p.model || '')} · 点击定位到消息</div>`;
      tooltip.hidden = false;
      const box = contextPanel.getBoundingClientRect();
      const left = Math.min(ev.clientX - box.left + 14, box.width - tooltip.offsetWidth - 8);
      tooltip.style.left = `${Math.max(8, left)}px`;
    });
    plot.addEventListener('pointerleave', hide);
    plot.addEventListener('click', (ev) => revealRaw(points[indexAt(ev, plot)].messageIndex));
  }
}

toggleContextBtn.addEventListener('click', () => {
  state.showContext = !state.showContext;
  localStorage.setItem('cv.showContext', state.showContext ? '1' : '0');
  renderContextPanel();
});
window.addEventListener('resize', () => { if (state.showContext && !detailContent.hidden) renderContextPanel(); });

// ---- 本会话改动的文件 ----
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function editPairs(name, input) {
  if (name === 'Edit') return [[input.old_string || '', input.new_string || '']];
  if (name === 'Write') return [['', input.content || '']];
  if (name === 'MultiEdit') return (input.edits || []).map(e => [e.old_string || '', e.new_string || '']);
  if (name === 'NotebookEdit') return [[input.old_source || '', input.new_source || '']];
  return [];
}

function countLines(s) {
  return s ? s.replace(/\n$/, '').split('\n').length : 0;
}

function countPairs(pairs) {
  let added = 0, removed = 0;
  for (const [oldStr, newStr] of pairs) {
    if (!window.Diff) { added += countLines(newStr); removed += countLines(oldStr); continue; }
    for (const p of Diff.diffLines(oldStr, newStr)) {
      if (p.added) added += countLines(p.value);
      else if (p.removed) removed += countLines(p.value);
    }
  }
  return { added, removed };
}

function countHunks(hunks) {
  let added = 0, removed = 0;
  for (const h of hunks) {
    for (const line of h.lines || []) {
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return { added, removed };
}

// 优先用工具结果里的实际改动（含 Bash 改的文件）；没有结果（运行中、旧版本记录）或失败时才看工具参数
function buildFileChanges(d) {
  const files = new Map();
  const add = (file, change) => {
    if (!file) return;
    if (!files.has(file)) files.set(file, { file, changes: [], added: 0, removed: 0, lastIndex: 0, failedOnly: true });
    const f = files.get(file);
    f.changes.push(change);
    f.lastIndex = change.rawIndex;
    if (change.failed) return;
    f.failedOnly = false;
    f.added += change.added;
    f.removed += change.removed;
  };
  d.raw.forEach((m, rawIndex) => {
    if (m.role !== 'assistant') return;
    for (const b of m.blocks) {
      if (b.type !== 'tool_use') continue;
      const result = d.results.get(b.id);
      const base = { tool: b.name, rawIndex, timestamp: m.timestamp };
      if (result && result.patch) {
        for (const p of result.patch) {
          if (p.hunks.length) {
            add(p.file, { ...base, hunks: p.hunks, ...countHunks(p.hunks) });
          } else {
            // 新建文件没有 hunk；Bash 改动可能只给文件名
            const pairs = editPairs(b.name, b.input || {});
            add(p.file, { ...base, pairs, ...countPairs(pairs) });
          }
        }
      } else if (EDIT_TOOLS.has(b.name)) {
        const input = b.input || {};
        const pairs = editPairs(b.name, input);
        add(input.file_path || input.notebook_path, {
          ...base, pairs, ...countPairs(pairs), failed: !!(result && result.is_error),
        });
      }
    }
  });
  return [...files.values()].sort((a, b) => b.lastIndex - a.lastIndex);
}

function buildHunkView(hunks) {
  const view = document.createElement('div');
  view.className = 'diff-view';
  hunks.forEach((h) => {
    const head = document.createElement('div');
    head.className = 'diff-hunk-head';
    head.textContent = `第 ${h.newStart} 行`;
    view.appendChild(head);
    for (const line of h.lines || []) {
      const cls = line[0] === '+' ? 'diff-add' : line[0] === '-' ? 'diff-del' : 'diff-eq';
      const row = document.createElement('div');
      row.className = 'diff-line ' + cls;
      row.innerHTML = `<span class="diff-mark">${escapeHtml(line[0] || ' ')}</span><span class="diff-text">${escapeHtml(line.slice(1)) || '&#8203;'}</span>`;
      view.appendChild(row);
    }
  });
  return view;
}

function renderFileChange(change) {
  const wrap = document.createElement('div');
  wrap.className = 'fc-change';
  const head = document.createElement('div');
  head.className = 'fc-change-head';
  head.innerHTML = `
    <span class="tool-name">${escapeHtml(change.tool)}</span>
    <span class="fc-time">${fmtTime(change.timestamp)}</span>
    ${change.failed ? '<span class="tool-error-badge">✗ 未生效</span>'
      : `<span class="fc-stat"><span class="fc-add">+${change.added}</span> <span class="fc-del">−${change.removed}</span></span>`}
    <button class="fc-locate">定位到消息</button>
  `;
  head.querySelector('.fc-locate').addEventListener('click', () => revealRaw(change.rawIndex));
  wrap.appendChild(head);
  if (change.hunks) {
    wrap.appendChild(buildHunkView(change.hunks));
  } else if (change.pairs.some(([oldStr, newStr]) => oldStr || newStr)) {
    for (const [oldStr, newStr] of change.pairs) wrap.appendChild(buildDiffView(oldStr, newStr));
  } else {
    const note = document.createElement('div');
    note.className = 'fc-note';
    note.textContent = '只记录了改动的文件名，没有具体差异';
    wrap.appendChild(note);
  }
  return wrap;
}

function renderFilesDrawer(body) {
  const files = buildFileChanges(state.detail);
  if (!files.length) {
    body.innerHTML = '<div class="view-empty">本会话没有改动文件</div>';
    return;
  }
  for (const f of files) {
    const item = document.createElement('div');
    item.className = 'fc-file' + (state.openFiles.has(f.file) ? ' open' : '') + (f.failedOnly ? ' failed' : '');
    const name = f.file.split(/[\\/]/).pop();
    const dir = shortProject(f.file.slice(0, f.file.length - name.length));
    const head = document.createElement('div');
    head.className = 'fc-file-head';
    head.title = f.file;
    head.innerHTML = `
      <span class="tool-caret">▶</span>
      <span class="fc-name">${escapeHtml(name)}<span class="fc-dir">${escapeHtml(dir)}</span></span>
      <span class="fc-count">${f.changes.length} 次</span>
      <span class="fc-stat"><span class="fc-add">+${f.added}</span> <span class="fc-del">−${f.removed}</span></span>
    `;
    const changes = document.createElement('div');
    changes.className = 'fc-changes';
    const fill = () => { changes.innerHTML = ''; f.changes.forEach(c => changes.appendChild(renderFileChange(c))); };
    if (state.openFiles.has(f.file)) fill();
    head.addEventListener('click', () => {
      const open = item.classList.toggle('open');
      if (open) { state.openFiles.add(f.file); fill(); } else state.openFiles.delete(f.file);
    });
    item.appendChild(head);
    item.appendChild(changes);
    body.appendChild(item);
  }
}

// ---- 子 Agent ----
function agentLabel(a) {
  return a.description || a.name || (a.skillName ? `技能 ${a.skillName}` : a.agentId);
}

function renderAgentsDrawer(body) {
  const { agents } = state.detail;
  if (!agents.length) {
    body.innerHTML = '<div class="view-empty">本会话没有子 Agent</div>';
    return;
  }
  for (const a of agents) {
    const row = document.createElement('button');
    row.className = 'agent-row';
    row.innerHTML = `
      <span class="agent-name">${escapeHtml(agentLabel(a))}</span>
      <span class="agent-meta">${escapeHtml(a.agentType || (a.skillName ? 'skill' : 'agent'))}${a.finished ? '' : ' · 运行中'} · ${fmtTime(new Date(a.updatedAt).toISOString())}</span>
    `;
    row.addEventListener('click', () => openDrawer({ kind: 'agent', agentId: a.agentId }));
    body.appendChild(row);
  }
}

async function renderAgentDrawer(body, agentId) {
  const sessionId = state.currentId;
  body.innerHTML = '<div class="view-empty">加载中...</div>';
  try {
    const res = await fetch(`/api/sessions/${sessionId}/agents/${agentId}`);
    if (!res.ok) throw new Error('加载失败');
    const data = await res.json();
    // 等待期间切了会话或面板，丢弃结果
    if (state.currentId !== sessionId || !state.drawer || state.drawer.agentId !== agentId) return;
    const ctx = buildDetailCtx(data, true);
    const view = buildView(ctx, 'tools');
    body.innerHTML = '';
    if (!view.length) body.innerHTML = '<div class="view-empty">没有内容</div>';
    renderMessageGroup(body, view, ctx);
    highlightNewCodeBlocks(body);
  } catch (e) {
    if (state.drawer && state.drawer.agentId === agentId) {
      body.innerHTML = `<div class="view-empty">${escapeHtml(e.message)}</div>`;
    }
  }
}

// ---- 右侧面板 ----
const sideDrawer = $('#side-drawer');
const drawerBody = $('#drawer-body');
const toggleFilesBtn = $('#toggle-files');
const toggleAgentsBtn = $('#toggle-agents');

function renderDrawer() {
  const drawer = state.drawer;
  sideDrawer.hidden = !drawer || !state.detail;
  toggleFilesBtn.classList.toggle('on', !!drawer && drawer.kind === 'files');
  toggleAgentsBtn.classList.toggle('on', !!drawer && drawer.kind !== 'files');
  if (sideDrawer.hidden) return;
  $('#drawer-back').hidden = drawer.kind !== 'agent';
  const scrollTop = drawerBody.scrollTop;
  drawerBody.innerHTML = '';
  if (drawer.kind === 'files') {
    $('#drawer-title').textContent = '本会话改动的文件';
    renderFilesDrawer(drawerBody);
    drawerBody.scrollTop = scrollTop;
  } else if (drawer.kind === 'agents') {
    $('#drawer-title').textContent = '子 Agent';
    renderAgentsDrawer(drawerBody);
    drawerBody.scrollTop = scrollTop;
  } else {
    const agent = state.detail.agents.find(a => a.agentId === drawer.agentId);
    $('#drawer-title').textContent = agent ? agentLabel(agent) : '子 Agent';
    renderAgentDrawer(drawerBody, drawer.agentId);
  }
}

function openDrawer(drawer) {
  state.drawer = drawer;
  drawerBody.scrollTop = 0;
  renderDrawer();
}

function toggleDrawer(kind) {
  const same = state.drawer && (state.drawer.kind === kind || (kind === 'agents' && state.drawer.kind === 'agent'));
  openDrawer(same ? null : { kind });
}

toggleFilesBtn.addEventListener('click', () => toggleDrawer('files'));
toggleAgentsBtn.addEventListener('click', () => toggleDrawer('agents'));
$('#drawer-close').addEventListener('click', () => openDrawer(null));
$('#drawer-back').addEventListener('click', () => openDrawer({ kind: 'agents' }));

// 详情数据变化后刷新工具栏和面板。正在看的子 Agent 过程不打断
function refreshPanels() {
  const d = state.detail;
  $('#files-count').textContent = buildFileChanges(d).filter(f => !f.failedOnly).length;
  $('#agents-count').textContent = d.agents.length;
  renderContextPanel();
  if (!state.drawer || state.drawer.kind !== 'agent') renderDrawer();
  else toggleAgentsBtn.classList.add('on');
}

// ---- 通用对话框（替代原生 alert / confirm / prompt）----
// 传 input 时返回输入内容（取消为 null），否则返回 true / false
const dialogModal = $('#dialog-modal');
const dialogInput = $('#dialog-input');
const dialogOk = $('#dialog-ok');
const dialogCancel = $('#dialog-cancel');
let dialogResolve = null;

function closeDialog(confirmed) {
  if (!dialogResolve) return;
  const hasInput = !dialogInput.hidden;
  dialogResolve(hasInput ? (confirmed ? dialogInput.value : null) : confirmed);
  dialogResolve = null;
  dialogModal.hidden = true;
}

function askDialog({ title, message = '', input = null, okText = '确定', danger = false, cancel = true }) {
  closeDialog(false);
  $('#dialog-title').textContent = title;
  $('#dialog-message').textContent = message;
  dialogInput.hidden = input === null;
  dialogInput.value = input === null ? '' : input;
  dialogOk.textContent = okText;
  dialogOk.classList.toggle('btn-danger', danger);
  dialogOk.classList.toggle('btn-primary', !danger);
  dialogCancel.hidden = !cancel;
  dialogModal.hidden = false;
  if (input === null) {
    dialogOk.focus();
  } else {
    dialogInput.focus();
    dialogInput.select();
  }
  return new Promise(resolve => { dialogResolve = resolve; });
}

function showError(message) {
  return askDialog({ title: '操作失败', message, cancel: false });
}

dialogOk.addEventListener('click', () => closeDialog(true));
dialogCancel.addEventListener('click', () => closeDialog(false));
$('.modal-backdrop', dialogModal).addEventListener('click', () => closeDialog(false));
dialogModal.addEventListener('keydown', (ev) => {
  // 阻止冒泡：Esc 只关对话框，不连带关闭下层的标签弹窗或统计页
  ev.stopPropagation();
  if (ev.key === 'Escape') closeDialog(false);
  else if (ev.key === 'Enter' && ev.target === dialogInput) closeDialog(true);
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
    row.querySelector('.tag-row-rename').addEventListener('click', async () => {
      const t = tagById(id); if (!t) return;
      const newName = await askDialog({ title: '重命名标签', message: '新名称', input: t.name });
      if (newName === null) return;
      updateTag(id, { name: newName.trim() });
    });
    row.querySelector('.tag-row-delete').addEventListener('click', async () => {
      const t = tagById(id); if (!t) return;
      const ok = await askDialog({
        title: '删除标签',
        message: `删除标签「${t.name}」？\n所有会话上的此标签都会被解绑。`,
        okText: '删除',
        danger: true,
      });
      if (ok) deleteTag(id);
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
  } catch (e) { showError('更新失败: ' + e.message); }
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
  } catch (e) { showError('删除失败: ' + e.message); }
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
  } catch (e) { showError('绑定 tag 失败: ' + e.message); }
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

// ---- 统计页视觉辅助 ----
const STATS_ICONS = {
  sessions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  qa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
  input: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  output: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  cost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
};
const MODEL_COLORS = ['#22d3ee', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#f87171'];

function fmtUSD(n) {
  return '$' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtUSDShort(n) {
  n = n || 0;
  if (n >= 1000) return '$' + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + n.toFixed(0);
}
function animateCount(el, to, fmt) {
  const dur = 1000, t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = fmt(to * e);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
function kpiCard({ icon, label, accent, glow, valueTo, fmt, sub, extraClass = '', badge = '' }) {
  return `<div class="kpi ${extraClass}" style="--kpi-accent:${accent};--kpi-glow:${glow};">
    ${badge ? `<span class="kpi-cost-badge">${badge}</span>` : ''}
    <div class="kpi-top"><span class="kpi-ico">${STATS_ICONS[icon]}</span><span class="kpi-label">${label}</span></div>
    <div class="kpi-value" data-count="${valueTo}" data-fmt="${fmt}">0</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

// SVG 环形图（按花费分段），返回 svg 字符串
function donutSVG(items, centerVal, centerLabel) {
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const R = 62, C = 2 * Math.PI * R, cx = 85, cy = 85;
  let offset = 0;
  const segs = items.map((it, i) => {
    const frac = it.value / total;
    const len = frac * C;
    const dash = `${len} ${C - len}`;
    const seg = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${it.color}" stroke-width="14"
      stroke-dasharray="${dash}" stroke-dashoffset="${-offset}" stroke-linecap="butt"
      transform="rotate(-90 ${cx} ${cy})" style="filter:drop-shadow(0 0 6px ${it.color});">
      <animate attributeName="stroke-dashoffset" from="${-C}" to="${-offset}" dur="0.9s" fill="freeze" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1"/></circle>`;
    offset += len;
    return seg;
  }).join('');
  return `<svg class="donut" viewBox="0 0 170 170">
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(120,170,255,0.08)" stroke-width="14"/>
    ${segs}
    <text class="donut-center-v" x="${cx}" y="${cy - 2}" text-anchor="middle" dominant-baseline="middle">${centerVal}</text>
    <text class="donut-center-l" x="${cx}" y="${cy + 18}" text-anchor="middle">${centerLabel}</text>
  </svg>`;
}

// SVG 面积图（每日输入 token 趋势）；W = 实际像素宽，1:1 渲染避免拉伸失真
function areaChartSVG(daily, W = 900) {
  const H = 180, padB = 22, padT = 12, padX = 6;
  if (!daily.length) return '<div class="stats-empty">无数据</div>';
  const max = Math.max(...daily.map(d => d.totalInput), 1);
  const n = daily.length;
  const xAt = i => padX + (n === 1 ? W / 2 : i * (W - 2 * padX) / (n - 1));
  const yAt = v => padT + (H - padB - padT) * (1 - v / max);
  const pts = daily.map((d, i) => [xAt(i), yAt(d.totalInput)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = `M${pts[0][0].toFixed(1)} ${(H - padB).toFixed(1)} ` +
    pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') +
    ` L${pts[n - 1][0].toFixed(1)} ${(H - padB).toFixed(1)} Z`;
  const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" fill="#22d3ee" style="filter:drop-shadow(0 0 4px #22d3ee)"><title>${daily[i].day} · ${fmtTokens(daily[i].totalInput)}↑ · ${daily[i].count} 会话</title></circle>`).join('');
  const step = Math.max(1, Math.ceil(n / 8));
  const labels = daily.map((d, i) => (i % step === 0 || i === n - 1)
    ? `<text class="axis-label" x="${xAt(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>` : '').join('');
  return `<svg class="area-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" shape-rendering="geometricPrecision">
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(34,211,238,0.45)"/>
        <stop offset="100%" stop-color="rgba(34,211,238,0.02)"/>
      </linearGradient>
      <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#3b82f6"/><stop offset="55%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#a78bfa"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#areaGrad)"/>
    <path d="${line}" fill="none" stroke="url(#lineGrad)" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 5px rgba(34,211,238,0.45))"/>
    ${dots}${labels}
  </svg>`;
}

// 花费构成堆叠条：4 类 token 各自的美元占比
function costBreakdownHTML(cb, total) {
  if (!cb || !total) return '';
  const items = [
    { key: 'output', label: '输出', color: '#f472b6' },
    { key: 'cacheRead', label: '缓存读', color: '#22d3ee' },
    { key: 'cacheCreation', label: '缓存写', color: '#a78bfa' },
    { key: 'inputUncached', label: '未缓存输入', color: '#34d399' },
  ].map(it => ({ ...it, val: cb[it.key] || 0, pct: total ? (cb[it.key] || 0) / total * 100 : 0 }))
    .sort((a, b) => b.val - a.val);
  const segs = items.filter(i => i.pct > 0.05).map(i =>
    `<span class="cb-seg" style="width:0;background:${i.color};" data-w="${i.pct.toFixed(2)}" title="${i.label} ${fmtUSD(i.val)} · ${i.pct.toFixed(1)}%"></span>`).join('');
  const legend = items.map(i =>
    `<div class="cb-item">
      <span class="cb-dot" style="background:${i.color};"></span>
      <span class="cb-label">${i.label}</span>
      <span class="cb-val">${fmtUSD(i.val)}</span>
      <span class="cb-pct">${i.pct.toFixed(1)}%</span>
    </div>`).join('');
  return `<div class="cost-break">
    <div class="cb-title">花费构成 · 按 token 类型</div>
    <div class="cb-bar">${segs}</div>
    <div class="cb-legend">${legend}</div>
  </div>`;
}

function renderStats(data) {
  const T = data.totals;
  const hitPct = Math.round(T.cacheHitRate * 100);

  const cards = [
    kpiCard({ icon: 'sessions', label: '总会话', accent: '#38bdf8', glow: 'rgba(56,189,248,0.4)', valueTo: T.sessions, fmt: 'int' }),
    kpiCard({ icon: 'qa', label: '总问答', accent: '#a78bfa', glow: 'rgba(167,139,250,0.4)', valueTo: T.assistantMessages, fmt: 'int', sub: `${T.userMessages} 问 · ${T.assistantMessages} 答` }),
    kpiCard({ icon: 'input', label: '累计输入', accent: '#22d3ee', glow: 'rgba(34,211,238,0.4)', valueTo: T.input, fmt: 'tok', sub: `缓存命中 ${hitPct}%` }),
    kpiCard({ icon: 'output', label: '累计输出', accent: '#f472b6', glow: 'rgba(244,114,182,0.4)', valueTo: T.output, fmt: 'tok' }),
    kpiCard({ icon: 'cost', label: '预计花费 (USD)', accent: '#34d399', glow: 'rgba(52,211,153,0.45)', valueTo: T.estimatedCostUSD, fmt: 'usd', extraClass: 'kpi-cost', badge: '按官方单价估算', sub: `输入 ${fmtTokens(T.inputUncached)} · 缓存写 ${fmtTokens(T.cacheCreation)} · 缓存读 ${fmtTokens(T.cacheRead)} · 输出 ${fmtTokens(T.output)}` }),
  ].join('');

  const maxProjInput = Math.max(...data.topProjects.map(p => p.totalInput), 1);
  const projRows = data.topProjects.slice(0, 12).map(p => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(p.project)}">${escapeHtml(shortProject(p.project))}</span>
      <span class="bar-track"><span class="bar-fill" data-w="${(p.totalInput / maxProjInput * 100).toFixed(1)}"></span></span>
      <span class="bar-meta">${p.count} · ${fmtTokens(p.totalInput)}↑ ${fmtTokens(p.totalOutput)}↓</span>
    </div>`).join('');

  const topSessRows = data.topSessions.slice(0, 10).map((s, i) => {
    const label = s.customName || s.aiTitle || (s.titlePreview || '').slice(0, 60);
    return `<div class="top-sess" data-id="${s.sessionId}">
      <span class="ts-rank">${i + 1}</span>
      <span class="ts-main">
        <div class="ts-label">${escapeHtml(label)}</div>
        <div class="ts-proj">${escapeHtml(shortProject(s.projectPath))}</div>
      </span>
      <span class="ts-tokens"><span class="ts-cost">${fmtUSD(s.estimatedCostUSD || 0)}</span>${fmtTokens(s.totalInput)}↑ ${fmtTokens(s.totalOutput)}↓</span>
    </div>`;
  }).join('');

  // 模型分布：环形（按花费）+ 图例
  const donutItems = data.byModel.filter(m => m.costUSD > 0).map((m, i) => ({
    color: MODEL_COLORS[i % MODEL_COLORS.length], value: m.costUSD, model: m.model,
  }));
  const donut = donutItems.length
    ? donutSVG(donutItems, fmtUSDShort(T.estimatedCostUSD), '总花费')
    : '';
  const legend = data.byModel.map((m, i) => `
    <div class="legend-item">
      <span class="legend-swatch" style="background:${MODEL_COLORS[i % MODEL_COLORS.length]};color:${MODEL_COLORS[i % MODEL_COLORS.length]};"></span>
      <span class="legend-name" title="${escapeHtml(m.model)}">${escapeHtml(m.model)}</span>
      <span class="legend-val">${m.count} 会话 · <span class="legend-cost">${fmtUSD(m.costUSD)}</span></span>
    </div>`).join('');

  statsBody.innerHTML = `
    <div class="stats-cards">${cards}</div>
    <div class="stats-grid">
      <section class="panel model-panel">
        <h3><span class="dot"></span>模型分布 · 花费占比</h3>
        <div class="donut-wrap">${donut}<div class="legend">${legend || '<div class="stats-empty">无数据</div>'}</div></div>
        ${costBreakdownHTML(T.costBreakdown, T.estimatedCostUSD)}
      </section>
      <section class="panel">
        <h3><span class="dot" style="background:#a78bfa;box-shadow:0 0 10px #a78bfa"></span>消耗最大的会话 · Top 10</h3>
        <div class="top-sess-list">${topSessRows || '<div class="stats-empty">无数据</div>'}</div>
      </section>
      <section class="panel wide">
        <h3><span class="dot" style="background:#22d3ee;box-shadow:0 0 10px #22d3ee"></span>每日活跃度 · 输入 token 趋势</h3>
        <div class="area-host">${areaChartSVG(data.daily)}</div>
      </section>
      <section class="panel wide">
        <h3><span class="dot" style="background:#3b82f6;box-shadow:0 0 10px #3b82f6"></span>按项目 · 输入 token (Top ${Math.min(12, data.topProjects.length)})</h3>
        <div class="bar-list">${projRows || '<div class="stats-empty">无数据</div>'}</div>
      </section>
    </div>
  `;

  // 数字滚动动画
  statsBody.querySelectorAll('.kpi-value[data-count]').forEach(el => {
    const to = parseFloat(el.dataset.count) || 0;
    const kind = el.dataset.fmt;
    const fmt = kind === 'usd' ? fmtUSD : kind === 'tok' ? fmtTokens : (v => Math.round(v).toLocaleString('en-US'));
    animateCount(el, to, fmt);
  });
  // 柱子/堆叠条入场动画
  requestAnimationFrame(() => statsBody.querySelectorAll('.bar-fill[data-w], .cb-seg[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; }));
  // 面积图按真实像素宽重绘（1:1，避免拉伸失真）
  _statsDaily = data.daily;
  requestAnimationFrame(renderAreaAtRealWidth);
  // 点击 Top 会话定位
  statsBody.querySelectorAll('.top-sess').forEach(el => {
    el.addEventListener('click', () => { closeStats(); selectSession(el.dataset.id); });
  });
}

let _statsDaily = [];
function renderAreaAtRealWidth() {
  const host = statsBody.querySelector('.area-host');
  if (!host || !_statsDaily.length) return;
  const w = Math.max(320, Math.round(host.clientWidth));
  host.innerHTML = areaChartSVG(_statsDaily, w);
}
// 窗口尺寸变化时重绘面积图，保持 1:1 清晰
window.addEventListener('resize', () => {
  if (!statsOverlay.hidden) renderAreaAtRealWidth();
});

$('#stats-btn').addEventListener('click', openStats);
$('#stats-close').addEventListener('click', closeStats);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !statsOverlay.hidden) closeStats();
});

// ---- 主题切换（右上角下拉框） ----
const THEMES = ['dark', 'light', 'blue'];
const LS_THEME = 'cv.theme';
const themeSelect = $('#theme-select');

function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'dark';
  if (t === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  // 只有暗色主题用深色代码块
  $('#hljs-theme').href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/${t === 'dark' ? 'github-dark' : 'github'}.min.css`;
  themeSelect.value = t;
  localStorage.setItem(LS_THEME, t);
}
applyTheme(localStorage.getItem(LS_THEME) || 'dark');
themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

async function loadHomeDir() {
  try {
    const res = await fetch('/api/config');
    state.homeDir = (await res.json()).homeDir || '';
  } catch (e) { console.warn('config 加载失败', e); }
}

// 启动顺序：tag 库 + 用户偏好（pin/fav）+ home 目录 → 再拉会话列表
Promise.all([loadTagLibrary(), loadPreferences(), loadHomeDir()]).then(() => {
  renderTagFilterRow();
  loadSessions();
});

// ---- SSE：文件变化自动同步（离开页面时暂停）----
let eventSource = null;
let detailRefreshTimer = null;
let listRefreshTimer = null;

function applySessionUpdate(meta) {
  // 重新向服务端取列表，搜索词、标签过滤和排序才都是对的
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => loadSessions(state.query), 500);
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

// 只更新头部并追加新消息：不重建已渲染的内容，翻看历史时不跳动、展开的工具块不收起
async function refreshCurrentDetail() {
  const id = state.currentId;
  if (!id) return;
  try {
    const res = await fetch(`/api/sessions/${id}`);
    if (!res.ok) return;
    const data = await res.json();
    if (state.currentId !== id) return;
    const d = state.detail;
    const ctx = buildDetailCtx(data, resultsShownIn(state.viewMode));
    const next = buildView(ctx, state.viewMode);
    const prevLen = d ? d.messages.length : 0;
    const appendOnly = d && next.length >= prevLen
      && (prevLen === 0 || next[prevLen - 1].uuid === d.messages[prevLen - 1].uuid);
    if (!appendOnly) {
      renderDetail(data);
      return;
    }
    renderDetailHeader(data.meta);
    // 原本就在底部附近才跟随新消息
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    Object.assign(d, ctx, { messages: next });
    if (next.length > prevLen) {
      if (!prevLen) messagesEl.innerHTML = '';
      renderMessageGroup(messagesEl, next.slice(prevLen));
    }
    // 之前还没收到结果的工具块，现在补上
    $$('.tool-block[data-pending]', messagesEl).forEach(el => {
      const msg = d.messages[Number(el.closest('.msg').dataset.i)];
      const block = msg && msg.blocks.find(b => b.id === el.dataset.toolId);
      if (block) attachToolResult(el, block, d);
    });
    highlightNewCodeBlocks(messagesEl);
    refreshPanels();
    rerunMsgSearch();
    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
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
