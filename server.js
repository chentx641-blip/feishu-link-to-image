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
 *   POST /api/convert         -> 逐格下载图片并写入单元格；一格多图自动拼成一张网格图写回原单元格（不新增列）
 *   GET  /api/job/:id         -> 任务进度
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// sharp 仅用于「一格多图」拼合，且仅在转换阶段按需加载。
// 改为懒加载：避免 sharp 原生模块在部署环境（如 Render 预编译缺失）加载失败时，
// 导致整个 server.js 启动即崩、Render 保留旧的（带 25 列上限/逐格 recover）构建，
// 表现为「扫描极慢 + 整表找不到链接」。扫描与鉴权完全不依赖 sharp，必须优先保证可启动。
let _sharp = null;
let _sharpErr = null;
function getSharp() {
  if (_sharp) return _sharp;
  if (_sharpErr) throw _sharpErr;
  try { _sharp = require('sharp'); } catch (e) { _sharpErr = e; throw e; }
  return _sharp;
}

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
async function getSheetGridSize(spreadsheetToken, sheetId) {
  // 实时查询子表真实行列数，彻底消除任何硬编码上限（文档有多少行列就扫多少）
  const token = await getValidToken();
  const q = await feishuCall('GET', '/open-apis/sheets/v3/spreadsheets/' + spreadsheetToken + '/sheets/query', { token });
  if (q.code !== 0) throw new Error('获取工作表信息失败：' + (q.msg || JSON.stringify(q).slice(0, 200)));
  const sheets = (q.data && q.data.sheets) || [];
  const s = sheets.find((x) => x.sheet_id === sheetId);
  if (!s) throw new Error('未找到子表（sheetId=' + sheetId + '）');
  const gp = s.grid_properties || {};
  return { row_count: gp.row_count || 0, column_count: gp.column_count || 0 };
}

async function readSheetGrid(token, spreadsheetToken, sheetId, rowCount, columnCount) {
  // 双重分块：飞书 values 接口单次返回上限 10MB，且「sheetId!范围」形式最多 100 列
  const COL_CHUNK = 100;  // 每块最多 100 列
  const ROW_CHUNK = 1000; // 每块最多 1000 行（保守，避免单次超 10MB）
  const grid = new Map(); // "row,col" -> string
  for (let rStart = 1; rStart <= rowCount; rStart += ROW_CHUNK) {
    const rEnd = Math.min(rStart + ROW_CHUNK - 1, rowCount);
    for (let cStart = 1; cStart <= columnCount; cStart += COL_CHUNK) {
      const cEnd = Math.min(cStart + COL_CHUNK - 1, columnCount);
      const range = `${sheetId}!${colLetter(cStart)}${rStart}:${colLetter(cEnd)}${rEnd}`;
      const r = await feishuCall('GET',
        '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + range,
        { params: { valueRenderOption: 'ToString' }, token });
      if (r.code !== 0) throw new Error('读取单元格失败：' + (r.msg || JSON.stringify(r).slice(0, 200)));
      const values = (r.data && r.data.valueRange && r.data.valueRange.values) || [];
      for (let i = 0; i < values.length; i++) {
        const rowArr = values[i];
        const absRow = rStart + i; // 绝对行号（含分块偏移）
        for (let j = 0; j < rowArr.length; j++) {
          const v = rowArr[j];
          if (v === '' || v == null) continue;
          const absCol = cStart + j; // 绝对列号（含分块偏移）
          grid.set(absRow + ',' + absCol, String(v));
        }
      }
    }
  }
  return grid;
}

