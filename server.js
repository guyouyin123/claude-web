#!/usr/bin/env node
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFile } = require('child_process');
const chokidar = require('chokidar');

// ============== 存储布局 ==============
//
//   ~/.claude-web/bootstrap.json   →  只存 claudeDir 路径覆盖（用户在 UI 改路径时写入）
//
//   <claudeDir>/claude-web/        →  本工具所有用户数据，缺失则创建
//     ├── config.json              tags 库 + 分配
//     ├── session-names.json       会话自定义名映射
//     ├── pinned.json              置顶会话 id 数组
//     └── favorite.json            收藏会话 id 数组
//
// 优先级：env CLAUDE_DIR > bootstrap.json.claudeDir > ~/.claude
// 优先级：env PORT > --port > bootstrap.json.port > 2888

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function atomicWriteJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}
function readJsonOr(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`解析 ${path.basename(filePath)} 失败:`, e.message);
  }
  return fallback;
}

const BOOTSTRAP_DIR = process.env.CLAUDE_WEB_HOME || path.join(os.homedir(), '.claude-web');
const BOOTSTRAP_FILE = path.join(BOOTSTRAP_DIR, 'bootstrap.json');

function readBootstrap() { return readJsonOr(BOOTSTRAP_FILE, {}); }
function writeBootstrap(patch) {
  const merged = { ...readBootstrap(), ...patch };
  atomicWriteJson(BOOTSTRAP_FILE, merged);
  return merged;
}

const BOOT = readBootstrap();
const DEFAULT_PORT = 2888;
const CLAUDE_DIR = process.env.CLAUDE_DIR || BOOT.claudeDir || path.join(os.homedir(), '.claude');
let PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CONFIG = { claudeDir: CLAUDE_DIR, port: Number(process.env.PORT) || BOOT.port || DEFAULT_PORT };

// 应用数据目录（<claudeDir>/claude-web/）
let APP_DIR = path.join(CONFIG.claudeDir, 'claude-web');
function appPath(name) { return path.join(APP_DIR, name); }
function refreshAppPaths() {
  APP_DIR = path.join(CONFIG.claudeDir, 'claude-web');
  ensureDir(APP_DIR);
}
ensureDir(APP_DIR);

function readConfigFile() { return readJsonOr(appPath('config.json'), {}); }
function writeConfigFile(patch) {
  const merged = { ...readConfigFile(), ...patch };
  atomicWriteJson(appPath('config.json'), merged);
  return merged;
}

// 一次性迁移：旧版（项目目录或 ~/.claude-web/data/）的数据搬到新位置
function migrateLegacyData() {
  const candidates = [
    {
      legacyCfg: path.join(__dirname, 'config.json'),
      legacyNames: path.join(__dirname, 'data', 'session-names.json'),
    },
    {
      legacyCfg: path.join(BOOTSTRAP_DIR, 'config.json'),
      legacyNames: path.join(BOOTSTRAP_DIR, 'data', 'session-names.json'),
    },
  ];
  for (const c of candidates) {
    try {
      // 旧 config.json → 拆分：claudeDir 进 bootstrap，其余进 app config
      if (fs.existsSync(c.legacyCfg) && !fs.existsSync(appPath('config.json'))) {
        const legacy = readJsonOr(c.legacyCfg, {});
        // 旧 port 是上版默认 3000，不视为用户主动设置，丢弃；只迁 claudeDir 到 bootstrap
        const { claudeDir: legacyClaudeDir, port: _legacyPort, ...rest } = legacy;
        if (Object.keys(rest).length) atomicWriteJson(appPath('config.json'), rest);
        if (legacyClaudeDir && !readBootstrap().claudeDir) {
          writeBootstrap({ claudeDir: legacyClaudeDir });
        }
        console.log(`[迁移] ${c.legacyCfg} → ${appPath('config.json')}`);
      }
      // 旧 session-names.json
      if (fs.existsSync(c.legacyNames) && !fs.existsSync(appPath('session-names.json'))) {
        const legacy = readJsonOr(c.legacyNames, {});
        if (Object.keys(legacy).length) {
          atomicWriteJson(appPath('session-names.json'), legacy);
          console.log(`[迁移] ${c.legacyNames} → ${appPath('session-names.json')}`);
        }
      }
    } catch (e) {
      console.warn('迁移旧数据失败:', e.message);
    }
  }
}

// 内存索引：sessionId -> { meta, searchText, filePath }
const sessionIndex = new Map();
// 自定义名称：sessionId -> string
let sessionNames = {};
// 置顶 / 收藏：Set<sessionId>
let pinnedSet = new Set();
let favoriteSet = new Set();

function loadNames() {
  sessionNames = readJsonOr(appPath('session-names.json'), {}) || {};
}
function saveNames() {
  atomicWriteJson(appPath('session-names.json'), sessionNames);
}

function loadPinned() {
  const arr = readJsonOr(appPath('pinned.json'), []);
  pinnedSet = new Set(Array.isArray(arr) ? arr : []);
}
function savePinned() {
  atomicWriteJson(appPath('pinned.json'), [...pinnedSet]);
}

function loadFavorite() {
  const arr = readJsonOr(appPath('favorite.json'), []);
  favoriteSet = new Set(Array.isArray(arr) ? arr : []);
}
function saveFavorite() {
  atomicWriteJson(appPath('favorite.json'), [...favoriteSet]);
}

