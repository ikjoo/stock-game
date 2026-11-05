// 가상 주식 투자 게임 서버 (Node 내장 SQLite 사용, 외부 패키지 불필요)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3456;
const START_MONEY = 1_000_000;
const START_PRICE = 5000;
const TOTAL_TURNS = 5;
const STOCKS = [
  '삼성전자', '하이닉스', '네이버', '카카오', '현대차',
  '셀트리온', '포스코', 'LG화학', '기아', '크래프톤',
].map((name, i) => ({ id: i + 1, name }));

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'game.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 1,
  cash INTEGER NOT NULL,
  traded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'playing',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS holdings (
  game_id INTEGER NOT NULL,
  stock_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, stock_id)
);
CREATE TABLE IF NOT EXISTS prices (
  game_id INTEGER NOT NULL,
  stock_id INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  price INTEGER NOT NULL,
  PRIMARY KEY (game_id, stock_id, turn)
);
CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  final_money INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function priceOf(gameId, stockId, turn) {
  return q1('SELECT price FROM prices WHERE game_id=? AND stock_id=? AND turn=?', gameId, stockId, turn).price;
}

function view(gameId) {
  const g = q1('SELECT * FROM games WHERE id=?', gameId);
  if (!g) throw new HttpError(404, '게임을 찾을 수 없습니다.');
  const held = Object.fromEntries(q('SELECT stock_id, qty FROM holdings WHERE game_id=?', gameId).map(r => [r.stock_id, r.qty]));
  const stocks = STOCKS.map(s => {
    const price = priceOf(gameId, s.id, g.turn);
    const prev = g.turn > 1 ? priceOf(gameId, s.id, g.turn - 1) : null;
    const history = q('SELECT price FROM prices WHERE game_id=? AND stock_id=? AND turn<=? ORDER BY turn', gameId, s.id, g.turn).map(r => r.price);
    return { ...s, price, prev, history, qty: held[s.id] || 0 };
  });
  const stockValue = stocks.reduce((a, s) => a + s.price * s.qty, 0);
  return {
    id: g.id, name: g.name, turn: g.turn, totalTurns: TOTAL_TURNS, cash: g.cash,
    traded: !!g.traded, status: g.status, stocks, stockValue, total: g.cash + stockValue,
    startMoney: START_MONEY,
  };
}

function getPlaying(gameId) {
  const g = q1('SELECT * FROM games WHERE id=?', gameId);
  if (!g) throw new HttpError(404, '게임을 찾을 수 없습니다.');
  if (g.status !== 'playing') throw new HttpError(400, '이미 종료된 게임입니다.');
  return g;
}

function positiveInt(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '수량은 1 이상의 정수여야 합니다.');
  return n;
}

function stockOrFail(id) {
  const s = STOCKS.find(s => s.id === Number(id));
  if (!s) throw new HttpError(400, '존재하지 않는 종목입니다.');
  return s;
}

const api = {
  'POST /api/start': ({ name }) => tx(() => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) throw new HttpError(400, '이름을 입력하세요.');
    const id = Number(run('INSERT INTO games (name, cash) VALUES (?, ?)', name, START_MONEY).lastInsertRowid);
    for (const s of STOCKS) run('INSERT INTO prices VALUES (?,?,?,?)', id, s.id, 1, START_PRICE);
    return view(id);
  }),

  'POST /api/buy': ({ gameId, stockId, qty }) => tx(() => {
    const g = getPlaying(gameId);
    const s = stockOrFail(stockId);
    qty = positiveInt(qty);
    const cost = priceOf(g.id, s.id, g.turn) * qty;
    if (cost > g.cash) throw new HttpError(400, '보유 금액이 부족합니다.');
    run('UPDATE games SET cash=cash-?, traded=1 WHERE id=?', cost, g.id);
    run(`INSERT INTO holdings (game_id, stock_id, qty) VALUES (?,?,?)
         ON CONFLICT(game_id, stock_id) DO UPDATE SET qty=qty+excluded.qty`, g.id, s.id, qty);
    return view(g.id);
  }),

  'POST /api/sell': ({ gameId, stockId, qty }) => tx(() => {
    const g = getPlaying(gameId);
    const s = stockOrFail(stockId);
    qty = positiveInt(qty);
    const h = q1('SELECT qty FROM holdings WHERE game_id=? AND stock_id=?', g.id, s.id);
    if (!h || h.qty < qty) throw new HttpError(400, '보유 수량이 부족합니다.');
    run('UPDATE games SET cash=cash+?, traded=1 WHERE id=?', priceOf(g.id, s.id, g.turn) * qty, g.id);
    run('UPDATE holdings SET qty=qty-? WHERE game_id=? AND stock_id=?', qty, g.id, s.id);
    return view(g.id);
  }),

  'POST /api/end-turn': ({ gameId }) => tx(() => {
    const g = getPlaying(gameId);
    if (g.turn < TOTAL_TURNS) {
      // 다음 턴 시세: 종목별 -20% ~ +25% 랜덤 변동 (최저 100원, 10원 단위)
      for (const s of STOCKS) {
        const cur = priceOf(g.id, s.id, g.turn);
        const rate = -0.20 + Math.random() * 0.45;
        const next = Math.max(100, Math.round(cur * (1 + rate) / 10) * 10);
        run('INSERT INTO prices VALUES (?,?,?,?)', g.id, s.id, g.turn + 1, next);
      }
      run('UPDATE games SET turn=turn+1, traded=0 WHERE id=?', g.id);
      return view(g.id);
    }
    // 마지막 턴 종료: 전량 매도 후 랭킹 저장
    let proceeds = 0;
    for (const h of q('SELECT stock_id, qty FROM holdings WHERE game_id=?', g.id)) {
      proceeds += h.qty * priceOf(g.id, h.stock_id, g.turn);
    }
    const finalMoney = g.cash + proceeds;
    run('UPDATE holdings SET qty=0 WHERE game_id=?', g.id);
    run("UPDATE games SET cash=?, status='finished' WHERE id=?", finalMoney, g.id);
    run('INSERT INTO rankings (game_id, name, final_money) VALUES (?,?,?)', g.id, g.name, finalMoney);
    return { ...view(g.id), finished: true, finalMoney, proceeds };
  }),
};

function rankings() {
  return q('SELECT id, game_id, name, final_money, created_at FROM rankings ORDER BY final_money DESC, id ASC')
    .map((r, i) => ({ rank: i + 1, ...r, profit: r.final_money - START_MONEY }));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && url.pathname === '/api/rankings') return json(200, rankings());
    const m = url.pathname.match(/^\/api\/game\/(\d+)$/);
    if (req.method === 'GET' && m) return json(200, view(Number(m[1])));

    const handler = api[`${req.method} ${url.pathname}`];
    if (handler) {
      let raw = '';
      for await (const c of req) raw += c;
      return json(200, handler(raw ? JSON.parse(raw) : {}));
    }

    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(__dirname, 'public', file);
      if (full.startsWith(path.join(__dirname, 'public')) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        return res.end(fs.readFileSync(full));
      }
    }
    json(404, { error: '찾을 수 없습니다.' });
  } catch (e) {
    json(e.status || 500, { error: e.status ? e.message : '서버 오류: ' + e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`주식 게임 서버 실행 중: http://localhost:${PORT}`));
