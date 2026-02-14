/* Simple production server:
 * - Serves Vite `dist/` as an SPA (index.html fallback)
 * - Proxies same-origin `/api/*` to the solver service (to avoid HTTPS mixed-content issues)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 80);
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

const SOLVER_INTERNAL_URL = process.env.SOLVER_INTERNAL_URL || 'http://solver:8080';
const solverBase = new URL(SOLVER_INTERNAL_URL);

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Not found');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', contentTypeFor(filePath));
    res.end(data);
  });
}

function proxyToSolver(req, res) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  // Strip `/api` prefix. `/api/v1/...` -> `/v1/...`
  const upstreamPath = u.pathname.replace(/^\/api/, '') + (u.search || '');

  const options = {
    protocol: solverBase.protocol,
    hostname: solverBase.hostname,
    port: solverBase.port || (solverBase.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: upstreamPath,
    headers: {
      ...req.headers,
      host: solverBase.host,
    },
  };

  // Ensure upstream sees JSON as JSON; do not cache hop-by-hop headers
  delete options.headers.connection;
  delete options.headers['content-length'];

  const transport = solverBase.protocol === 'https:' ? https : http;
  const upstreamReq = transport.request(options, (upstreamRes) => {
    res.statusCode = upstreamRes.statusCode || 502;
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (typeof v !== 'undefined') res.setHeader(k, v);
    }
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (e) => {
    res.statusCode = 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'UPSTREAM_ERROR', message: String(e && e.message ? e.message : e) }));
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  if (req.url.startsWith('/api/')) {
    proxyToSolver(req, res);
    return;
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(u.pathname);

  // Static assets
  const candidate = path.normalize(path.join(DIST_DIR, pathname));
  if (candidate.startsWith(DIST_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    serveFile(res, candidate);
    return;
  }

  // SPA fallback
  serveFile(res, INDEX_HTML);
});

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`frontend server listening on :${PORT}, proxy /api -> ${SOLVER_INTERNAL_URL}`);
});