// 从一个单元格文本中抽出所有 http(s) URL（按常见分隔符切分：全角/半角逗号、分号、空白、
// 换行、引号、括号）。单元格可能是富文本——多个 =HYPERLINK 用「、/，」连在一起——必须拆开
// 逐个处理，否则整串当作一个 URL 发给 OSS，会让 Signature 被污染而报 SignatureDoesNotMatch。
function extractUrlsFromCell(text) {
  if (!text || typeof text !== 'string') return [];
  const re = /https?:\/\/[^\s，,；;"')\]]+/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

// 某些单元格里的链接被飞书以「超链接」形式存储，valueRenderOption=ToString 可能只返回
// 显示文本（被截断/不含签名查询串）。尝试用 Formula / UnformattedValue 渲染方式找回
// 含 Expires/Signature 的完整预签名 URL（返回整串文本，交给 extractUrlsFromCell 拆分）。
async function recoverCellUrl(token, spreadsheetToken, sheetId, addr) {
  for (const ro of ['Formula', 'UnformattedValue']) {
    try {
      const r = await feishuCall('GET',
        '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values/' + sheetId + '!' + addr + ':' + addr,
        { params: { valueRenderOption: ro }, token });
      if (r.code !== 0) continue;
      const vals = (r.data && r.data.valueRange && r.data.valueRange.values) || [];
      const cell = vals[0] && vals[0][0];
      if (!cell) continue;
      const s = String(cell);
      if (/https?:\/\//.test(s)) return s; // 返回整串，交由 extractUrlsFromCell 按分隔符拆成多个 URL
    } catch (e) { /* 忽略，继续下一种渲染方式 */ }
  }
  return null;
}

async function scanSheet(spreadsheetToken, sheetId, sheetName, rowCount, columnCount) {
  const token = await getValidToken();
  const grid = await readSheetGrid(token, spreadsheetToken, sheetId, rowCount, columnCount);
  const cells = [];
  for (const [key, value] of grid.entries()) {
    if (!value || typeof value !== 'string') continue;
    // 1) 先从 ToString 文本里抽 URL（富文本多链接会被拆成多个）
    let urls = extractUrlsFromCell(value).filter((u) => isImageUrl(u));
    // 2) 仅当「单元格里明确含 http、但一层 ToString 没抽到任何可识别的 URL」时，
    //    才用 Formula/UnformattedValue 渲染兜底（典型场景：超链接公式 =HYPERLINK("url","文字")，
    //    ToString 只返回显示文字）。若已经抽到 URL（即使未签名），无需走兜底，避免无关单元格
    //    每格狂打 2 次飞书 API 导致扫描极慢。
    if (urls.length === 0 && /https?:\/\//.test(value)) {
      const [rowStr0, colStr0] = key.split(',');
      const addr = colLetter(parseInt(colStr0, 10)) + rowStr0;
      const recovered = await recoverCellUrl(token, spreadsheetToken, sheetId, addr);
      if (recovered) {
        const ru = extractUrlsFromCell(recovered).filter((u) => isImageUrl(u));
        if (ru.length) urls = ru;
      }
    }
    if (urls.length === 0) continue;
    // 同一单元格内去重，避免重复链接被拼两次
    const uniq = [...new Set(urls)];
    const [rowStr, colStr] = key.split(',');
    const row = parseInt(rowStr, 10);
    const col = parseInt(colStr, 10);
    const addr = colLetter(col) + row;
    // 一格一图：直接写回原单元格；一格多图：把所有图拼成一张网格图写回原单元格
    // （不新增列、不改表结构，彻底避免「插入列打乱整表顺序」的问题）
    cells.push({ sheetId, sheetName, range: addr, row, col, urls: uniq, url: uniq[0], source: 'text', imageCount: uniq.length });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// 图片下载（带重试与请求头兜底 + 失败落盘日志）
// ---------------------------------------------------------------------------
// 现象：alifile.sojump.cn（问卷星 Aliyun OSS）在国内 CDN 可直接下载，但在部分
// 出口网络（如 Render 服务器）会被 CDN/WAF 间歇性返回 HTTP 403，浏览器/手动点击
// 却正常。此类 403 多为限流或边缘节点临时拦截，重试即过。因此：
//   1) 失败自动重试（指数退避，最多 4 次）；
//   2) 逐次升级请求头（先纯 UA，再补 Accept，再补 Referer），兼容防盗链边缘；
//   3) 把 OSS 返回的状态码/错误体/响应头写入 convert.log，便于脱离 Render 控制台复盘。
const FLC_LOG_FILE = path.join(ROOT, 'convert.log');
function logFail(entry) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(FLC_LOG_FILE, line);
  } catch (e) { /* 日志写入失败不影响主流程 */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 Node 内置 http/https 直接发请求（不经过 undici 的 fetch URL 序列化），
// 拿 pathname+search 原文发出，避免预签名 URL 的查询串被改写导致 OSS 报 SignatureDoesNotMatch。
// 同时：URL 清洗(&amp;->&、去首尾空格)、手动跟随重定向、403/429/5xx 重试退避。
function rawGet(url, headers, maxRedirects) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, // 原文，不重编码
      headers,
    };
    const req = lib.request(opts, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && maxRedirects > 0 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u.href).href;
        resolve(rawGet(next, headers, maxRedirects - 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: code, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('下载超时(30s)')));
    req.end();
  });
}

async function downloadImage(inputUrl) {
  let lastErr;
  // URL 清洗：从网页/飞书富文本粘来的链接常把 & 存成 &amp;，或带首尾不可见字符
  let url = String(inputUrl || '').trim();
  // 反复解码 &amp;（可能双重编码成 &amp;amp;），避免预签名 URL 的 & 被存成 HTML 实体导致签名校验失败
  let guard = 0;
  while (url.includes('&amp;') && guard++ < 5) url = url.replace(/&amp;/gi, '&');
  // 链接缺少签名参数（Expires/Signature）：说明单元格里存的是不完整的预签名 URL，
  // 重试/换请求头都无解，直接给出明确提示，避免无意义的重试与 403 堆积
  if (!/[?&](Expires|Signature)=/.test(url)) {
    throw new Error('图片链接不完整（缺少 Expires/Signature 签名参数）：单元格里存的 URL 似乎只到 "?" 为止，或签名部分被截断。' +
      '请重新从问卷星/源文件复制【完整】的预签名链接（形如 ...jpg?Expires=...&OSSAccessKeyId=...&Signature=...）粘贴进单元格。' +
      ' || tried=' + url.slice(0, 4000));
  }
  let host = '';
  try { host = new URL(url).host; } catch (e) { /* ignore */ }
  const headerSets = [
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': 'https://' + host + '/',
    },
    {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'image/*',
      'Referer': 'https://www.wjx.cn/',
    },
  ];
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    const headers = headerSets[Math.min(attempt, headerSets.length - 1)];
    try {
      const { status, headers: rh, buf } = await rawGet(url, headers, 5);
      if (status >= 200 && status < 300) {
        if (buf.length < 50) throw new Error('下载内容过小(' + buf.length + 'B)，可能不是图片');
        return buf;
      }
      const body = buf.toString('utf8');
      lastErr = new Error('图片下载失败 HTTP ' + status + (body ? ' | ' + body.slice(0, 200) : ''));
      // 把 OSS 返回的错误体落盘，便于脱离 Render 控制台复盘
      logFail({ url, status, attempt, body: body.slice(0, 600), respHeaders: rh });
      // 403/429/5xx 视为可重试（限流或边缘节点拦截）；其余 4xx 直接抛出不再重试
      if (status === 403 || status === 429 || status >= 500) {
        await sleep(800 * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    } catch (e) {
      lastErr = e;
      // 网络层异常（DNS/TLS/超时）也重试
      await sleep(800 * Math.pow(2, attempt));
    }
  }
  // 把尝试过的真实 URL 带进错误，便于你直接复制比对单元格里的原文
  throw new Error((lastErr ? lastErr.message : '图片下载失败（未知原因）') + ' || tried=' + url.slice(0, 4000));
}

// 把多张图片拼成一张「自动网格图」：按图片数量自动排成 2~3 列网格，白底补边对齐。
// buffers: 各图原始二进制；返回 PNG buffer。一格多图时用此函数合成为单图后再写回原单元格。
//
// 说明：sharp 已作为普通依赖安装（Render 安装时不会省略），且 sharp 0.33 走官方预编译二进制、
// 无需本地编译，因此「一格多图」拼合的主路径直接用 sharp 解码（PNG/JPEG/WEBP 全格式支持，
// 不会出现 filter 128 等纯 JS 解码器无法处理的非标准图）。纯 JS 解码仅在 sharp 万一缺失时作兜底。
const zlib = require('zlib');

// ---- 零依赖 PNG 编解码（仅依赖 Node 内置 zlib）----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function pngEncodeRGBA(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter = None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function pngDecodeToRGBA(buf) {
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)) throw new Error('不是 PNG');
  let off = 8, width = 0, height = 0, colorType = 6, bitDepth = 8; const idat = []; let plte = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      const interlace = data[12];
      if (interlace !== 0) throw new Error('不支持交错(Adam7) PNG，请安装 sharp 依赖解码');
    } else if (type === 'PLTE') { plte = data; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8-bit PNG，请安装 sharp 依赖解码（bitDepth=' + bitDepth + '）');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : colorType === 3 ? 1 : (() => { throw new Error('不支持的 PNG colorType ' + colorType); })();
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v;
      switch (ft) {
        case 0: v = line[i]; break;
        case 1: v = line[i] + a; break;
        case 2: v = line[i] + b; break;
        case 3: v = line[i] + ((a + b) >> 1); break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); v = line[i] + pr; break; }
        default: v = line[i]; break; // 未知 filter 兜底为 None，避免非标准 PNG 崩溃
      }
      cur[i] = v & 0xFF;
    }
    for (let x = 0; x < width; x++) {
      if (colorType === 6) {
        out[(y * width + x) * 4] = cur[x * 4]; out[(y * width + x) * 4 + 1] = cur[x * 4 + 1];
        out[(y * width + x) * 4 + 2] = cur[x * 4 + 2]; out[(y * width + x) * 4 + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[(y * width + x) * 4] = cur[x * 3]; out[(y * width + x) * 4 + 1] = cur[x * 3 + 1];
        out[(y * width + x) * 4 + 2] = cur[x * 3 + 2]; out[(y * width + x) * 4 + 3] = 255;
      } else if (colorType === 4) {
        out[(y * width + x) * 4] = cur[x * 2]; out[(y * width + x) * 4 + 1] = cur[x * 2];
        out[(y * width + x) * 4 + 2] = cur[x * 2]; out[(y * width + x) * 4 + 3] = cur[x * 2 + 1];
      } else if (colorType === 0) {
        const g = cur[x]; out[(y * width + x) * 4] = g; out[(y * width + x) * 4 + 1] = g; out[(y * width + x) * 4 + 2] = g; out[(y * width + x) * 4 + 3] = 255;
      } else if (colorType === 3 && plte) {
        const idx = cur[x]; const pr = plte[idx * 3], pg = plte[idx * 3 + 1], pb = plte[idx * 3 + 2];
        out[(y * width + x) * 4] = pr; out[(y * width + x) * 4 + 1] = pg; out[(y * width + x) * 4 + 2] = pb; out[(y * width + x) * 4 + 3] = 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, data: out };
}
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / dw));
      const si = (sy * sw + sx) * 4, di = (y * dw + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}
