'use strict';
/*
 * 飞书表格「图片链接 → 单元格图片」轻量转换服务（运营版 / Open API + OAuth）
 * 仅依赖 Node 内置模块（使用 Node 18+ 全局 fetch），直连飞书开放平台 API。
 *
 * 身份模型（运营版）：
 *   - 应用所有者（你）在飞书开放平台建一个「企业自建应用」并拿到 App ID / App Secret；
 *   - 你本人通过一次 OAuth 网页授权，把 user_access_token 交给本服务（自动刷新）；
 *   - 之后所有转换都以「你的身份」执行。好友只需把表共享给你的飞书账号即可。
 *
 * 接口：
 *   GET  /api/info            -> 网关/令牌状态
 *   GET  /api/oauth/start     -> 返回飞书授权页 URL（仅管理员密钥可唤起）
 *   GET  /api/oauth/callback  -> 飞书回调，换取并保存 user_access_token
 *   GET  /api/oauth/status    -> 令牌是否已就绪
 *   GET  /api/oauth/admin-check -> 当前口令是否为管理员密钥
 *   POST /api/resolve         -> 解析文档 -> {spreadsheetToken, sheets[]}
 *   POST /api/scan            -> 扫描某子表所有「图片链接」单元格
 *   POST /api/convert         -> 逐格下载图片并写入单元格（异步任务）
 *   GET  /api/job/:id         -> 任务进度
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT || 8787;

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const PUBLIC_BASE = process.env.PUBLIC_BASE || ('http://localhost:' + PORT);
const TOKEN_FILE = path.join(ROOT, 'tokens.json');

// ---------------------------------------------------------------------------
// 访问口令（部署到公网时必须启用）
// ---------------------------------------------------------------------------
let ACCESS_CODE = process.env.FLC_ACCESS_CODE || '';
if (!ACCESS_CODE) {
  ACCESS_CODE = Math.random().toString(36).slice(2, 10);
  try {
    fs.writeFileSync(path.join(ROOT, 'ACCESS_CODE.txt'),
      '访问口令（请发给需要使用本工具的伙伴）：' + ACCESS_CODE + '\n');
  } catch (e) { /* ignore */ }
  console.log('[boot] 未设置 FLC_ACCESS_CODE，已自动生成访问口令: ' + ACCESS_CODE + ' （已写入 ACCESS_CODE.txt）');
} else {
  console.log('[boot] 已启用访问口令（来自环境变量 FLC_ACCESS_CODE）');
}

// 管理员专属密钥（可选）：持有者可点亮「初始化授权」按钮并完成飞书 OAuth。
// 未设置时默认等于 ACCESS_CODE（即同一口令既可用又可管理，兼容旧部署）。
// 设置后：好友拿 FLC_ACCESS_CODE 只能使用工具、看不到/点不了初始化按钮；
//         你拿 FLC_ADMIN_CODE 既能使用、也能唤起初始化按钮。
const ADMIN_CODE = process.env.FLC_ADMIN_CODE || ACCESS_CODE;

// ---------------------------------------------------------------------------
// 令牌存储（运营者 user_access_token）
// 持久化策略：本地 tokens.json（L1 缓存） + 飞书云空间应用文件夹（L2，跨休眠/重启）
//   - 用 tenant_access_token（由 App ID/Secret 直接换取，无需用户令牌）读写云空间，
//     因此实例被 Render 休眠唤醒、本地磁盘清空后，仍能自动从云空间拉回 refresh_token
//     并静默刷新，好友无需你重新授权。
// ---------------------------------------------------------------------------
let tokenStore = null; // { access_token, refresh_token, expires_at }
let bootstrapping = false;
const DRIVE_FILE_NAME = 'flc-tokens.json';
let tenantTokenCache = { token: '', expire: 0 };

async function getTenantToken() {
  const now = Date.now();
  if (tenantTokenCache.token && now < tenantTokenCache.expire - 60 * 1000) return tenantTokenCache.token;
  const r = await feishuCall('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    body: { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
  });
  if (r.code !== 0 || !r.tenant_access_token) {
    throw new Error('获取 tenant_access_token 失败: ' + (r.msg || JSON.stringify(r).slice(0, 200)));
  }
  tenantTokenCache = { token: r.tenant_access_token, expire: now + (r.expire || 7200) * 1000 };
  return r.tenant_access_token;
}