// ---------- Tag 系统 ----------
// 存储在 config.json 的 tags 字段下：
// { library: [{id, name, color}], assignments: { sessionId: [tagId...] } }
const DEFAULT_TAG_COLORS = [
  '#f85149', '#d29922', '#3fb950', '#58a6ff', '#a371f7',
  '#ff7b72', '#ffd33d', '#7ee787', '#79c0ff', '#d2a8ff',
];

let tagLibrary = [];        // [{id, name, color}]
let tagAssignments = {};    // { sessionId: [tagId] }

function loadTags() {
  const cfg = readConfigFile();
  const t = cfg.tags || {};
  tagLibrary = Array.isArray(t.library) ? t.library : [];
  tagAssignments = (t.assignments && typeof t.assignments === 'object') ? t.assignments : {};
}

function saveTags() {
  writeConfigFile({ tags: { library: tagLibrary, assignments: tagAssignments } });
}

function genTagId() {
  return 'tag-' + Math.random().toString(36).slice(2, 10);
}

function pickNextColor() {
  const used = new Set(tagLibrary.map(t => t.color));
  for (const c of DEFAULT_TAG_COLORS) if (!used.has(c)) return c;
  return DEFAULT_TAG_COLORS[tagLibrary.length % DEFAULT_TAG_COLORS.length];
}

function decodeProjectPath(encoded) {
  // 目录名是把绝对路径里的 / 替换为 -，例如 -Users-jeff -> /Users/jeff
  if (encoded.startsWith('-')) {
    return '/' + encoded.slice(1).replace(/-/g, '/');
  }
  return encoded;
}

