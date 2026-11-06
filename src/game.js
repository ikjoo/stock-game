// 게임 규칙. HTTP를 모르고 DB와 config만 사용한다.
const cfg = require('./config');
const { all, get, run, tx } = require('./db');
const { HttpError } = require('./errors');

const { STOCKS, TOTAL_TURNS, START_MONEY, START_PRICE } = cfg;

// ---------- 조회 ----------

function priceOf(gameId, stockId, turn) {
  return get('SELECT price FROM prices WHERE game_id=? AND stock_id=? AND turn=?', gameId, stockId, turn).price;
}

function getGame(gameId) {
  const g = get('SELECT * FROM games WHERE id=?', gameId);
  if (!g) throw new HttpError(404, '게임을 찾을 수 없습니다.');
  return g;
}

function getPlayingGame(gameId) {
  const g = getGame(gameId);
  if (g.status !== 'playing') throw new HttpError(400, '이미 종료된 게임입니다.');
  return g;
}

/** 클라이언트가 그대로 렌더링하는 게임 상태 */
function view(gameId) {
  const g = getGame(gameId);
  const held = Object.fromEntries(
    all('SELECT stock_id, qty FROM holdings WHERE game_id=?', gameId).map(r => [r.stock_id, r.qty]),
  );
  const stocks = STOCKS.map(s => {
    const history = all(
      'SELECT price FROM prices WHERE game_id=? AND stock_id=? AND turn<=? ORDER BY turn',
      gameId, s.id, g.turn,
    ).map(r => r.price);
    const price = history[history.length - 1];
    const prev = history.length > 1 ? history[history.length - 2] : null;
    return { ...s, price, prev, history, qty: held[s.id] || 0 };
  });
  const stockValue = stocks.reduce((sum, s) => sum + s.price * s.qty, 0);
  return {
    id: g.id, name: g.name, turn: g.turn, totalTurns: TOTAL_TURNS, cash: g.cash,
    traded: !!g.traded, aiUsed: !!get('SELECT 1 AS x FROM ai_uses WHERE game_id=? AND turn=?', gameId, g.turn), status: g.status, stocks, stockValue, total: g.cash + stockValue,
    startMoney: START_MONEY, startPrice: START_PRICE,
  };
}

// ---------- 입력 검증 ----------

function parseQty(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '수량은 1 이상의 정수여야 합니다.');
  return n;
}

function parseStock(id) {
  const s = STOCKS.find(s => s.id === Number(id));
  if (!s) throw new HttpError(400, '존재하지 않는 종목입니다.');
  return s;
}

// ---------- 행동 ----------

const startGame = ({ name }) => tx(() => {
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new HttpError(400, '이름을 입력하세요.');
  const id = Number(run('INSERT INTO games (name, cash) VALUES (?, ?)', name, START_MONEY).lastInsertRowid);
  for (const s of STOCKS) run('INSERT INTO prices VALUES (?,?,?,?)', id, s.id, 1, START_PRICE);
  return view(id);
});

const buy = ({ gameId, stockId, qty }) => tx(() => {
  const g = getPlayingGame(gameId);
  const s = parseStock(stockId);
  qty = parseQty(qty);
  const cost = priceOf(g.id, s.id, g.turn) * qty;
  if (cost > g.cash) throw new HttpError(400, '보유 금액이 부족합니다.');
  run('UPDATE games SET cash=cash-?, traded=1 WHERE id=?', cost, g.id);
  run(`INSERT INTO holdings (game_id, stock_id, qty) VALUES (?,?,?)
       ON CONFLICT(game_id, stock_id) DO UPDATE SET qty=qty+excluded.qty`, g.id, s.id, qty);
  return view(g.id);
});

const sell = ({ gameId, stockId, qty }) => tx(() => {
  const g = getPlayingGame(gameId);
  const s = parseStock(stockId);
  qty = parseQty(qty);
  const h = get('SELECT qty FROM holdings WHERE game_id=? AND stock_id=?', g.id, s.id);
  if (!h || h.qty < qty) throw new HttpError(400, '보유 수량이 부족합니다.');
  run('UPDATE games SET cash=cash+?, traded=1 WHERE id=?', priceOf(g.id, s.id, g.turn) * qty, g.id);
  run('UPDATE holdings SET qty=qty-? WHERE game_id=? AND stock_id=?', qty, g.id, s.id);
  return view(g.id);
});

function nextPrice(current) {
  const rate = cfg.CHANGE_MIN + Math.random() * (cfg.CHANGE_MAX - cfg.CHANGE_MIN);
  return Math.max(cfg.MIN_PRICE, Math.round(current * (1 + rate) / cfg.PRICE_UNIT) * cfg.PRICE_UNIT);
}

function advanceTurn(g) {
  for (const s of STOCKS) {
    run('INSERT INTO prices VALUES (?,?,?,?)', g.id, s.id, g.turn + 1, nextPrice(priceOf(g.id, s.id, g.turn)));
  }
  run('UPDATE games SET turn=turn+1, traded=0 WHERE id=?', g.id);
  return view(g.id);
}

/** 마지막 턴 종료: 전량 매도 후 랭킹 저장 */
function finishGame(g) {
  let proceeds = 0;
  for (const h of all('SELECT stock_id, qty FROM holdings WHERE game_id=?', g.id)) {
    proceeds += h.qty * priceOf(g.id, h.stock_id, g.turn);
  }
  const finalMoney = g.cash + proceeds;
  run('UPDATE holdings SET qty=0 WHERE game_id=?', g.id);
  run("UPDATE games SET cash=?, status='finished' WHERE id=?", finalMoney, g.id);
  run('INSERT INTO rankings (game_id, name, final_money) VALUES (?,?,?)', g.id, g.name, finalMoney);
  return { ...view(g.id), finished: true, finalMoney, proceeds };
}

const endTurn = ({ gameId }) => tx(() => {
  const g = getPlayingGame(gameId);
  return g.turn < TOTAL_TURNS ? advanceTurn(g) : finishGame(g);
});

function rankings() {
  return all('SELECT id, game_id, name, final_money, created_at FROM rankings ORDER BY final_money DESC, id ASC')
    .map((r, i) => ({ rank: i + 1, ...r, profit: r.final_money - START_MONEY }));
}

module.exports = { view, startGame, buy, sell, endTurn, rankings };