async function getAppFolderToken() {
  const tt = await getTenantToken();
  const meta = await feishuCall('GET', '/open-apis/drive/explorer/v2/root_folder/meta', { token: tt });
  if (meta.code !== 0 || !meta.data || !meta.data.token) {
    throw new Error('获取应用云空间根目录失败: ' + (meta.msg || JSON.stringify(meta).slice(0, 200)));
  }
  return meta.data.token;
}

async function findDriveTokenFile(tt, folderToken) {
  const list = await feishuCall('GET', '/open-apis/drive/explorer/v2/folder/' + folderToken + '/children', {
    params: { types: 'file' }, token: tt,
  });
  if (list.code !== 0 || !list.data || !list.data.children) return null;
  const children = Object.values(list.data.children);
  const f = children.find((c) => c.name === DRIVE_FILE_NAME && c.type === 'file');
  return f ? { token: f.token, name: f.name, type: f.type } : null;
}

async function readDriveToken() {
  const tt = await getTenantToken();
  const folderToken = await getAppFolderToken();
  const f = await findDriveTokenFile(tt, folderToken);
  if (!f) return null;
  // v1 download 接口直接返回文件内容（响应体即 JSON 文本，非带 url 的包装）
  const resp = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/' + f.token + '/download', {
    headers: { Authorization: 'Bearer ' + tt },
  });
  if (!resp.ok) throw new Error('下载云空间文件失败 HTTP ' + resp.status);
  return JSON.parse(await resp.text());
}

async function getAppBotOpenId(tt) {
  try {
    const bi = await feishuCall('GET', '/open-apis/bot/v3/info', { token: tt });
    if (bi.code === 0 && bi.bot && bi.bot.open_id) return bi.bot.open_id;
  } catch (e) { /* ignore */ }
  return null;
}

async function writeDriveToken(t) {
  const tt = await getTenantToken();
  const folderToken = await getAppFolderToken();
  const old = await findDriveTokenFile(tt, folderToken);
  if (old) {
    await feishuCall('DELETE', '/open-apis/drive/v1/files/' + old.token, { params: { type: 'file' }, token: tt });
  }
  const uploaderId = await getAppBotOpenId(tt);
  const content = JSON.stringify(t, null, 2);
  const buf = Buffer.from(content, 'utf8');
  const boundary = '----flcBoundary' + Date.now();
  const parts = [];
  const field = (name, val) => {
    parts.push(Buffer.from('--' + boundary + '\r\n'));
    parts.push(Buffer.from('Content-Disposition: form-data; name="' + name + '"\r\n\r\n'));
    parts.push(Buffer.from(String(val) + '\r\n'));
  };
  field('file_name', DRIVE_FILE_NAME);
  field('parent_type', 'explorer');
  field('parent_node', folderToken);
  field('size', String(buf.length));
  if (uploaderId) field('uploader_id', uploaderId);
  parts.push(Buffer.from('--' + boundary + '\r\n'));
  parts.push(Buffer.from('Content-Disposition: form-data; name="file"; filename="' + DRIVE_FILE_NAME + '"\r\n'));
  parts.push(Buffer.from('Content-Type: application/json\r\n\r\n'));
  parts.push(buf);
  parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('--' + boundary + '--\r\n'));
  const resp = await fetch('https://open.feishu.cn/open-apis/drive/v1/files/upload_all', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tt,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: Buffer.concat(parts),
  });
  const r = await resp.json();
  if (r.code !== 0) throw new Error('写入云空间失败: ' + (r.msg || JSON.stringify(r).slice(0, 200)));
}

// 静默刷新（用 refresh_token 换新令牌并持久化）
async function refreshTokenNow() {
  if (!tokenStore || !tokenStore.refresh_token) return false;
  try {
    const r = await feishuCall('POST', '/open-apis/authen/v2/oauth/token', {
      body: {
        grant_type: 'refresh_token',
        client_id: FEISHU_APP_ID,
        client_secret: FEISHU_APP_SECRET,
        refresh_token: tokenStore.refresh_token,
      },
    });
    if (r.code === 0 && r.access_token) {
      tokenStore = {
        access_token: r.access_token,
        refresh_token: r.refresh_token || tokenStore.refresh_token,
        expires_at: Date.now() + (r.expires_in || 7200) * 1000,
      };
      await persistToken(tokenStore);
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// 持久化：本地 + 云空间（云空间失败不影响本次使用）
async function persistToken(t) {
  tokenStore = t;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); } catch (e) { /* ignore */ }
  if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
    try { await writeDriveToken(t); }
    catch (e) { console.log('[token] 写入云空间失败（本地已保存，不影响本次使用）: ' + e.message); }
  }
}

