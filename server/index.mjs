// NewQA 本地 HTTP 服务：托管 dist 静态资源 + /api/*（NDJSON 流）。
// 只绑 127.0.0.1；不开放 CORS；校验 Host/Origin；不向浏览器暴露 stdio/环境。
import http from 'node:http';
import { readFile, realpath, stat, opendir, mkdir, writeFile } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn, probeOptions, AcpError, KINDS, MODEL_CONFIG_KEYS } from './acp.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(SERVER_DIR, '..');
const DEFAULT_DIST = path.join(PROJECT_ROOT, 'dist');
const DEFAULT_CWD = process.cwd(); // 服务启动目录 = 默认工作区
const PORT = Number(process.env.PORT || 4173);
const BODY_LIMIT = 1024 * 1024; // 1 MiB
const CHAT_BODY_LIMIT = 28 * 1024 * 1024; // /api/chat 允许贴图（≤4 张 base64）
const MAX_IMAGES = 4;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_DATA_LIMIT = 8 * 1024 * 1024; // 单张 base64 字符上限（≈6 MiB）
// 贴图附件落盘：localStorage 只存小缩略图，灯箱/查看走这里的原图。
const DEFAULT_ATTACH_DIR = path.join(os.homedir(), '.newqa', 'attachments');
const ATTACH_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const ATTACH_NAME = /^[\w-]+\.(?:png|jpg|webp|gif)$/;

const LIMITS = {
  history: 200,
  question: 16 * 1024,
  quote: 16 * 1024,
  entry: 160 * 1024,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Vite 会产出 _ 开头的 chunk（_commonjsHelpers 等），首字符须允许 _ 与 -
const SAFE_NAME = /^[\w-][\w.-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMITTED_KINDS = new Set(['allow_once', 'reject_once']);
// 会话权限模式白名单：只放这三种（ask=只读、plan 不开放选择）
const PERMISSION_MODES = new Set(['accept-edits', 'smart', 'bypass']);
const MODEL_CONFIG_KEY_SET = new Set(MODEL_CONFIG_KEYS);
const MODEL_CONFIG_VALUE_LIMIT = 128;
// 免费 SWE-2 家族（swe-2 / swe-2.1 / flash，含无档位的 family 别名）：
// 非 standard 速度档会被 Devin 解析成收费快速变体，默认 fail closed，
// 避免「看着免费实际扣额度」。
const FREE_MODEL = /^swe-2(?:-1)?(?:-flash)?(?:-(?:medium|high|max))?$/i;
const ALLOW_PAID_FAST = process.env.DEVIN_ALLOW_PAID_FAST === '1';
const OPTIONS_CACHE_TTL = 5 * 60 * 1000; // /api/devin/options 探测结果缓存
const GIT_CAP = 12 * 1024;
const GIT_TIMEOUT = 4000;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function hostOk(req) {
  const raw = String(req.headers.host || '');
  const name = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']'))
    : raw.split(':')[0];
  return ['127.0.0.1', 'localhost', '::1'].includes(name.toLowerCase());
}

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 非浏览器请求
  try {
    const url = new URL(origin);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === origin &&
      url.host.toLowerCase() === String(req.headers.host || '').toLowerCase()
    );
  } catch {
    return false;
  }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (statusCode, message) => {
      if (done) return;
      done = true;
      const e = new Error(message);
      e.statusCode = statusCode;
      reject(e);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(413, `请求体超过 ${Math.round(limit / 1048576)} MiB 上限`);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const e = new Error('请求 JSON 无法解析');
        e.statusCode = 400;
        reject(e);
      }
    });
    req.on('error', () => fail(400, '读取请求失败'));
  });
}

// ---- 校验 ----