// ---- 预计花费（USD）：Anthropic 官方单价（每 1M token，2026-10 核对）----
// 按前缀匹配，长前缀必须排在前面。未计入 Fast mode 溢价、Haiku 5.5 超 100K 提示的阶梯价。
const OPUS_4X = { in: 5, out: 25, cr: 0.5 };
const FABLE = { in: 10, out: 50, cr: 1 };
const FABLE_51 = { in: 10, out: 50, cr: 0.25 };
const SONNET_5 = { in: 2, out: 10, cr: 0.2 };
const PRICING = {
  'claude-fable-5-1': FABLE_51,
  'claude-mythos-5-1': FABLE_51,
  'claude-fable': FABLE,
  'claude-mythos': FABLE,
  'claude-opus-5-5': { in: 4, out: 20, cr: 0.2 },
  'claude-opus-5': OPUS_4X,
  'claude-opus-4-8': OPUS_4X,
  'claude-opus-4-7': OPUS_4X,
  'claude-opus-4-6': OPUS_4X,
  'claude-opus-4-5': OPUS_4X,
  'claude-opus-4': { in: 15, out: 75, cr: 1.5 },
  'claude-sonnet-5-5': SONNET_5,
  'claude-sonnet-5': SONNET_5,
  'claude-sonnet-4': { in: 3, out: 15, cr: 0.3 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cr: 0.01 },
  'claude-haiku-4-5': { in: 1, out: 5, cr: 0.1 },
};
function priceFor(model) {
  const m = (model || '').toLowerCase();
  const key = Object.keys(PRICING).find(k => m.startsWith(k));
  if (key) return PRICING[key];
  // 未知模型按同系列当前版本估
  if (m.includes('haiku')) return PRICING['claude-haiku-5-5'];
  if (m.includes('sonnet')) return PRICING['claude-sonnet-5-5'];
  return PRICING['claude-opus-5-5'];
}
// u: API 返回的 usage；缓存写按 TTL 计价（5 分钟 1.25x、1 小时 2x 输入价）
function usageCostUSD(u, model) {
  const p = priceFor(model);
  const write = u.cache_creation_input_tokens || 0;
  const write1h = Math.min(write, (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0);
  return {
    inputUncached: (u.input_tokens || 0) * p.in / 1e6,
    cacheCreation: ((write - write1h) * 1.25 + write1h * 2) * p.in / 1e6,
    cacheRead: (u.cache_read_input_tokens || 0) * p.cr / 1e6,
    output: (u.output_tokens || 0) * p.out / 1e6,
  };
}
function localDay(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 一行消息里的全部图片（含嵌在 tool_result 里的），顺序即图片接口里的序号
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function lineImages(content) {
  if (!Array.isArray(content)) return [];
  const isImage = b => b && b.type === 'image' && b.source && b.source.type === 'base64'
    && IMAGE_TYPES.has(b.source.media_type) && typeof b.source.data === 'string';
  const out = [];
  for (const b of content) {
    if (isImage(b)) out.push(b);
    else if (b && b.type === 'tool_result' && Array.isArray(b.content)) out.push(...b.content.filter(isImage));
  }
  return out;
}

// 从工具结果取实际改动：Edit/Write 的 structuredPatch、Bash 的 bashEditDiff
function extractPatch(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.bashEditDiff && Array.isArray(r.bashEditDiff.files)) {
    const files = r.bashEditDiff.files.map(f => ({ file: f.filePath, hunks: f.hunks || [] }));
    for (const file of r.bashEditDiff.changedFiles || []) {
      if (!files.some(f => f.file === file)) files.push({ file, hunks: [] });
    }
    return files.length ? files : null;
  }
  if (r.filePath && Array.isArray(r.structuredPatch)) {
    return [{ file: r.filePath, hunks: r.structuredPatch }];
  }
  return null;
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

function isRealUserMessage(content) {
  // 真正的用户输入：要么是字符串，要么数组里全是 text 块（没有 tool_result）
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  const hasToolResult = content.some(b => b && b.type === 'tool_result');
  return !hasToolResult;
}

// 识别 Claude Code 自动注入的"伪用户消息"
function extractTagText(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function classifyUserText(text) {
  // 返回 { kind: 'caveat' | 'command' | 'output' | 'plain', display: string }
  const t = (text || '').trim();
  if (!t) return { kind: 'plain', display: '' };
  if (t.startsWith('<local-command-caveat')) {
    return { kind: 'caveat', display: '' };
  }
  if (/<command-(name|message)>/.test(t)) {
    const name = extractTagText(t, 'command-name');
    const args = extractTagText(t, 'command-args');
    const msg = extractTagText(t, 'command-message');
    const head = name || (msg ? '/' + msg : '');
    const display = (head + (args ? ' ' + args : '')).trim();
    if (display) return { kind: 'command', display };
  }
  if (t.startsWith('<local-command-stdout') || t.startsWith('<local-command-stderr')) {
    const stdout = extractTagText(t, 'local-command-stdout');
    const stderr = extractTagText(t, 'local-command-stderr');
    return {
      kind: 'output',
      display: [stdout, stderr].filter(Boolean).join('\n'),
      isError: !!stderr && !stdout,
    };
  }
  return { kind: 'plain', display: t };
}

async function parseSessionFile(filePath, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  let firstUserText = '';
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let startTime = null;
  let endTime = null;
  const searchChunks = [projectPath];

  let totalInput = 0;       // input + cache_creation + cache_read 累计
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalInputUncached = 0;
  let lastContextSize = 0;  // 末次 assistant 的 input + cache_creation + cache_read
  let lastModel = null;
  let aiTitle = '';         // Claude Code 自动生成的标题，会更新，取最后一条
  // 同一条回复按内容块拆成多行、每行带相同 usage，按 message.id 去重后才能累加
  const usageByMessage = new Map();

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const ts = obj.timestamp;
    if (ts) {
      if (!startTime || ts < startTime) startTime = ts;
      if (!endTime || ts > endTime) endTime = ts;
    }

    if (obj.type === 'ai-title' && obj.aiTitle) {
      aiTitle = obj.aiTitle;
    } else if (obj.type === 'user' && obj.message) {
      if (obj.isMeta) continue; // 系统注入的 meta 消息，整体跳过
      const content = obj.message.content;
      if (isRealUserMessage(content)) {
        const text = extractTextFromContent(content).trim();
        if (text) {
          const c = classifyUserText(text);
          if (c.kind === 'caveat' || c.kind === 'output') continue; // 不计入"问"
          const display = c.display || text;
          userMessageCount++;
          if (!firstUserText) firstUserText = display.slice(0, 300);
          searchChunks.push(display);
        }
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const text = extractTextFromContent(obj.message.content).trim();
      if (text) {
        assistantMessageCount++;
        searchChunks.push(text);
      }
      const u = obj.message.usage;
      if (u && typeof u === 'object') {
        usageByMessage.set(obj.message.id || obj.uuid, { u, model: obj.message.model, ts });
        const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (ctx > 0) lastContextSize = ctx;
      }
      if (obj.message.model) lastModel = obj.message.model;
    }
  }

  if (aiTitle) searchChunks.push(aiTitle);

  let estimatedCostUSD = 0;
  const usageByModel = {};  // model -> token 组成 + 各类花费，供全局统计汇总
  const usageByDay = {};    // 本地日期 -> { totalInput, totalOutput }
  for (const { u, model, ts } of usageByMessage.values()) {
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation_input_tokens || 0;
    if (!inp && !out && !cr && !cc) continue;
    totalInputUncached += inp;
    totalCacheRead += cr;
    totalCacheCreation += cc;
    totalInput += inp + cr + cc;
    totalOutput += out;

    const name = model || '(unknown)';
    const mg = usageByModel[name] || (usageByModel[name] = {
      input: 0, inputUncached: 0, cacheRead: 0, cacheCreation: 0, output: 0,
      cost: { inputUncached: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
    });
    mg.input += inp + cr + cc;
    mg.inputUncached += inp;
    mg.cacheRead += cr;
    mg.cacheCreation += cc;
    mg.output += out;
    const cost = usageCostUSD(u, model);
    for (const k of Object.keys(cost)) {
      mg.cost[k] += cost[k];
      estimatedCostUSD += cost[k];
    }

    if (ts) {
      const day = localDay(ts);
      const dg = usageByDay[day] || (usageByDay[day] = { totalInput: 0, totalOutput: 0 });
      dg.totalInput += inp + cr + cc;
      dg.totalOutput += out;
    }
  }

  return {
    meta: {
      sessionId,
      projectPath,
      startTime,
      endTime,
      userMessageCount,
      assistantMessageCount,
      titlePreview: firstUserText || '(无用户消息)',
      aiTitle,
      tokens: {
        totalInput,
        totalOutput,
        totalCacheRead,
        totalCacheCreation,
        totalInputUncached,
        lastContextSize,
        model: lastModel,
      },
      estimatedCostUSD,
    },
    searchText: searchChunks.join('\n').toLowerCase(),
    filePath,
    usageByModel,
    usageByDay,
  };
}

async function buildIndex() {
  sessionIndex.clear();
  if (!fs.existsSync(PROJECTS_DIR)) {
    console.warn('未找到目录:', PROJECTS_DIR);
    return;
  }

  const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let total = 0;
  for (const projDir of projectDirs) {
    const projectPath = decodeProjectPath(projDir);
    const fullProjDir = path.join(PROJECTS_DIR, projDir);
    const files = fs.readdirSync(fullProjDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const filePath = path.join(fullProjDir, f);
      try {
        const entry = await parseSessionFile(filePath, projectPath);
        sessionIndex.set(entry.meta.sessionId, entry);
        total++;
      } catch (e) {
        console.warn('解析失败:', filePath, e.message);
      }
    }
  }
  console.log(`索引完成：${total} 个会话，${projectDirs.length} 个项目`);
}

// agentId：读取的是子 Agent 文件。此时首条消息是任务描述（可能标了 isMeta）要保留，整个文件也不再按 sidechain 分组
async function readSessionMessages(filePath, sessionId, agentId = '') {
  const messages = [];
  const timelineByMessage = new Map(); // message.id -> 上下文曲线的一个点（同一回复多行只算一次）
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let sidechainFlag = false;
  const push = (msg) => { messages.push({ ...msg, sidechain: sidechainFlag }); };
  const imageSrc = (uuid, i) => `/api/sessions/${sessionId}/images/${uuid}/${i}${agentId ? `?agent=${agentId}` : ''}`;
  let isFirstLine = true;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    sidechainFlag = !agentId && !!obj.isSidechain;
    const keepMeta = !!agentId && isFirstLine;
    isFirstLine = false;

    if (obj.type === 'user' && obj.message) {
      if (obj.isMeta && !keepMeta) continue; // 系统注入的 meta 消息，跳过
      const content = obj.message.content;
      if (typeof content === 'string') {
        const c = classifyUserText(content);
        if (c.kind === 'caveat') continue; // 隐藏 caveat
        if (c.kind === 'command') {
          push({
            role: 'user',
            kind: 'command',
            timestamp: obj.timestamp,
            uuid: obj.uuid,
            blocks: [{ type: 'text', text: c.display }],
          });
          continue;
        }
        if (c.kind === 'output') {
          push({
            role: 'command_output',
            timestamp: obj.timestamp,
            uuid: obj.uuid,
            blocks: [{ type: 'text', text: c.display, isError: !!c.isError }],
          });
          continue;
        }
        push({
          role: 'user',
          timestamp: obj.timestamp,
          uuid: obj.uuid,
          blocks: [{ type: 'text', text: content }],
        });
      } else if (Array.isArray(content)) {
        const blocks = [];
        const images = lineImages(content);
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text) {
            blocks.push({ type: 'text', text: b.text });
          } else if (images.includes(b)) {
            blocks.push({ type: 'image', src: imageSrc(obj.uuid, images.indexOf(b)) });
          } else if (b.type === 'tool_result') {
            const resContent = typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.filter(x => x && x.type === 'text').map(x => x.text).join('\n')
                : JSON.stringify(b.content);
            const tur = obj.toolUseResult;
            blocks.push({
              type: 'tool_result',
              tool_use_id: b.tool_use_id,
              is_error: !!b.is_error,
              text: resContent,
              images: Array.isArray(b.content)
                ? b.content.filter(x => images.includes(x)).map(x => imageSrc(obj.uuid, images.indexOf(x)))
                : [],
              patch: extractPatch(tur),
              agentId: (tur && typeof tur === 'object' && tur.agentId) || '',
            });
          }
        }
        if (blocks.length) {
          const hasToolResult = blocks.some(b => b.type === 'tool_result');
          push({
            role: hasToolResult ? 'tool_result' : 'user',
            timestamp: obj.timestamp,
            uuid: obj.uuid,
            blocks,
          });
        }
      }
    } else if (obj.type === 'assistant' && obj.message) {
      const content = obj.message.content;
      const usage = obj.message.usage;
      if (usage && typeof usage === 'object') {
        const key = obj.message.id || obj.uuid;
        const ctx = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
        const prev = timelineByMessage.get(key);
        if (ctx > 0) {
          timelineByMessage.set(key, {
            messageIndex: prev ? prev.messageIndex : messages.length, // 曲线点击时定位到这条消息
            timestamp: obj.timestamp,
            model: obj.message.model,
            context: ctx,
            output: usage.output_tokens || 0,
            costUSD: Object.values(usageCostUSD(usage, obj.message.model)).reduce((s, v) => s + v, 0),
          });
        }
      }
      if (!Array.isArray(content)) continue;
      const blocks = [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'thinking' && b.thinking) {
          blocks.push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          blocks.push({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input,
          });
        }
      }
      if (blocks.length) {
        const u = obj.message.usage || null;
        const usage = u ? {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
        } : null;
        push({
          role: 'assistant',
          timestamp: obj.timestamp,
          uuid: obj.uuid,
          model: obj.message.model,
          usage,
          blocks,
        });
      }
    }
  }
  return { messages, timeline: Array.from(timelineByMessage.values()) };
}