function isPNG(buf) { return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47; }
async function decodeImage(buf) {
  // 主路径：用 sharp 解码（普通依赖，Render 预编译安装，PNG/JPEG/WEBP 全格式支持，且不会因
  // 非标准 filter / 非 8-bit / 交错等导致「不支持的 PNG filter 128」这类纯 JS 解码器无法处理的报错）。
  try {
    const S = getSharp();
    const m = await S(buf, { failOn: 'none', unlimited: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: m.info.width, height: m.info.height, data: m.data };
  } catch (se) {
    // 兜底：sharp 万一缺失时，仅 8-bit PNG 用纯 JS 解码（已尽量兼容更多 colorType / 未知 filter）。
    if (isPNG(buf)) return pngDecodeToRGBA(buf);
    throw new Error('当前部署环境未安装 sharp 依赖，无法解码非 PNG 图片（JPEG/WEBP 需要 sharp）：' + se.message);
  }
}
async function composeImages(buffers) {
  const THUMB = 600; // 每张缩略图最长边上限（px），防止拼出超大图
  const PAD = 10;    // 网格间距（px）
  const prepared = [];
  for (const b of buffers) {
    const img = await decodeImage(b);
    const scale = Math.min(1, THUMB / Math.max(img.width, img.height));
    const tw = Math.max(1, Math.round(img.width * scale));
    const th = Math.max(1, Math.round(img.height * scale));
    prepared.push({ data: resizeRGBA(img.data, img.width, img.height, tw, th), tw, th });
  }
  const n = prepared.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n))); // 2~3 列
  const rows = Math.ceil(n / cols);
  const colW = new Array(cols).fill(0);
  const rowH = new Array(rows).fill(0);
  prepared.forEach((im, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c], im.tw);
    rowH[r] = Math.max(rowH[r], im.th);
  });
  const gridW = colW.reduce((a, b) => a + b, 0) + PAD * (cols + 1);
  const gridH = rowH.reduce((a, b) => a + b, 0) + PAD * (rows + 1);
  const canvas = Buffer.alloc(gridW * gridH * 4, 255); // 白底
  let x = PAD;
  for (let c = 0; c < cols; c++) {
    let y = PAD;
    for (let r = 0; r < rows; r++) {
      const i = r * cols + c;
      if (i < n) {
        const im = prepared[i];
        for (let yy = 0; yy < im.th; yy++) {
          for (let xx = 0; xx < im.tw; xx++) {
            const si = (yy * im.tw + xx) * 4;
            const di = ((y + yy) * gridW + (x + xx)) * 4;
            canvas[di] = im.data[si]; canvas[di + 1] = im.data[si + 1];
            canvas[di + 2] = im.data[si + 2]; canvas[di + 3] = im.data[si + 3];
          }
        }
      }
      y += rowH[r] + PAD;
    }
    x += colW[c] + PAD;
  }
  return pngEncodeRGBA(gridW, gridH, canvas);
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
    try {
      const token = await getValidToken();
      for (const c of cells) {
        const r = { range: c.range, source: c.source, status: 'pending', imageCount: c.imageCount || 1 };
        try {
          let base64, ext;
          if (c.urls && c.urls.length > 1) {
            // 一格多图：先逐张下载，再拼成一张网格图写回原单元格
            const bufs = [];
            for (const u of c.urls) bufs.push(await downloadImage(u));
            const merged = await composeImages(bufs);
            base64 = merged.toString('base64');
            ext = '.png';
          } else {
            const buf = await downloadImage(c.url);
            ext = guessExt(c.url);
            base64 = buf.toString('base64');
          }
          const range = `${sheetId}!${c.range}:${c.range}`;
          const wr = await feishuCall('POST',
            '/open-apis/sheets/v2/spreadsheets/' + spreadsheetToken + '/values_image',
            { body: { range, image: base64, name: 'flc' + ext }, token });
          if (wr.code === 0) {
            r.status = 'done';
            if (c.urls && c.urls.length > 1) r.merged = c.urls.length; // 标记：本格由 N 张拼成
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
    }
  })();
  return job;
}