export function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求格式不正确' };
  }
  const {
    history = [],
    question,
    quote = '',
    workspace = '',
    sessionId = null,
    convId = '',
    kind = 'discussion',
    permissionMode = 'accept-edits',
    modelConfig = null,
    images = [],
  } = body;
  if (!KINDS.has(kind)) return { error: 'kind 仅支持 work / discussion' };
  if (!PERMISSION_MODES.has(permissionMode)) {
    return { error: 'permissionMode 仅支持 accept-edits / smart / bypass' };
  }
  // 会话级模型配置：固定三键、字符串值、''=跟随默认；缺省/非对象字段回默认。
  const mc = { model: '', thought_level: '', speed: '' };
  if (modelConfig !== null && modelConfig !== undefined) {
    if (typeof modelConfig !== 'object' || Array.isArray(modelConfig)) {
      return { error: 'modelConfig 格式不正确' };
    }
    for (const [k, v] of Object.entries(modelConfig)) {
      if (!MODEL_CONFIG_KEY_SET.has(k)) {
        return { error: 'modelConfig 仅支持 model / thought_level / speed' };
      }
      if (typeof v !== 'string' || v.length > MODEL_CONFIG_VALUE_LIMIT) {
        return { error: `modelConfig.${k} 必须是 ≤${MODEL_CONFIG_VALUE_LIMIT} 字符的字符串` };
      }
      mc[k] = v;
    }
  }
  // 免费模型 + 非 Standard 速度档 = 收费快速变体：默认拒绝，避免静默计费。
  // model 为 ''（跟随全局默认）同样拦截——服务端无法确认默认解析值，宁可挡住。
  // 仅 work 生效：discussion（summarizer）模型固定，speed 不下发，不挡。
  // 确需付费加速可显式设置 DEVIN_ALLOW_PAID_FAST=1。
  if (
    kind === 'work' &&
    mc.speed !== '' &&
    mc.speed !== 'standard' &&
    (mc.model === '' || FREE_MODEL.test(mc.model)) &&
    !ALLOW_PAID_FAST
  ) {
    return {
      error:
        `速度 ${mc.speed} 会把 SWE-2 家族（含默认模型解析为 SWE-2 时）计费为快速变体、扣周额度；请把速度改为 Standard，或显式选择付费模型`,
    };
  }
  if (!Array.isArray(history) || history.length > LIMITS.history) {
    return { error: `对话历史格式不正确或超过 ${LIMITS.history} 条上限` };
  }
  for (const m of history) {
    if (!m || typeof m !== 'object' || (m.role !== 'user' && m.role !== 'assistant')) {
      return { error: '对话历史包含非法角色' };
    }
    if (typeof m.text !== 'string' || m.text.length > LIMITS.entry) {
      return { error: '对话历史条目格式不正确或过长' };
    }
  }
  if (typeof question !== 'string' || !question.trim()) {
    return { error: '问题不能为空' };
  }
  if (question.length > LIMITS.question) {
    return { error: '问题超过长度上限' };
  }
  if (typeof quote !== 'string' || quote.length > LIMITS.quote) {
    return { error: '引用格式不正确或过长' };
  }
  if (workspace !== '' && (typeof workspace !== 'string' || !path.isAbsolute(workspace))) {
    return { error: 'workspace 必须是绝对路径' };
  }
  if (sessionId !== null && (typeof sessionId !== 'string' || !SAFE_SESSION.test(sessionId))) {
    return { error: 'sessionId 格式不正确' };
  }
  if (typeof convId !== 'string' || !/^[\w-]{0,80}$/.test(convId)) {
    return { error: 'convId 格式不正确' };
  }
  // 贴图附件：≤4 张，mime 白名单，base64 有界
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    return { error: `images 最多 ${MAX_IMAGES} 张` };
  }
  for (const im of images) {
    if (!im || typeof im !== 'object' || typeof im.data !== 'string' || typeof im.mime !== 'string') {
      return { error: 'images 条目格式不正确' };
    }
    if (!IMAGE_MIMES.has(im.mime)) return { error: '图片仅支持 png / jpeg / webp / gif' };
    if (!im.data.length || im.data.length > IMAGE_DATA_LIMIT) {
      return { error: '单张图片超过大小上限' };
    }
  }
  return { history, question, quote, workspace, sessionId, convId, kind, permissionMode, modelConfig: mc, images };
}

// workspace：'' → 服务默认目录；否则解析为真实存在的目录（不回退、不改全局 cwd）。
async function resolveWorkspace(raw) {
  if (raw === '' || raw == null) {
    return { cwd: DEFAULT_CWD, canonical: DEFAULT_CWD, isDefault: true };
  }
  try {
    const canonical = await realpath(raw);
    const st = await stat(canonical);
    if (!st.isDirectory()) return { error: 'workspace 不是目录' };
    return { cwd: canonical, canonical, isDefault: false };
  } catch {
    return { error: 'workspace 路径不存在或不可访问' };
  }
}

// ---- git 只读快照（execFile，无 shell，超时/截断） ----