// ---------- 子 Agent：<会话文件同名目录>/subagents/agent-<id>.jsonl ----------
function agentsDir(entry) {
  return path.join(path.dirname(entry.filePath), entry.meta.sessionId, 'subagents');
}

function listAgents(entry) {
  const dir = agentsDir(entry);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^agent-.+\.jsonl$/.test(f))
    .map(f => {
      const agentId = f.slice('agent-'.length, -'.jsonl'.length);
      const meta = readJsonOr(path.join(dir, `agent-${agentId}.meta.json`), {});
      const skill = readJsonOr(path.join(dir, `agent-${agentId}.forked-skill.json`), {});
      return {
        agentId,
        agentType: meta.agentType || '',
        description: meta.description || '',
        name: meta.name || '',
        skillName: skill.skillName || '',
        finished: meta.finished !== false,
        toolUseId: meta.toolUseId || '',
        updatedAt: fs.statSync(path.join(dir, f)).mtimeMs,
      };
    })
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

// agentId 来自 URL，只接受合法字符，防止路径穿越；返回 null 表示不存在
function agentFilePath(entry, agentId) {
  if (!/^[\w-]+$/.test(agentId)) return null;
  const file = path.join(agentsDir(entry), `agent-${agentId}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

// ---------- HTTP ----------
const app = express();
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function metaWithName(meta) {
  return {
    ...meta,
    customName: sessionNames[meta.sessionId] || '',
    tags: tagAssignments[meta.sessionId] || [],
  };
}

app.get('/api/sessions', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const tagFilter = (req.query.tags || '').toString().trim();
  const requiredTags = tagFilter ? tagFilter.split(',').filter(Boolean) : [];

  let list = Array.from(sessionIndex.values()).map(e => metaWithName(e.meta));

  if (q) {
    const tagNameMap = new Map(tagLibrary.map(t => [t.id, (t.name || '').toLowerCase()]));
    const matching = new Set();
    for (const [id, entry] of sessionIndex) {
      const name = (sessionNames[id] || '').toLowerCase();
      const myTagNames = (tagAssignments[id] || []).map(tid => tagNameMap.get(tid) || '').join(' ');
      if (entry.searchText.includes(q) || name.includes(q) || myTagNames.includes(q)) matching.add(id);
    }
    list = list.filter(m => matching.has(m.sessionId));
  }

  if (requiredTags.length) {
    // AND 模式：必须同时拥有所有选中 tag
    list = list.filter(m => {
      const my = new Set(m.tags || []);
      return requiredTags.every(t => my.has(t));
    });
  }

  list.sort((a, b) => (b.endTime || '').localeCompare(a.endTime || ''));
  res.json({ total: list.length, sessions: list });
});

app.get('/api/sessions/:id', async (req, res) => {
  const entry = sessionIndex.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  try {
    const { messages, timeline } = await readSessionMessages(entry.filePath, req.params.id);
    res.json({ meta: metaWithName(entry.meta), messages, timeline, agents: listAgents(entry) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:id/agents/:agentId', async (req, res) => {
  const entry = sessionIndex.get(req.params.id);
  const file = entry && agentFilePath(entry, req.params.agentId);
  if (!file) return res.status(404).json({ error: 'not found' });
  try {
    const { messages } = await readSessionMessages(file, req.params.id, req.params.agentId);
    res.json({ messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 图片以 base64 存在 jsonl 里，总量可达上百 MB，不随消息返回，按需从文件取
app.get('/api/sessions/:id/images/:uuid/:index', async (req, res) => {
  const entry = sessionIndex.get(req.params.id);
  if (!entry) return res.status(404).end();
  const file = req.query.agent ? agentFilePath(entry, String(req.query.agent)) : entry.filePath;
  if (!file) return res.status(404).end();
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let image = null;
  try {
    for await (const line of rl) {
      if (!line.includes(req.params.uuid)) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.uuid !== req.params.uuid) continue;
      image = lineImages(obj.message && obj.message.content)[Number(req.params.index)];
      break;
    }
  } catch (e) {
    return res.status(500).end();
  } finally {
    stream.destroy();
  }
  if (!image) return res.status(404).end();
  res.set({
    'Content-Type': image.source.media_type,
    'Cache-Control': 'private, max-age=86400', // 内容由 uuid 唯一确定，可以缓存
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(Buffer.from(image.source.data, 'base64'));
});

app.post('/api/refresh', async (req, res) => {
  await buildIndex();
  res.json({ ok: true, total: sessionIndex.size });
});

// ---------- 文件变化监听 + SSE ----------
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`: connected\n\n`);
  sseClients.add(res);
  // keepalive ping，防止代理超时断开
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// 用 chokidar 监听 jsonl 文件变化
let watcher = null;
const pendingUpdates = new Map(); // sessionId -> setTimeout id（去抖）

async function handleFileEvent(eventType, filePath) {
  if (!filePath.endsWith('.jsonl')) return;
  const sessionId = path.basename(filePath, '.jsonl');
  const projDir = path.basename(path.dirname(filePath));
  const projectPath = decodeProjectPath(projDir);
  if (eventType === 'unlink') {
    sessionIndex.delete(sessionId);
    sseBroadcast('session-removed', { sessionId });
    return;
  }
  // add / change：debounce 重新解析（jsonl 是追加写，频繁触发）
  if (pendingUpdates.has(sessionId)) clearTimeout(pendingUpdates.get(sessionId));
  pendingUpdates.set(sessionId, setTimeout(async () => {
    pendingUpdates.delete(sessionId);
    try {
      const entry = await parseSessionFile(filePath, projectPath);
      sessionIndex.set(sessionId, entry);
      sseBroadcast('session-updated', {
        sessionId,
        meta: metaWithName(entry.meta),
      });
    } catch (e) {
      console.warn('解析失败 (watcher):', filePath, e.message);
    }
  }, 800));
}

function startWatcher() {
  if (watcher) { try { watcher.close(); } catch {} }
  if (!fs.existsSync(PROJECTS_DIR)) return;
  watcher = chokidar.watch(PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });
  watcher.on('add', p => handleFileEvent('add', p));
  watcher.on('change', p => handleFileEvent('change', p));
  watcher.on('unlink', p => handleFileEvent('unlink', p));
  console.log('文件监听已启动:', PROJECTS_DIR);
}

app.use(express.json());

app.get('/api/config', (req, res) => {
  res.json({
    claudeDir: CONFIG.claudeDir,
    port: CONFIG.port,
    homeDir: os.homedir(),
    projectsDir: PROJECTS_DIR,
    projectsDirExists: fs.existsSync(PROJECTS_DIR),
  });
});

app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const entry = sessionIndex.get(id);
  if (!entry) return res.status(404).json({ error: '会话不存在' });
  try {
    fs.unlinkSync(entry.filePath);
  } catch (e) {
    return res.status(500).json({ error: '删除文件失败: ' + e.message });
  }
  sessionIndex.delete(id);
  if (sessionNames[id]) {
    delete sessionNames[id];
    try { saveNames(); } catch (e) { console.warn('清理名称失败:', e.message); }
  }
  if (pinnedSet.delete(id)) { try { savePinned(); } catch {} }
  if (favoriteSet.delete(id)) { try { saveFavorite(); } catch {} }
  if (tagAssignments[id]) {
    delete tagAssignments[id];
    try { saveTags(); } catch (e) { console.warn('清理标签绑定失败:', e.message); }
  }
  res.json({ ok: true, sessionId: id, deletedFile: entry.filePath });
});

// ---------- 全局统计 ----------
app.get('/api/stats', (req, res) => {
  const entries = Array.from(sessionIndex.values());
  let totalSessions = 0;
  let totalUserMsgs = 0;
  let totalAsstMsgs = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalInputUncached = 0;

  // 按项目 / 按日 / 按模型
  const byProject = new Map();   // projectPath -> { count, totalInput, totalOutput, latest }
  const byDay = new Map();        // YYYY-MM-DD -> { count, totalInput, totalOutput }
  const byModel = new Map();      // model -> { count, input, inputUncached, cacheRead, cacheCreation, output, costUSD }
  const costBreakdown = { inputUncached: 0, cacheCreation: 0, cacheRead: 0, output: 0 };  // 4 类 token 各自的美元

  for (const e of entries) {
    const m = e.meta;
    totalSessions++;
    totalUserMsgs += m.userMessageCount || 0;
    totalAsstMsgs += m.assistantMessageCount || 0;
    const t = m.tokens || {};
    totalInput += t.totalInput || 0;
    totalOutput += t.totalOutput || 0;
    totalCacheRead += t.totalCacheRead || 0;
    totalCacheCreation += t.totalCacheCreation || 0;
    totalInputUncached += t.totalInputUncached || 0;

    // by project
    const p = m.projectPath || '(未知)';
    if (!byProject.has(p)) byProject.set(p, { project: p, count: 0, totalInput: 0, totalOutput: 0, latest: null });
    const pg = byProject.get(p);
    pg.count++;
    pg.totalInput += t.totalInput || 0;
    pg.totalOutput += t.totalOutput || 0;
    if (m.endTime && (!pg.latest || m.endTime > pg.latest)) pg.latest = m.endTime;

    // by day（按消息时间的本地日期）：count = 当天活跃的会话数
    for (const [day, u] of Object.entries(e.usageByDay)) {
      if (!byDay.has(day)) byDay.set(day, { day, count: 0, totalInput: 0, totalOutput: 0 });
      const dg = byDay.get(day);
      dg.count++;
      dg.totalInput += u.totalInput;
      dg.totalOutput += u.totalOutput;
    }

    // by model（按每条消息实际使用的模型累计）：count = 用过该模型的会话数
    for (const [model, u] of Object.entries(e.usageByModel)) {
      if (!byModel.has(model)) byModel.set(model, { model, count: 0, input: 0, inputUncached: 0, cacheRead: 0, cacheCreation: 0, output: 0, costUSD: 0 });
      const mg = byModel.get(model);
      mg.count++;
      mg.input += u.input;
      mg.inputUncached += u.inputUncached;
      mg.cacheRead += u.cacheRead;
      mg.cacheCreation += u.cacheCreation;
      mg.output += u.output;
      for (const k of Object.keys(costBreakdown)) {
        mg.costUSD += u.cost[k];
        costBreakdown[k] += u.cost[k];
      }
    }
  }

  const byModelArr = Array.from(byModel.values()).sort((a, b) => b.costUSD - a.costUSD);
  const estimatedCostUSD = byModelArr.reduce((s, m) => s + m.costUSD, 0);

  // Top 项目（按 totalInput 排）
  const topProjects = Array.from(byProject.values())
    .sort((a, b) => b.totalInput - a.totalInput);

  // 按花费排 Top 会话
  const topSessions = entries.map(e => {
    const m = e.meta;
    const t = m.tokens || {};
    return {
      sessionId: m.sessionId,
      customName: sessionNames[m.sessionId] || '',
      aiTitle: m.aiTitle,
      titlePreview: m.titlePreview,
      projectPath: m.projectPath,
      endTime: m.endTime,
      totalInput: t.totalInput || 0,
      totalOutput: t.totalOutput || 0,
      estimatedCostUSD: m.estimatedCostUSD || 0,
    };
  }).sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD).slice(0, 20);

  // 按日序倒序
  const daily = Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));

  res.json({
    totals: {
      sessions: totalSessions,
      userMessages: totalUserMsgs,
      assistantMessages: totalAsstMsgs,
      input: totalInput,
      inputUncached: totalInputUncached,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheCreation: totalCacheCreation,
      cacheHitRate: totalInput ? totalCacheRead / totalInput : 0,
      estimatedCostUSD,
      costBreakdown,
    },
    topProjects,
    topSessions,
    daily,
    byModel: byModelArr,
  });
});

// ---------- Tag API ----------
app.get('/api/tags', (req, res) => {
  res.json({ library: tagLibrary, assignments: tagAssignments });
});

app.post('/api/tags', (req, res) => {
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
  const color = (req.body && typeof req.body.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(req.body.color))
    ? req.body.color : pickNextColor();
  if (!name) return res.status(400).json({ error: '名称必填' });
  if (name.length > 30) return res.status(400).json({ error: '名称过长（≤30 字符）' });
  if (tagLibrary.some(t => t.name === name)) return res.status(409).json({ error: '同名 tag 已存在' });
  const tag = { id: genTagId(), name, color };
  tagLibrary.push(tag);
  saveTags();
  res.json({ ok: true, tag, library: tagLibrary });
});

app.put('/api/tags/:id', (req, res) => {
  const t = tagLibrary.find(x => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'tag 不存在' });
  const body = req.body || {};
  if (typeof body.name === 'string') {
    const newName = body.name.trim();
    if (!newName) return res.status(400).json({ error: '名称不能为空' });
    if (newName.length > 30) return res.status(400).json({ error: '名称过长' });
    if (tagLibrary.some(x => x.id !== t.id && x.name === newName)) {
      return res.status(409).json({ error: '同名 tag 已存在' });
    }
    t.name = newName;
  }
  if (typeof body.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(body.color)) t.color = body.color;
  saveTags();
  res.json({ ok: true, tag: t, library: tagLibrary });
});

app.delete('/api/tags/:id', (req, res) => {
  const idx = tagLibrary.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'tag 不存在' });
  tagLibrary.splice(idx, 1);
  // 同步清掉所有 assignment
  for (const sid of Object.keys(tagAssignments)) {
    tagAssignments[sid] = tagAssignments[sid].filter(t => t !== req.params.id);
    if (!tagAssignments[sid].length) delete tagAssignments[sid];
  }
  saveTags();
  res.json({ ok: true, library: tagLibrary });
});

app.put('/api/sessions/:id/tags', (req, res) => {
  const sid = req.params.id;
  if (!sessionIndex.has(sid)) return res.status(404).json({ error: '会话不存在' });
  const tags = Array.isArray(req.body && req.body.tags) ? req.body.tags : [];
  const validIds = new Set(tagLibrary.map(t => t.id));
  const filtered = tags.filter(t => typeof t === 'string' && validIds.has(t));
  if (filtered.length) tagAssignments[sid] = Array.from(new Set(filtered));
  else delete tagAssignments[sid];
  saveTags();
  res.json({ ok: true, sessionId: sid, tags: tagAssignments[sid] || [] });
});

// ---------- Pinned / Favorite ----------
app.get('/api/preferences', (req, res) => {
  res.json({ pinned: [...pinnedSet], favorite: [...favoriteSet] });
});

app.put('/api/preferences/pinned', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  pinnedSet = new Set(ids.filter(x => typeof x === 'string'));
  try { savePinned(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, pinned: [...pinnedSet] });
});

app.put('/api/preferences/favorite', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  favoriteSet = new Set(ids.filter(x => typeof x === 'string'));
  try { saveFavorite(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true, favorite: [...favoriteSet] });
});

// ---------- 主题：用户保存并命名的配色，存在 config.json 的 themes 字段 ----------
app.get('/api/themes', (req, res) => {
  const saved = readConfigFile().themes || {};
  res.json({ themes: Array.isArray(saved.list) ? saved.list : [], activeId: saved.activeId || 'default' });
});

app.put('/api/themes', (req, res) => {
  const { themes, activeId } = req.body || {};
  if (!Array.isArray(themes) || themes.length > 50) return res.status(400).json({ error: '主题列表无效' });
  const isValid = t => t && typeof t.id === 'string' && /^[\w-]{1,40}$/.test(t.id)
    && typeof t.name === 'string' && t.name.trim() && t.name.length <= 30
    && t.colors && typeof t.colors === 'object' && Object.keys(t.colors).length <= 20
    && Object.values(t.colors).every(c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
  if (!themes.every(isValid)) return res.status(400).json({ error: '主题数据无效' });
  const list = themes.map(({ id, name, colors }) => ({ id, name: name.trim(), colors }));
  try {
    writeConfigFile({
      themes: { list, activeId: list.some(t => t.id === activeId) ? activeId : 'default' },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true });
});

app.put('/api/sessions/:id/name', (req, res) => {
  const id = req.params.id;
  if (!sessionIndex.has(id)) return res.status(404).json({ error: '会话不存在' });
  const name = (req.body && typeof req.body.name === 'string') ? req.body.name.trim() : '';
  if (name.length > 200) return res.status(400).json({ error: '名称过长（≤200 字符）' });
  if (name) sessionNames[id] = name;
  else delete sessionNames[id];
  try {
    saveNames();
  } catch (e) {
    return res.status(500).json({ error: '保存失败: ' + e.message });
  }
  res.json({ ok: true, sessionId: id, customName: name });
});

app.post('/api/config', async (req, res) => {
  const { claudeDir } = req.body || {};
  if (!claudeDir || typeof claudeDir !== 'string') {
    return res.status(400).json({ error: 'claudeDir 必填，须为字符串' });
  }
  if (!path.isAbsolute(claudeDir)) {
    return res.status(400).json({ error: 'claudeDir 必须是绝对路径' });
  }
  let stat;
  try {
    stat = fs.statSync(claudeDir);
  } catch (e) {
    return res.status(400).json({ error: '路径不存在: ' + claudeDir });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: '路径不是目录: ' + claudeDir });
  }
  const newProjectsDir = path.join(claudeDir, 'projects');
  const projectsExists = fs.existsSync(newProjectsDir);

  // 持久化到 bootstrap.json（只存 claudeDir 覆盖）
  try {
    writeBootstrap({ claudeDir });
  } catch (e) {
    return res.status(500).json({ error: '写入 bootstrap.json 失败: ' + e.message });
  }

  // 更新运行时配置：claudeDir 变了，APP_DIR 跟着换；重新加载所有数据
  CONFIG.claudeDir = claudeDir;
  PROJECTS_DIR = newProjectsDir;
  refreshAppPaths();
  loadNames();
  loadTags();
  loadPinned();
  loadFavorite();
  await buildIndex();
  startWatcher();
  res.json({
    ok: true,
    claudeDir,
    projectsDir: PROJECTS_DIR,
    projectsDirExists: projectsExists,
    total: sessionIndex.size,
  });
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
            : 'xdg-open';
  try {
    const args = process.platform === 'win32' ? ['', url] : [url];
    execFile(cmd, args, { shell: process.platform === 'win32' }, () => {});
  } catch {}
}

function killPortOccupant(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Windows：netstat 找 PID + taskkill
      execFile('cmd', ['/c',
        `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do taskkill /PID %a /F`
      ], () => resolve());
    } else {
      // macOS / Linux：只匹配监听者，否则连着该端口的浏览器也会被杀
      execFile('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs -r kill -9`], () => resolve());
    }
  });
}