// 启动恢复：本地 -> 云空间（tenant token 读取，无需用户令牌）-> 环境变量兜底
async function bootstrapToken() {
  if (tokenStore) return tokenStore;
  if (bootstrapping) return null;
  bootstrapping = true;
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      try { tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); return tokenStore; } catch (e) { /* ignore */ }
    }
    if (FEISHU_APP_ID && FEISHU_APP_SECRET) {
      try {
        const t = await readDriveToken();
        if (t && t.access_token) {
          tokenStore = t;
          if (Date.now() >= (tokenStore.expires_at || 0) - 5 * 60 * 1000 && tokenStore.refresh_token) {
            await refreshTokenNow();
          }
          return tokenStore;
        }
      } catch (e) {
        console.log('[token] 从云空间恢复失败（可忽略，等待管理员重新授权）: ' + e.message);
      }
    }
    if (process.env.FLC_OP_ACCESS_TOKEN) {
      tokenStore = {
        access_token: process.env.FLC_OP_ACCESS_TOKEN,
        refresh_token: process.env.FLC_OP_REFRESH_TOKEN || '',
        expires_at: Date.now() + 3600 * 1000,
      };
    }
  } finally {
    bootstrapping = false;
  }
  return tokenStore;
}

async function saveToken(t) { await persistToken(t); }

let oauthState = ''; // 防止 CSRF

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif', 'jfif', 'tiff'];
const IMG_HOST_HINT = ['sojump', 'myqcloud.com', 'qpic.cn', 'aliyuncs.com', 'oss-cn', 'pstatp', 'byteimg', 'volcstatic'];

function isImageUrl(u) {
  if (!u || typeof u !== 'string') return false;
  const s = u.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const parsed = new URL(s);
    const p = parsed.pathname.split('?')[0];
    const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    if (IMG_EXT.includes(ext)) return true;
    const host = parsed.hostname.toLowerCase();
    if (IMG_HOST_HINT.some((h) => host.includes(h))) return true;
  } catch (e) {
    return false;
  }
  return false;
}

function guessExt(urlStr) {
  try {
    const u = new URL(urlStr);
    const p = u.pathname.split('?')[0];
    const e = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
    if (IMG_EXT.includes(e)) return '.' + e;
  } catch (e) { /* ignore */ }
  return '.jpg';
}

// ---------------------------------------------------------------------------
// 飞书开放 API 调用
// ---------------------------------------------------------------------------
async function feishuCall(method, apiPath, { params = null, body = null, token = null } = {}) {
  let url = 'https://open.feishu.cn' + apiPath;
  if (params) {
    const q = new URLSearchParams(params).toString();
    url += (url.includes('?') ? '&' : '?') + q;
  }
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text }; }
  return json;
}

async function getValidToken() {
  await bootstrapToken();
  if (!tokenStore || !tokenStore.access_token) {
    const err = new Error('运营者令牌未初始化：请先用访问口令访问 /api/oauth/start 完成飞书授权。');
    err.code = 'NO_TOKEN';
    throw err;
  }
  // 提前 5 分钟刷新（内部已自动持久化到本地 + 云空间）
  if (Date.now() >= (tokenStore.expires_at || 0) - 5 * 60 * 1000) {
    if (tokenStore.refresh_token) {
      await refreshTokenNow();
    }
  }
  return tokenStore.access_token;
}

// ---------------------------------------------------------------------------
// 文档解析
// ---------------------------------------------------------------------------
function parseDocUrl(url) {
  // 直接电子表格链接：https://<domain>/sheets/<token>
  let m = url.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (m) return { type: 'sheet', token: m[1] };
  // wiki 链接：https://<domain>/wiki/<token>
  m = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (m) return { type: 'wiki', token: m[1] };
  return null;
}