// （已移除「插入列」补救逻辑：现改为「一格多图自动拼成一张网格图写回原单元格」，
//   不新增任何列、不改表结构，彻底避免打乱整表顺序。）

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
        sharpReady: (() => { try { getSharp(); return true; } catch (e) { return false; } })(),
        sharpError: (() => { try { getSharp(); return null; } catch (e) { return String(e && e.message || e); } })(),
        version: '2.5',
        build: '2026-09-02-sharp-force-reinstall',
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
      if (!spreadsheetToken || !sheetId) return sendJSON(res, 400, { ok: false, error: '缺少 spreadsheetToken 或 sheetId' });
      try {
        // 动态获取该子表真实行列数（文档有多少行列就扫多少，不设固定上限）
        const size = await getSheetGridSize(spreadsheetToken, sheetId);
        // 兜底：极少数情况下 sheets/query 未返回 grid_properties（或返回 0），
        // 不要直接报错中断，而是扫描一个充足范围，避免「整表无链接」的误判。
        // 注意：AE/AF/AG 等截图列通常已超出早期 25 列上限，故兜底列数取 100。
        const rowCount = size.row_count || 1000;
        const columnCount = size.column_count || 100;
        const cells = await scanSheet(spreadsheetToken, sheetId, sheetName, rowCount, columnCount);
        const mergedCount = cells.filter((c) => c.imageCount > 1).length;
        // 诊断信息：若命中为 0，前端/日志可据此判断是否权限或范围问题，而非静默无链接。
        console.log('[scan] sheet=' + sheetId + ' range=' + rowCount + 'x' + columnCount + ' 命中图链单元格=' + cells.length);
        if (cells.length === 0) {
          console.log('[scan] 未命中任何图链：请检查 operator 令牌是否有 sheets:spreadsheet:read 权限，以及目标列是否确为图片链接文本。');
        }
        return sendJSON(res, 200, { ok: true, total: cells.length, cells, mergedCount, row_count: rowCount, column_count: columnCount });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: '扫描失败：' + String(e.message || e).slice(0, 600) });
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

    // （拼图方案下不再需要「插入列补救」接口；多图已在转换时自动拼合写回原单元格。）

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
