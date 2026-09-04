// dev-server.mjs  （零依赖，仅用 Node 内置模块）
// 1) 静态托管整个项目（含 preview/ 与核心模块）
// 2) 可选反向代理：/proxy/<vendor>/<path> -> 真实厂商接口，密钥由服务端注入
//    用于规避官方 API 的浏览器 CORS，且 API Key 不进入前端。
//
// 安全约定（本地开发服务也必须遵守）：
// - 只绑定 127.0.0.1：默认监听会绑到 0.0.0.0，同网段任何设备都能拿到静态文件
//   并通过 /proxy/* 白嫖本机配置的 API 配额。
// - 密钥文件（preview/secrets.json）、.git、node_modules 永不经静态服务暴露。
// - 代理只接受本机来源：浏览器发起的跨站请求（恶意网页 CSRF 驱动带密钥的代理）会被拒绝。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 5173;

// 各厂商真实 Base（代理模式使用）
const VENDOR_BASE = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  ollama: 'http://localhost:11434',
  ima: 'https://ima.qq.com',
};

// 服务端密钥（绝不发送到前端）。从 preview/secrets.json 读取。
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'preview', 'secrets.json'), 'utf8'));
} catch { /* 直连模式无需该文件 */ }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 静态服务永不下发的路径：密钥文件、版本库、依赖目录
const STATIC_DENYLIST = ['secrets.json', '.git', 'node_modules'];

function isDenied(urlPath) {
  const p = urlPath.toLowerCase();
  return STATIC_DENYLIST.some(d => p === '/' + d || p.startsWith('/' + d + '/') || p.includes('/' + d + '/'));
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    // 畸形编码（/%ZZ）会让 decodeURIComponent 抛 URIError；不捕获会打崩整个进程
    res.writeHead(400); res.end('bad request'); return;
  }
  if (urlPath === '/') urlPath = '/preview/index.html';
  if (isDenied(urlPath)) { res.writeHead(403); res.end('forbidden'); return; }
  const filePath = path.resolve(path.join(ROOT, urlPath));
  // path.resolve + 分隔符后缀比较：startsWith(ROOT) 会被同前缀兄弟目录
  // （如 Browser_AI_Extensions_backup）绕过
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function filterHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (['content-length', 'connection', 'transfer-encoding'].includes(lk)) continue;
    out[k] = v;
  }
  return out;
}

/** 代理只服务本机来源：拒绝跨站页面驱动的请求（CSRF 驱动本机代理打厂商接口） */
function allowedOrigin(req) {
  const host = String(req.headers.host || '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 同源 GET 等无 Origin 头
  try {
    const o = new URL(origin);
    return o.hostname === 'localhost' || o.hostname === '127.0.0.1' || o.hostname === '[::1]';
  } catch {
    return false;
  }
}

function proxy(req, res, vendor, restPath) {
  const base = VENDOR_BASE[vendor];
  if (!base) { res.writeHead(400); res.end('unknown vendor: ' + vendor); return; }
  if (!allowedOrigin(req)) {
    res.writeHead(403, { 'Access-Control-Allow-Origin': 'null' });
    res.end('forbidden: proxy 仅接受本机来源请求');
    return;
  }

  let target = base + '/' + restPath;
  // Gemini：把 key 参数替换为服务端密钥
  if (vendor === 'gemini' && secrets.gemini) {
    target = target.replace(/([?&]key=)[^&]*/, '$1' + secrets.gemini);
    if (!/[?&]key=/.test(target)) {
      target += (target.includes('?') ? '&' : '?') + 'key=' + secrets.gemini;
    }
  }

  const parsed = new URL(target);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers.host; delete headers.connection; delete headers['content-length'];
    delete headers.origin; delete headers.referer;
    if (vendor === 'openai' && secrets.openai) headers.authorization = 'Bearer ' + secrets.openai;
    if (vendor === 'anthropic' && secrets.anthropic) {
      headers['x-api-key'] = secrets.anthropic;
      headers['anthropic-version'] = '2023-06-01';
    }
    if (vendor === 'gemini') delete headers.authorization;
    if (vendor === 'ima' && secrets.ima) {
      headers['ima-openapi-clientid'] = secrets.ima.clientId || '';
      headers['ima-openapi-apikey'] = secrets.ima.apiKey || '';
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const opt = {
      method: req.method,
      headers,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
    };
    const p = lib.request(opt, (up) => {
      res.writeHead(up.statusCode, filterHeaders(up.headers));
      up.pipe(res); // 流式透传（支持 SSE / 增量）
      up.on('error', () => { try { res.destroy(); } catch (_) {} });
    });
    p.on('error', (e) => {
      // 上游失败时可能响应头已发出（如中途断流）：再 writeHead 会抛 ERR_HTTP_HEADERS_SENT 打崩进程
      if (res.headersSent) { try { res.destroy(); } catch (_) {} return; }
      res.writeHead(502); res.end('proxy error: ' + e.message);
    });
    if (body.length) p.write(body);
    p.end();
  });
}

const server = http.createServer((req, res) => {
  try {
    const m = req.url.match(/^\/proxy\/(\w+)\/(.*)$/);
    if (m) { proxy(req, res, m[1], m[2]); return; }
    serveStatic(req, res);
  } catch (e) {
    // 兜底：任何请求处理异常都不允许带崩整个 dev server
    if (!res.headersSent) { try { res.writeHead(500); res.end('internal error'); } catch (_) {} }
    console.warn('[dev-server] request error:', e && e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  本地预览已启动:  http://localhost:${PORT}（仅监听 ${HOST}）`);
  console.log(`  代理模式:       ${Object.keys(secrets).length ? '已配置密钥' : '未配置 preview/secrets.json（仅直连模式）'}\n`);
});