async function resolveDoc(url) {
  const parsed = parseDocUrl(url);
  if (!parsed) throw new Error('无法识别的飞书链接（应为 /sheets/ 或 /wiki/ 链接）');
  let spreadsheetToken = parsed.token;
  if (parsed.type === 'wiki') {
    const token = await getValidToken();
    const r = await feishuCall('GET', '/open-apis/wiki/v2/spaces/get_node', {
      params: { token: parsed.token, obj_type: 'wiki' },
      token,
    });
    if (r.code !== 0) throw new Error('wiki 解析失败：' + (r.msg || JSON.stringify(r).slice(0, 200)));
    const node = (r.data && r.data.node) || {};
    if (node.obj_type && node.obj_type !== 'sheet') {
      throw new Error('该 wiki 节点类型是「' + node.obj_type + '」，不是电子表格，暂不支持。');
    }
    spreadsheetToken = node.obj_token || node.spreadsheet_token || node.node_token;
    if (!spreadsheetToken) throw new Error('无法从 wiki 节点获取电子表格 token：' + JSON.stringify(r.data).slice(0, 200));
  }
  // 列出工作表
  const token = await getValidToken();
  const q = await feishuCall('GET', '/open-apis/sheets/v3/spreadsheets/' + spreadsheetToken + '/sheets/query', { token });
  if (q.code !== 0) throw new Error('获取工作表失败：' + (q.msg || JSON.stringify(q).slice(0, 200)));
  const sheets = (q.data && q.data.sheets || []).map((s) => ({
    sheet_id: s.sheet_id,
    sheet_name: s.title || s.sheet_name || s.sheet_id,
    row_count: (s.grid_properties && s.grid_properties.row_count) || 200,
    column_count: (s.grid_properties && s.grid_properties.column_count) || 25,
  }));
  return { title: '', spreadsheetToken, sheets };
}

// ---------------------------------------------------------------------------
// 扫描：自动找出表里所有「图片链接」单元格（基于字符串识别，不依赖固定列）
// ---------------------------------------------------------------------------
async function readSheetGrid(token, spreadsheetToken, sheetId, rowCount, columnCount) {
  // 每次最多读 100 列，按列分块
  const CHUNK = 100;
  const grid = new Map(); // "row,col" -> string
  for (let cStart = 1; cStart <= columnCount; cStart += CHUNK) {
    const cEnd = Math.min(cStart + CHUNK - 1, columnCount);
    const range = `${sheetId}!${colLetter(cStart)}1:${colLetter(cEnd)}${rowCount}`;
    const r = await feishuCall('GET',
      '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + range,
      { params: { valueRenderOption: 'ToString' }, token });
    if (r.code !== 0) throw new Error('读取单元格失败：' + (r.msg || JSON.stringify(r).slice(0, 200)));
    const values = (r.data && r.data.valueRange && r.data.valueRange.values) || [];
    for (let i = 0; i < values.length; i++) {
      const rowArr = values[i];
      const absRow = 1 + i; // 从 1 开始
      for (let j = 0; j < rowArr.length; j++) {
        const v = rowArr[j];
        if (v === '' || v == null) continue;
        const absCol = cStart + j;
        grid.set(absRow + ',' + absCol, String(v));
      }
    }
  }
  return grid;
}

