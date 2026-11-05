// HTTP 계층: 라우팅과 정적 파일 제공만 담당한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('./config');
const game = require('./game');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

// POST 라우트: 바디(JSON)를 받아 게임 상태를 돌려준다.
const postRoutes = {
  '/api/start': game.startGame,
  '/api/buy': game.buy,
  '/api/sell': game.sell,
  '/api/end-turn': game.endTurn,
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function serveStatic(res, pathname) {
  const full = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname.slice(1));
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
  return true;
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET') {
    if (pathname === '/api/rankings') return sendJson(res, 200, game.rankings());
    const m = pathname.match(/^\/api\/game\/(\d+)$/);
    if (m) return sendJson(res, 200, game.view(Number(m[1])));
    if (serveStatic(res, pathname)) return;
  } else if (req.method === 'POST' && postRoutes[pathname]) {
    return sendJson(res, 200, postRoutes[pathname](await readJson(req)));
  }
  sendJson(res, 404, { error: '찾을 수 없습니다.' });
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (e) {
      sendJson(res, e.status || 500, { error: e.status ? e.message : '서버 오류: ' + e.message });
    }
  });
}

module.exports = { createServer };