function git(args, cwd, cap = GIT_CAP) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT,
        maxBuffer: cap * 4,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
      },
      (err, stdout) => {
        if (err) return resolve(null);
        const s = String(stdout || '');
        resolve({ text: s.slice(0, cap), truncated: s.length > cap });
      },
    );
  });
}

export async function gitSnapshot(cwd) {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd, 256);
  if (!inside || inside.text.trim() !== 'true') {
    return { available: false, status: '', unstaged: '', staged: '', truncated: false, note: '不是 git 仓库' };
  }
  const [status, unstaged, staged] = await Promise.all([
    git(['status', '--short'], cwd, 16 * 1024),
    git(['diff', '--no-ext-diff', '--no-textconv', '--'], cwd),
    git(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--'], cwd),
  ]);
  const truncated = !!(status?.truncated || unstaged?.truncated || staged?.truncated);
  return {
    available: true,
    status: status?.text ?? '',
    unstaged: unstaged?.text ?? '',
    staged: staged?.text ?? '',
    truncated,
    note: '',
  };
}

async function isGitRepo(cwd) {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd, 256);
  return !!r && r.text.trim() === 'true';
}

// ---- devin CLI 探测（只查可执行文件，不代表登录态） ----
let cliCache;
function probeCli() {
  if (cliCache) return cliCache;
  try {
    const r = spawnSync('devin', ['--version'], { timeout: 8000, encoding: 'utf8' });
    cliCache =
      r.status === 0 && r.stdout?.trim()
        ? { cli: 'ok', version: r.stdout.trim().split('\n')[0].slice(0, 60) }
        : { cli: 'missing' };
  } catch {
    cliCache = { cli: 'missing' };
  }
  return cliCache;
}

