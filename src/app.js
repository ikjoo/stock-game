// HTTP 계층: 라우팅과 정적 파일 제공만 담당한다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR } = require('./config');
const game = require('./game');
const ai = require('./ai');
const { HttpError } = require('./errors');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const MAX_BODY_BYTES = 10 * 1024;
const PUBLIC_ROOT = path.resolve(PUBLIC_DIR);

// POST 라우트: 바디(JSON)를 받아 게임 상태를 돌려준다.
const postRoutes = {
  '/api/start': game.startGame,
  '/api/buy': game.buy,
  '/api/sell': game.sell,
  '/api/end-turn': game.endTurn,
  '/api/ai/recommend': ai.recommend, // async: 상태를 바꾸지 않는 추천만 반환
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** JSON 바디를 읽는다. 크기 초과 413, 형식 오류 400. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '요청 본문이 너무 큽니다.');
    chunks.push(chunk);
  }
  // 청크를 Buffer로 모은 뒤 한 번에 디코딩해야 멀티바이트(한글)가 깨지지 않는다.
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '잘못된 요청 형식입니다.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, '잘못된 요청 형식입니다.');
  }
  return data;
}

/** 브라우저의 단순 교차 출처 요청(text/plain 등)을 막기 위해 JSON만 허용한다. */
function requireJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type은 application/json 이어야 합니다.');
}

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return false;
  }
  const full = path.resolve(PUBLIC_ROOT, '.' + rel);
  if (!full.startsWith(PUBLIC_ROOT + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
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
    requireJson(req);
    return sendJson(res, 200, await postRoutes[pathname](await readJson(req)));
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
