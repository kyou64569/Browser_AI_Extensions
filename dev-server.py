#!/usr/bin/env python3
# dev-server.py  （零依赖，仅用 Python 标准库）
# 功能同 dev-server.mjs：静态托管 + 可选 /proxy/<vendor>/<path> 反向代理。
# 说明：Python 版代理为“整块缓冲”转发（非增量流式），预览足够；如需打字机流式效果请用 Node 版。
#
# 安全约定（与 dev-server.mjs 一致）：
# - 只绑定 127.0.0.1，密钥文件/.git/node_modules 不经静态服务暴露。
# - 代理只接受本机来源，拒绝跨站页面 CSRF 驱动。

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import json
import os
import re

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = int(os.environ.get('PORT', '5173'))

VENDOR_BASE = {
    'openai': 'https://api.openai.com/v1',
    'anthropic': 'https://api.anthropic.com/v1',
    'gemini': 'https://generativelanguage.googleapis.com/v1beta',
    'ollama': 'http://localhost:11434',
}

secrets = {}
sp = os.path.join(ROOT, 'preview', 'secrets.json')
if os.path.exists(sp):
    try:
        secrets = json.load(open(sp, encoding='utf-8'))
    except Exception:
        secrets = {}

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
}

# 静态服务永不下发的路径
STATIC_DENYLIST = ['secrets.json', '.git', 'node_modules']


def _denied(urlpath):
    p = urlpath.lower()
    return any(d in p for d in ('/' + x for x in STATIC_DENYLIST))


def _local_origin(headers):
    host = (headers.get('Host') or '').split(':')[0]
    if host not in ('localhost', '127.0.0.1', '[::1]', '::1'):
        return False
    origin = headers.get('Origin')
    if not origin:
        return True
    try:
        o = urllib.parse.urlparse(origin)
        return o.hostname in ('localhost', '127.0.0.1', '::1')
    except Exception:
        return False


class Handler(http.server.BaseHTTPRequestHandler):
    def _serve_static(self):
        urlpath = urllib.parse.unquote(self.path.split('?')[0], errors='replace')
        if urlpath == '/':
            urlpath = '/preview/index.html'
        if _denied(urlpath):
            self.send_error(403); return
        fp = os.path.normpath(os.path.join(ROOT, urlpath.lstrip('/')))
        # normpath 后必须是 ROOT 或其子路径；startsWith 裸比较会被同前缀兄弟目录绕过
        if fp != ROOT and not fp.startswith(ROOT + os.sep):
            self.send_error(403); return
        if not os.path.isfile(fp):
            self.send_error(404); return
        with open(fp, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(os.path.splitext(fp)[1], 'application/octet-stream'))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self, vendor, rest):
        base = VENDOR_BASE.get(vendor)
        if not base:
            self.send_error(400, 'unknown vendor'); return
        if not _local_origin(self.headers):
            self.send_error(403, 'proxy only serves local origins'); return
        target = base + '/' + rest
        if vendor == 'gemini' and secrets.get('gemini'):
            target = re.sub(r'([?&]key=)[^&]*', r'\1' + secrets['gemini'], target)
            if 'key=' not in target:
                target += ('&' if '?' in target else '?') + 'key=' + secrets['gemini']
        length = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(length) if length else None
        headers = {}
        if self.headers.get('Content-Type'):
            headers['Content-Type'] = self.headers['Content-Type']
        if vendor == 'openai' and secrets.get('openai'):
            headers['Authorization'] = 'Bearer ' + secrets['openai']
        if vendor == 'anthropic' and secrets.get('anthropic'):
            headers['x-api-key'] = secrets['anthropic']
            headers['anthropic-version'] = '2023-06-01'
        if vendor == 'gemini':
            headers.pop('Authorization', None)
        req = urllib.request.Request(target, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header('Content-Type', resp.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            err = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(err)))
            self.end_headers()
            self.wfile.write(err)
        except Exception as e:
            self.send_error(502, str(e))

    def do_GET(self):
        m = re.match(r'^/proxy/(\w+)/(.*)$', self.path)
        if m:
            self._proxy(m.group(1), m.group(2))
        else:
            self._serve_static()

    def do_POST(self):
        m = re.match(r'^/proxy/(\w+)/(.*)$', self.path)
        if m:
            self._proxy(m.group(1), m.group(2))
        else:
            self._serve_static()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    # 用多线程服务器：流式代理请求较慢（最长 120s）时，仍可同时响应页面静态 JS/CSS，
    # 避免对话期间预览页“卡住加载”。（与 .mjs 版的异步并发行为对齐）
    with socketserver.ThreadingTCPServer((HOST, PORT), Handler) as s:
        print(f'\n  本地预览已启动:  http://localhost:{PORT}（仅监听 {HOST}）')
        print(f'  代理模式:       {"已配置密钥" if secrets else "未配置 preview/secrets.json（仅直连模式）"}\n')
        s.serve_forever()