async function serveStatic(req, res, pathname, distDir) {
  let file;
  if (pathname === '/' || pathname === '/index.html') {
    file = path.join(distDir, 'index.html');
  } else if (pathname.startsWith('/assets/')) {
    const name = pathname.slice('/assets/'.length);
    if (!SAFE_NAME.test(name)) return false;
    file = path.join(distDir, 'assets', name);
  } else {
    // dist 根级文件（icon.png / favicon.ico 等 public/ 产物）；
    // SAFE_NAME 不含 '/'，子目录与 ../ 穿越天然挡掉。
    const name = pathname.slice(1);
    if (!SAFE_NAME.test(name)) return false;
    file = path.join(distDir, name);
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
  return true;
}

export function createServer({
  distDir = DEFAULT_DIST,
  spawnImpl,
  defaultCwd = DEFAULT_CWD,
  attachDir = DEFAULT_ATTACH_DIR,
} = {}) {
  // 进行中的回合注册表：回合生命周期与单个 HTTP 连接解耦——浏览器刷新/
  // 断线只摘掉该连接的 listener，回合在服务端继续跑完；事件进回放缓冲
  // （连续 delta 合并），/api/chat/attach 可重放缓冲并追 live 流。
  // 不带 convId 的请求共用 '' 键，保持旧的全局串行语义。
  const activeTurns = new Map(); // convId → rec
  const TURN_REPLAY_TTL = 30 * 60 * 1000; // 完成后回放缓冲保留时长

  // 事件进缓冲并广播：连续 delta 合并成一条，控制回放体积。
  const broadcast = (rec, ev) => {
    const last = rec.events[rec.events.length - 1];
    if (ev.type === 'delta' && last?.type === 'delta') last.text += ev.text;
    else rec.events.push(ev);
    const line = JSON.stringify(ev) + '\n';
    for (const r of rec.listeners) {
      try {
        r.write(line);
      } catch {}
    }
  };
  // 把响应挂上回合：先同步重放缓冲（running 时再加 listener——同 tick 无竞态），
  // 已完结的回合重放完直接 end；连接断开只摘 listener，不影响回合本身。
  const attachRes = (rec, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    // 立即发头：agent 可能长时间无输出，客户端应先拿到 200 再等流
    res.flushHeaders();
    for (const ev of rec.events) {
      // 已解决（或回合已结束）的权限请求不重放——否则刷新后
      // 客户端会复活一个永远无法作答的权限弹窗
      if (ev.type === 'permission' && !pendingPerms.has(ev.requestId)) continue;
      try {
        res.write(JSON.stringify(ev) + '\n');
      } catch {}
    }
    if (rec.state !== 'running') {
      try {
        res.end();
      } catch {}
      return;
    }
    rec.listeners.add(res);
    res.on('close', () => rec.listeners.delete(res));
  };
  // /api/devin/options 探测结果缓存（仅成功才写入；失败不污染，下次重试）。
  // 按模型分键：不同模型的可选项（思考档位/速度）不同；inflight 分键去重。
  const optionsCaches = new Map(); // model('' = 基础) → { at, data }
  const optionsInflights = new Map(); // model → Promise
  // 各并发回合的权限决策：requestId → {resolve, options}。无自动批准；
  // 回合结束只清理自己发出的那批（requestId 为 UUID，跨回合不冲突）。
  const pendingPerms = new Map();

  async function handleChat(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req, CHAT_BODY_LIMIT);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const v = validateChatBody(body);
    if (v.error) return json(res, 400, { error: v.error });
    const ws = await resolveWorkspace(v.workspace);
    if (ws.error) return json(res, 400, { error: ws.error });
    if (activeTurns.get(v.convId)?.state === 'running') {
      return json(res, 409, { error: '该对话已有进行中的提问，请先停止或等待完成' });
    }
    const rec = {
      convId: v.convId,
      events: [],
      listeners: new Set(),
      state: 'running',
      controller: new AbortController(),
      myPerms: new Set(),
      stopped: false,
      startedAt: Date.now(),
    };
    activeTurns.set(v.convId, rec);
    attachRes(rec, res);
    // 本回合发出的权限请求 id：回合结束只清自己这批，并发回合互不清除。
    const onPermission =
      v.kind === 'work'
        ? (info) => {
            broadcast(rec, { type: 'permission', ...info });
            return new Promise((resolve) => {
              pendingPerms.set(info.requestId, { resolve, options: info.options });
              rec.myPerms.add(info.requestId);
            });
          }
        : null;
    try {
      const result = await runTurn({
        history: v.history,
        question: v.question,
        quote: v.quote,
        kind: v.kind,
        sessionId: v.kind === 'work' ? v.sessionId : null,
        permissionMode: v.kind === 'work' ? v.permissionMode : 'accept-edits',
        modelConfig: v.kind === 'work' ? v.modelConfig : null,
        images: v.images,
        cwd: ws.cwd,
        signal: rec.controller.signal,
        spawnImpl,
        onDelta: (text) => broadcast(rec, { type: 'delta', text }),
        onTool: v.kind === 'work' ? (tool) => broadcast(rec, { type: 'tool', tool }) : null,
        onPermission,
      });
      if (v.kind === 'work') {
        // 只读证据：work 回合成功后的 git 快照（有超时上限，不阻塞回合）。
        try {
          const snapshot = await gitSnapshot(ws.cwd);
          broadcast(rec, { type: 'git', snapshot });
        } catch {
          broadcast(rec, {
            type: 'git',
            snapshot: {
              available: false,
              status: '',
              unstaged: '',
              staged: '',
              truncated: false,
              note: '收集失败',
            },
          });
        }
      }
      // done 透传本轮实际生效模型（discussion/未知时缺省）
      broadcast(rec, {
        type: 'done',
        sessionId: result.sessionId,
        ...(result.model ? { model: result.model } : {}),
      });
    } catch (e) {
      if (rec.stopped) {
        // 用户经 /api/chat/stop 主动停止：语义与错误分开（客户端不存不完整回合）
        broadcast(rec, { type: 'stopped' });
      } else {
        broadcast(rec, {
          type: 'error',
          message: e instanceof AcpError ? e.message : '服务内部错误，请重试',
        });
      }
    } finally {
      for (const id of rec.myPerms) {
        pendingPerms.get(id)?.resolve(null);
        pendingPerms.delete(id);
      }
      rec.state = rec.stopped ? 'stopped' : rec.events.some((ev) => ev.type === 'done') ? 'done' : 'error';
      for (const r of rec.listeners) {
        try {
          r.end();
        } catch {}
      }
      rec.listeners.clear();
      // 回放缓冲保留一段时间供刷新后重放；新回合覆盖注册表时不误删
      const t = setTimeout(() => {
        if (activeTurns.get(v.convId) === rec) activeTurns.delete(v.convId);
      }, TURN_REPLAY_TTL);
      t.unref?.();
    }
  }

  // 重新挂流：刷新/断线后重放回合缓冲并追 live（已完结则重放完即 end）。
  async function handleChatAttach(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const convId = body?.convId;
    if (typeof convId !== 'string' || !convId || convId.length > 128) {
      return json(res, 400, { error: 'convId 缺失或格式不正确' });
    }
    const rec = activeTurns.get(convId);
    if (!rec) return json(res, 404, { error: '该对话没有进行中或可回放的回合' });
    attachRes(rec, res);
  }

  // 主动停止：abort 该回合的 acp 进程；回合收尾时广播 stopped 事件。
  async function handleChatStop(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const convId = body?.convId;
    if (typeof convId !== 'string' || !convId || convId.length > 128) {
      return json(res, 400, { error: 'convId 缺失或格式不正确' });
    }
    const rec = activeTurns.get(convId);
    if (!rec || rec.state !== 'running') {
      return json(res, 404, { error: '该对话没有进行中的回合' });
    }
    rec.stopped = true;
    rec.controller.abort();
    return json(res, 200, { ok: true });
  }

  async function handlePermissionDecision(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const { requestId, optionId } = body || {};
    if (typeof requestId !== 'string' || !requestId) {
      return json(res, 400, { error: 'requestId 缺失' });
    }
    const entry = pendingPerms.get(requestId);
    if (!entry) return json(res, 404, { error: '该权限请求已失效或不存在' });
    if (optionId !== null) {
      const match = (entry.options || []).find((o) => o.id === optionId);
      if (!match || !PERMITTED_KINDS.has(match.kind)) {
        return json(res, 400, { error: '无效权限选项' });
      }
    }
    pendingPerms.delete(requestId);
    entry.resolve(optionId);
    return json(res, 200, { ok: true });
  }

  async function handleInspect(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const raw = body?.path;
    if (typeof raw !== 'string' || !raw) {
      return json(res, 400, { error: 'path 必填' });
    }
    if (!path.isAbsolute(raw)) {
      return json(res, 400, { error: 'path 必须是绝对路径' });
    }
    const ws = await resolveWorkspace(raw);
    if (ws.error) return json(res, 400, { error: ws.error });
    return json(res, 200, { path: ws.canonical, git: await isGitRepo(ws.canonical) });
  }

  // 目录浏览：只返回子目录名与路径（跳过隐藏项/符号链接/文件），
  // 供前端文件夹选择器导航；不做任何写操作。
  const BROWSE_SCAN_CAP = 4096;
  const BROWSE_RESULT_CAP = 256;
  async function handleBrowse(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const raw = body?.path;
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      return json(res, 400, { error: 'path 必须是字符串' });
    }
    const target = typeof raw === 'string' ? raw : '';
    if (target && !path.isAbsolute(target)) {
      return json(res, 400, { error: 'path 必须是绝对路径' });
    }
    const ws = await resolveWorkspace(target);
    if (ws.error) return json(res, 400, { error: ws.error });
    const folders = [];
    let truncated = false;
    try {
      const dir = await opendir(ws.canonical);
      let inspected = 0;
      for await (const entry of dir) {
        if (++inspected > BROWSE_SCAN_CAP) {
          truncated = true;
          break;
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        folders.push({ name: entry.name, path: path.join(ws.canonical, entry.name) });
        if (folders.length >= BROWSE_RESULT_CAP) {
          truncated = true;
          break;
        }
      }
    } catch (e) {
      const denied = e && (e.code === 'EACCES' || e.code === 'EPERM');
      return json(res, denied ? 403 : 400, {
        error: denied ? '目录没有读取权限' : '目录不可访问',
      });
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(ws.canonical);
    return json(res, 200, {
      path: ws.canonical,
      parent: parent === ws.canonical ? null : parent,
      folders,
      truncated,
    });
  }

  // 贴图附件：POST /api/attachment {images:[{data,mime}]} → 落盘返回 URL；
  // GET /api/attachment/<uuid>.<ext> 供灯箱取原图。文件名服务端生成，无穿越面。
  async function handleAttachmentUpload(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: '仅支持 POST' });
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return json(res, 415, { error: '仅接受 JSON 请求体' });
    }
    let body;
    try {
      body = await readBody(req, CHAT_BODY_LIMIT);
    } catch (e) {
      return json(res, e.statusCode || 400, { error: e.message || '请求体无效' });
    }
    const list = Array.isArray(body?.images) ? body.images : null;
    if (!list || !list.length || list.length > MAX_IMAGES) {
      return json(res, 400, { error: `images 需为 1–${MAX_IMAGES} 项` });
    }
    for (const im of list) {
      if (
        !im ||
        typeof im !== 'object' ||
        typeof im.data !== 'string' ||
        !im.data.length ||
        im.data.length > IMAGE_DATA_LIMIT ||
        !IMAGE_MIMES.has(im.mime) ||
        !ATTACH_EXT[im.mime]
      ) {
        return json(res, 400, { error: '图片附件格式或大小不正确' });
      }
    }
    try {
      await mkdir(attachDir, { recursive: true });
    } catch {
      return json(res, 500, { error: '附件目录不可用' });
    }
    const attachments = [];
    for (const im of list) {
      const name = `${randomUUID()}.${ATTACH_EXT[im.mime]}`;
      try {
        await writeFile(
          path.join(attachDir, name),
          Buffer.from(im.data, 'base64'),
        );
      } catch {
        return json(res, 500, { error: '附件写入失败' });
      }
      attachments.push({ id: name, url: `/api/attachment/${name}` });
    }
    return json(res, 200, { attachments });
  }

  async function handleAttachmentGet(req, res, pathname) {
    if (req.method !== 'GET') return json(res, 405, { error: '仅支持 GET' });
    const name = pathname.slice('/api/attachment/'.length);
    if (!ATTACH_NAME.test(name)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    try {
      const data = await readFile(path.join(attachDir, name));
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      if (!hostOk(req) || !originOk(req)) {
        return json(res, 403, { error: '拒绝来自非本机的请求' });
      }
      if (pathname === '/api/chat') return await handleChat(req, res);
      if (pathname === '/api/chat/attach') return await handleChatAttach(req, res);
      if (pathname === '/api/chat/stop') return await handleChatStop(req, res);
      if (pathname === '/api/chat/permission') return await handlePermissionDecision(req, res);
      if (pathname === '/api/workspace/inspect') return await handleInspect(req, res);
      if (pathname === '/api/workspace/browse') return await handleBrowse(req, res);
      if (pathname === '/api/attachment' || pathname.startsWith('/api/attachment/')) {
        return pathname === '/api/attachment'
          ? await handleAttachmentUpload(req, res)
          : await handleAttachmentGet(req, res, pathname);
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
      if (pathname === '/api/status') {
        return json(res, 200, { ...probeCli(), defaultCwd: DEFAULT_CWD });
      }
      if (pathname === '/api/devin/options') {
        // 只读探测：斜杠命令清单 + 会话级配置项（model/thought_level/speed）。
        // ?model=<uid> → 探测该模型实际提供的选项（按模型分键缓存）。
        // 不发送 prompt；成功缓存 5 分钟，失败 502 且不写缓存。
        const modelQ = (url.searchParams.get('model') || '').slice(
          0,
          MODEL_CONFIG_VALUE_LIMIT,
        );
        try {
          const hit = optionsCaches.get(modelQ);
          if (hit && Date.now() - hit.at < OPTIONS_CACHE_TTL) {
            return json(res, 200, hit.data);
          }
          if (!optionsInflights.has(modelQ)) {
            const p = probeOptions({ spawnImpl, cwd: defaultCwd, model: modelQ }).finally(
              () => optionsInflights.delete(modelQ),
            );
            optionsInflights.set(modelQ, p);
          }
          const data = await optionsInflights.get(modelQ);
          optionsCaches.set(modelQ, { at: Date.now(), data });
          return json(res, 200, data);
        } catch (e) {
          return json(res, 502, {
            error: e instanceof AcpError ? e.message : '无法探测 Devin 命令与配置',
          });
        }
      }
      if (await serveStatic(req, res, pathname, distDir)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (e) {
      console.error('[newqa] handler error:', e);
      if (!res.headersSent) json(res, 500, { error: '服务内部错误' });
      else {
        try {
          res.end();
        } catch {}
      }
    }
  });
  // 服务关闭时中止所有活跃回合：不留孤儿 devin 子进程
  server.on('close', () => {
    for (const rec of activeTurns.values()) {
      if (rec.state === 'running') {
        rec.stopped = true;
        try {
          rec.controller.abort();
        } catch {}
      }
    }
  });
  return server;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`NewQA 已启动: http://127.0.0.1:${PORT}/ （默认工作区 ${DEFAULT_CWD}，Ctrl+C 停止）`);
  });
}
