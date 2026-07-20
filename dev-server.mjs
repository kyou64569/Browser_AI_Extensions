// dev-server.mjs  （零依赖，仅用 Node 内置模块）
// 1) 静态托管整个项目（含 preview/ 与核心模块）
// 2) 可选反向代理：/proxy/<vendor>/<path> -> 真实厂商接口，密钥由服务端注入
//    用于规避官方 API 的浏览器 CORS，且 API Key 不进入前端。

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
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

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/preview/index.html';
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
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

function proxy(req, res, vendor, restPath) {
  const base = VENDOR_BASE[vendor];
  if (!base) { res.writeHead(400); res.end('unknown vendor: ' + vendor); return; }

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
    });
    p.on('error', (e) => { res.writeHead(502); res.end('proxy error: ' + e.message); });
    if (body.length) p.write(body);
    p.end();
  });
}

const server = http.createServer((req, res) => {
  const m = req.url.match(/^\/proxy\/(\w+)\/(.*)$/);
  if (m) { proxy(req, res, m[1], m[2]); return; }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`\n  本地预览已启动:  http://localhost:${PORT}`);
  console.log(`  代理模式:       ${Object.keys(secrets).length ? '已配置密钥' : '未配置 preview/secrets.json（仅直连模式）'}\n`);
});