async function scanSheet(spreadsheetToken, sheetId, sheetName, rowCount, columnCount) {
  const token = await getValidToken();
  const grid = await readSheetGrid(token, spreadsheetToken, sheetId, rowCount, columnCount);
  const cells = [];
  for (const [key, value] of grid.entries()) {
    if (!isImageUrl(value)) continue;
    const [rowStr, colStr] = key.split(',');
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);
    const addr = colLetter(col) + row;
    cells.push({ sheetId, sheetName, range: addr, row, col, url: value, source: 'text' });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 转换：逐格下载图片并写入单元格（异步任务）
// ---------------------------------------------------------------------------
const jobs = new Map();
let seq = 1;

function startJob(spreadsheetToken, sheetId, sheetName, cells) {
  const id = String(seq++);
  const job = { id, status: 'running', total: cells.length, done: 0, results: [], startedAt: Date.now() };
  jobs.set(id, job);
  (async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-'));
    try {
      const token = await getValidToken();
      for (const c of cells) {
        const r = { range: c.range, url: c.url, source: c.source, status: 'pending' };
        try {
          const ext = guessExt(c.url);
          const imgResp = await fetch(c.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!imgResp.ok) throw new Error('图片下载失败 HTTP ' + imgResp.status);
          const buf = Buffer.from(await imgResp.arrayBuffer());
          if (buf.length < 50) throw new Error('下载内容过小，可能不是图片');
          const base64 = buf.toString('base64');
          const range = `${sheetId}!${c.range}:${c.range}`;
          const wr = await feishuCall('POST',
            '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values_image',
            { body: { range, image: base64, name: 'flc' + ext }, token });
          if (wr.code === 0) {
            r.status = 'done';
          } else {
            r.status = 'failed';
            r.error = '写入图片失败：' + (wr.msg || JSON.stringify(wr).slice(0, 200));
          }
        } catch (e) {
          r.status = 'failed';
          r.error = String(e.message || e).slice(0, 300);
        }
        job.done++;
        job.results.push(r);
      }
      job.status = 'finished';
    } catch (e) {
      job.status = 'error';
      job.error = String(e.message || e);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  })();
  return job;
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function serveFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function getAccessCode(req, body) {
  const h = req.headers['x-access-code'];
  if (h) return h;
  if (body && typeof body.accessCode === 'string') return body.accessCode;
  return null;
}
function gateOK(req, res, body) {
  if (!ACCESS_CODE) return true;
  const c = getAccessCode(req, body);
  if (c === ACCESS_CODE || c === ADMIN_CODE) return true;
  sendJSON(res, 401, { ok: false, error: '访问口令错误，请向文档所有者索取后再试。' });
  return false;
}

// 仅管理员密钥可过（用于初始化授权等危险操作）
function adminGateOK(req, res, body) {
  if (!ADMIN_CODE) return true;
  if (getAccessCode(req, body) === ADMIN_CODE) return true;
  sendJSON(res, 403, { ok: false, error: '仅管理员可操作：请使用管理员密钥（FLC_ADMIN_CODE）。' });
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const urlp = req.url.split('?')[0];
    const q = new URL(req.url, 'http://localhost').searchParams;

    if (req.method === 'GET' && (urlp === '/' || urlp === '/index.html')) {
      return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && urlp === '/api/info') {
      await bootstrapToken();
      return sendJSON(res, 200, {
        ok: true,
        gateEnabled: !!ACCESS_CODE,
        appConfigured: !!(FEISHU_APP_ID && FEISHU_APP_SECRET),
        tokenReady: !!(tokenStore && tokenStore.access_token),
        version: '2.0',
      });
    }

    // OAuth：开始授权（仅管理员密钥可唤起）
    if (req.method === 'GET' && urlp === '/api/oauth/start') {
      if (!adminGateOK(req, res, null)) return;
      if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
        return sendJSON(res, 200, { ok: false, error: '未配置飞书应用凭证（FEISHU_APP_ID / FEISHU_APP_SECRET）。' });
      }
      oauthState = crypto.randomBytes(12).toString('hex');
      const redirectUri = PUBLIC_BASE.replace(/\/$/, '') + '/api/oauth/callback';
      const scope = 'sheets:spreadsheet wiki:wiki offline_access';
      const authUrl = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?' +
        new URLSearchParams({
          client_id: FEISHU_APP_ID,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope,
          state: oauthState,
          prompt: 'consent',
        }).toString();
      return sendJSON(res, 200, { ok: true, authUrl });
    }

    // OAuth：飞书回调
    if (req.method === 'GET' && urlp === '/api/oauth/callback') {
      const code = q.get('code');
      const state = q.get('state');
      const error = q.get('error');
      if (error) {
        return serveFile(res, path.join(PUBLIC, 'oauth-result.html'), 'text/html; charset=utf-8');
      }
      if (!code) {
        return sendJSON(res, 400, { ok: false, error: '缺少授权码' });
      }
      if (oauthState && state && state !== oauthState) {
        return sendJSON(res, 400, { ok: false, error: 'state 校验失败（可能为 CSRF）' });
      }
      if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
        return sendJSON(res, 500, { ok: false, error: '未配置飞书应用凭证' });
      }
      const redirectUri = PUBLIC_BASE.replace(/\/$/, '') + '/api/oauth/callback';
      const r = await feishuCall('POST', '/open-apis/authen/v2/oauth/token', {
        body: {
          grant_type: 'authorization_code',
          client_id: FEISHU_APP_ID,
          client_secret: FEISHU_APP_SECRET,
          code,
          redirect_uri: redirectUri,
        },
      });
      if (r.code !== 0 || !r.access_token) {
        return sendJSON(res, 200, { ok: false, error: '换取令牌失败：' + (r.msg || JSON.stringify(r).slice(0, 200)) });
      }
      await saveToken({
        access_token: r.access_token,
        refresh_token: r.refresh_token || '',
        expires_at: Date.now() + (r.expires_in || 7200) * 1000,
      });
      return serveFile(res, path.join(PUBLIC, 'oauth-result.html'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && urlp === '/api/oauth/status') {
      if (!gateOK(req, res, null)) return;
      await bootstrapToken();
      return sendJSON(res, 200, {
        ok: true,
        tokenReady: !!(tokenStore && tokenStore.access_token),
        expiresAt: tokenStore ? tokenStore.expires_at : null,
      });
    }

    // 管理员身份校验（用于前端决定是否点亮初始化按钮）
    if (req.method === 'GET' && urlp === '/api/oauth/admin-check') {
      if (!gateOK(req, res, null)) return;
      const c = getAccessCode(req, null);
      return sendJSON(res, 200, {
        ok: true,
        isAdmin: !!(ADMIN_CODE && c === ADMIN_CODE),
      });
    }

    if (req.method === 'POST' && urlp === '/api/resolve') {
      const body = await readBody(req);
      if (!gateOK(req, res, body)) return;
      const url = (body.url || '').trim();
      if (!url) return sendJSON(res, 400, { ok: false, error: '缺少文档链接' });
      try {
        const result = await resolveDoc(url);
        return sendJSON(res, 200, { ok: true, title: result.title, spreadsheetToken: result.spreadsheetToken, sheets: result.sheets });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: '解析失败：' + String(e.message || e).slice(0, 400) });
      }
    }

    if (req.method === 'POST' && urlp === '/api/scan') {
      const body = await readBody(req);
      if (!gateOK(req, res, body)) return;
      const spreadsheetToken = body.spreadsheetToken;
      const sheetId = body.sheetId;
      const sheetName = body.sheetName || sheetId;
      const rowCount = parseInt(body.rowCount, 10) || 1000;
      const columnCount = parseInt(body.columnCount, 10) || 100;
      if (!spreadsheetToken || !sheetId) return sendJSON(res, 400, { ok: false, error: '缺少 spreadsheetToken 或 sheetId' });
      try {
        const cells = await scanSheet(spreadsheetToken, sheetId, sheetName, rowCount, columnCount);
        return sendJSON(res, 200, { ok: true, total: cells.length, cells });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: '扫描失败：' + String(e.message || e).slice(0, 400) });
      }
    }

    if (req.method === 'POST' && urlp === '/api/convert') {
      const body = await readBody(req);
      if (!gateOK(req, res, body)) return;
      const spreadsheetToken = body.spreadsheetToken;
      const sheetId = body.sheetId;
      const sheetName = body.sheetName || sheetId;
      const cells = Array.isArray(body.cells) ? body.cells : [];
      if (!spreadsheetToken || !sheetId || cells.length === 0) {
        return sendJSON(res, 400, { ok: false, error: '缺少参数或待转换列表为空' });
      }
      const job = startJob(spreadsheetToken, sheetId, sheetName, cells);
      return sendJSON(res, 200, { ok: true, jobId: job.id, total: job.total });
    }

    if (req.method === 'GET' && urlp.startsWith('/api/job/')) {
      if (!gateOK(req, res, null)) return;
      const id = urlp.slice('/api/job/'.length);
      const job = jobs.get(id);
      if (!job) return sendJSON(res, 404, { ok: false, error: '任务不存在' });
      return sendJSON(res, 200, {
        ok: true, id: job.id, status: job.status, total: job.total, done: job.done,
        results: job.results, error: job.error || null,
      });
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log('[server] 飞书图片链接转换服务（运营版）已启动: http://localhost:' + PORT);
  console.log('[server] 飞书应用凭证: ' + (FEISHU_APP_ID ? '已配置' : '未配置（OAuth 初始化前需配置）'));
  // 启动恢复令牌（本地/云空间），失败仅记录，等待管理员重新授权
  bootstrapToken()
    .then((t) => console.log('[boot] 令牌恢复: ' + (t && t.access_token ? '成功（含云空间持久化）' : '无（等待管理员初始化授权）')))
    .catch((e) => console.log('[boot] 令牌恢复失败（可忽略）: ' + e.message));
});
