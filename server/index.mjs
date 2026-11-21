// NewQA 本地 HTTP 服务：托管 dist 静态资源 + /api/*（NDJSON 流）。
// 只绑 127.0.0.1；不开放 CORS；校验 Host/Origin；不向浏览器暴露 stdio/环境。
import http from 'node:http';
import { readFile, realpath, stat, opendir } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
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
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PERMITTED_KINDS = new Set(['allow_once', 'reject_once']);
// 会话权限模式白名单：只放这三种（ask=只读、plan 不开放选择）
const PERMISSION_MODES = new Set(['accept-edits', 'smart', 'bypass']);
const MODEL_CONFIG_KEY_SET = new Set(MODEL_CONFIG_KEYS);
const MODEL_CONFIG_VALUE_LIMIT = 128;
// 免费 SWE-2 家族（含 family 别名）：速度 fast 会被 Devin 解析成收费的
// Lightning 变体，因此默认 fail closed，避免「看着免费实际扣额度」。
const FREE_MODEL = /^swe-2(?:-flash)?(?:-(?:medium|high|max))?$/i;
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
  // 免费模型 + Fast = 收费 Lightning 变体：默认拒绝，避免静默计费。
  // model 为 ''（跟随全局默认）同样拦截——服务端无法确认默认解析值，宁可挡住。
  // 仅 work 生效：discussion（summarizer）模型固定，speed 不下发，不挡。
  // 确需付费加速可显式设置 DEVIN_ALLOW_PAID_FAST=1。
  if (
    kind === 'work' &&
    mc.speed === 'fast' &&
    (mc.model === '' || FREE_MODEL.test(mc.model)) &&
    !ALLOW_PAID_FAST
  ) {
    return {
      error:
        '速度 Fast 会把 SWE-2（含默认模型解析为 SWE-2 时）计费为 Lightning 变体、扣周额度；请把速度改为 Standard，或显式选择付费模型',
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
  return { history, question, quote, workspace, sessionId, kind, permissionMode, modelConfig: mc, images };
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
    return false;
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

export function createServer({ distDir = DEFAULT_DIST, spawnImpl, defaultCwd = DEFAULT_CWD } = {}) {
  let busy = false;
  // /api/devin/options 探测结果缓存（仅成功才写入；失败不污染，下次重试）。
  // inflight 去重并发请求，避免同一时刻 spawn 多个 devin acp。
  let optionsCache = null; // { at, data }
  let optionsInflight = null;
  // 当前回合的权限决策：requestId → {resolve, options}。单回合串行，无自动批准。
  const pendingPerms = new Map();

  function clearPerms() {
    for (const [, p] of pendingPerms) p.resolve(null);
    pendingPerms.clear();
  }

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
    if (busy) {
      return json(res, 409, { error: '已有进行中的提问，请先停止或等待完成' });
    }
    busy = true;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', onClose);
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const send = (ev) => {
      try {
        res.write(JSON.stringify(ev) + '\n');
      } catch {}
    };
    const onPermission =
      v.kind === 'work'
        ? (info) => {
            send({ type: 'permission', ...info });
            return new Promise((resolve) => {
              pendingPerms.set(info.requestId, { resolve, options: info.options });
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
        signal: controller.signal,
        spawnImpl,
        onDelta: (text) => send({ type: 'delta', text }),
        onTool: v.kind === 'work' ? (tool) => send({ type: 'tool', tool }) : null,
        onPermission,
      });
      if (v.kind === 'work') {
        // 只读证据：work 回合成功后的 git 快照（有超时上限，不阻塞回合）。
        try {
          const snapshot = await gitSnapshot(ws.cwd);
          send({ type: 'git', snapshot });
        } catch {
          send({
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
      send({
        type: 'done',
        sessionId: result.sessionId,
        ...(result.model ? { model: result.model } : {}),
      });
    } catch (e) {
      if (e.name !== 'AbortError' && !controller.signal.aborted && !res.writableEnded) {
        send({
          type: 'error',
          message: e instanceof AcpError ? e.message : '服务内部错误，请重试',
        });
      }
    } finally {
      clearPerms();
      res.off('close', onClose);
      try {
        res.end();
      } catch {}
      busy = false;
    }
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

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      if (!hostOk(req) || !originOk(req)) {
        return json(res, 403, { error: '拒绝来自非本机的请求' });
      }
      if (pathname === '/api/chat') return await handleChat(req, res);
      if (pathname === '/api/chat/permission') return await handlePermissionDecision(req, res);
      if (pathname === '/api/workspace/inspect') return await handleInspect(req, res);
      if (pathname === '/api/workspace/browse') return await handleBrowse(req, res);
      if (req.method !== 'GET') return json(res, 405, { error: 'Method Not Allowed' });
      if (pathname === '/api/status') {
        return json(res, 200, { ...probeCli(), defaultCwd: DEFAULT_CWD });
      }
      if (pathname === '/api/devin/options') {
        // 只读探测：斜杠命令清单 + 会话级配置项（model/thought_level/speed）。
        // 不发送 prompt；成功缓存 5 分钟，失败 502 且不写缓存。
        try {
          if (optionsCache && Date.now() - optionsCache.at < OPTIONS_CACHE_TTL) {
            return json(res, 200, optionsCache.data);
          }
          if (!optionsInflight) {
            optionsInflight = probeOptions({ spawnImpl, cwd: defaultCwd }).finally(
              () => (optionsInflight = null),
            );
          }
          const data = await optionsInflight;
          optionsCache = { at: Date.now(), data };
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
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`NewQA 已启动: http://127.0.0.1:${PORT}/ （默认工作区 ${DEFAULT_CWD}，Ctrl+C 停止）`);
  });
}