function listenOnce(app, port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1'); // 仅本机可访问：接口无鉴权，且能读取和删除会话
    srv.once('listening', () => resolve(srv));
    srv.once('error', reject);
  });
}

// 探测端口上是否是 claude-web 自身的旧实例
async function isOwnInstance(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return !!(data && data.claudeDir && data.projectsDir);
  } catch {
    return false;
  }
}

async function listenWithRestart(app, port) {
  // 先探测再监听：旧版本监听所有网卡时，新实例绑 127.0.0.1 不一定报端口冲突，旧实例会继续对外暴露
  if (await isOwnInstance(port)) {
    console.log(`端口 ${port} 上已有 claude-web，正在重启...`);
    await killPortOccupant(port);
    // 给系统几百毫秒释放端口
    await new Promise(r => setTimeout(r, 800));
  }
  try {
    return { server: await listenOnce(app, port), port };
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    throw new Error(`端口 ${port} 被其他程序占用，请用 --port 换一个端口`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open') || process.env.CLAUDE_WEB_NO_OPEN === '1';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`claude-web — 本地查看 Claude Code 历史会话

用法:
  claude-web [选项]

选项:
  --no-open          启动后不自动打开浏览器
  --port <number>    指定端口（默认 ${DEFAULT_PORT}；已有 claude-web 实例时自动重启它，被其他程序占用则报错退出）
  -h, --help         显示帮助

环境变量:
  CLAUDE_DIR         覆盖 Claude 数据目录（默认 ~/.claude）
  CLAUDE_WEB_HOME    覆盖 bootstrap 配置目录（默认 ~/.claude-web）
  PORT               覆盖端口

数据存放:
  bootstrap (claudeDir 路径覆盖) → ~/.claude-web/bootstrap.json
  应用数据 (tags/names/pinned/fav) → <claudeDir>/claude-web/
`);
    process.exit(0);
  }
  const portIdx = args.indexOf('--port');
  if (portIdx >= 0 && args[portIdx + 1]) {
    const p = parseInt(args[portIdx + 1], 10);
    if (Number.isFinite(p)) CONFIG.port = p;
  }

  console.log('claudeDir   :', CONFIG.claudeDir);
  console.log('应用数据目录:', APP_DIR);
  console.log('扫描中      :', PROJECTS_DIR);
  migrateLegacyData();
  loadNames();
  loadTags();
  loadPinned();
  loadFavorite();
  console.log(`已加载 ${Object.keys(sessionNames).length} 个自定义名、${tagLibrary.length} 个 tag、${pinnedSet.size} 个置顶、${favoriteSet.size} 个收藏`);
  await buildIndex();
  startWatcher();
  try {
    const { port } = await listenWithRestart(app, CONFIG.port || DEFAULT_PORT);
    const url = `http://localhost:${port}`;
    console.log(`\n✓ 服务已启动: ${url}`);
    if (!fs.existsSync(PROJECTS_DIR)) {
      console.log(`⚠ 未发现 ${PROJECTS_DIR}，请打开页面右上角 ⚙ 配置正确的 Claude 目录。`);
    }
    if (!noOpen) {
      setTimeout(() => openBrowser(url), 600);
    }
  } catch (e) {
    console.error('启动失败:', e.message);
    process.exit(1);
  }
})();
