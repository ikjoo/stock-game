// 블랙박스 API 테스트: 서버를 임시 DB/포트로 띄워 HTTP로만 검증한다.
// 내부 구조(파일 분리 등)가 바뀌어도 `node --test` 로 동작 보존 여부를 확인할 수 있다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 34567;
const BASE = `http://127.0.0.1:${PORT}`;
let proc, tmp;

async function call(method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
const post = (u, b) => call('POST', u, b);
const start = async (name = '테스터') => (await post('/api/start', { name })).body;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockgame-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'test.db') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rankings'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('서버가 시작되지 않았습니다.');
});

after(() => {
  proc.kill();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 300).unref();
});

test('게임 시작: 10종목, 100만원, 단가 5000원, 1/5턴', async () => {
  const g = await start();
  assert.equal(g.stocks.length, 10);
  assert.equal(g.cash, 1_000_000);
  assert.equal(g.turn, 1);
  assert.equal(g.totalTurns, 5);
  assert.equal(g.status, 'playing');
  assert.equal(g.traded, false);
  assert.equal(g.total, 1_000_000);
  for (const s of g.stocks) {
    assert.equal(s.price, 5000);
    assert.equal(s.qty, 0);
    assert.deepEqual(s.history, [5000]);
  }
});

test('이름이 비어 있으면 시작 거부', async () => {
  const r = await post('/api/start', { name: '   ' });
  assert.equal(r.status, 400);
});

test('매수: 현금 감소, 수량 증가, traded 표시, 총자산 유지', async () => {
  const g = await start();
  const r = await post('/api/buy', { gameId: g.id, stockId: 1, qty: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cash, 1_000_000 - 50_000);
  assert.equal(r.body.stocks[0].qty, 10);
  assert.equal(r.body.traded, true);
  assert.equal(r.body.total, 1_000_000);
});

test('매수: 잔액 부족 / 잘못된 수량 / 없는 종목 거부', async () => {
  const g = await start();
  assert.equal((await post('/api/buy', { gameId: g.id, stockId: 1, qty: 201 })).status, 400); // 1,005,000원
  assert.equal((await post('/api/buy', { gameId: g.id, stockId: 1, qty: 0 })).status, 400);
  assert.equal((await post('/api/buy', { gameId: g.id, stockId: 1, qty: -3 })).status, 400);
  assert.equal((await post('/api/buy', { gameId: g.id, stockId: 1, qty: 1.5 })).status, 400);
  assert.equal((await post('/api/buy', { gameId: g.id, stockId: 99, qty: 1 })).status, 400);
  const after = (await call('GET', `/api/game/${g.id}`)).body;
  assert.equal(after.cash, 1_000_000);
  assert.equal(after.traded, false);
});

test('매도: 현금 증가, 수량 감소, 보유 초과 매도 거부', async () => {
  const g = await start();
  await post('/api/buy', { gameId: g.id, stockId: 2, qty: 20 });
  const r = await post('/api/sell', { gameId: g.id, stockId: 2, qty: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cash, 1_000_000 - 20 * 5000 + 5 * 5000);
  assert.equal(r.body.stocks[1].qty, 15);
  assert.equal((await post('/api/sell', { gameId: g.id, stockId: 2, qty: 16 })).status, 400);
  assert.equal((await post('/api/sell', { gameId: g.id, stockId: 3, qty: 1 })).status, 400);
});

test('존재하지 않는 게임은 404', async () => {
  assert.equal((await call('GET', '/api/game/999999')).status, 404);
  assert.equal((await post('/api/buy', { gameId: 999999, stockId: 1, qty: 1 })).status, 404);
});

test('턴 종료: 턴 증가, traded 초기화, 시세 변동 범위/단위, 기록 누적', async () => {
  const g = await start();
  await post('/api/buy', { gameId: g.id, stockId: 1, qty: 1 });
  const r = (await post('/api/end-turn', { gameId: g.id })).body;
  assert.equal(r.turn, 2);
  assert.equal(r.traded, false);
  assert.equal(r.finished, undefined);
  for (const s of r.stocks) {
    assert.equal(s.prev, 5000);
    assert.deepEqual(s.history, [5000, s.price]);
    assert.ok(s.price >= 100 && s.price % 10 === 0);
    assert.ok(s.price >= 4000 - 10 && s.price <= 6250 + 10, `범위 이탈: ${s.price}`); // -20% ~ +25%
  }
  assert.ok(r.stocks.some(s => s.price !== 5000), '모든 종목이 그대로면 시세 변동이 없는 것');
});

test('시세는 DB에 저장되어 재조회해도 동일', async () => {
  const g = await start();
  const r = (await post('/api/end-turn', { gameId: g.id })).body;
  const again = (await call('GET', `/api/game/${g.id}`)).body;
  assert.deepEqual(again.stocks.map(s => s.price), r.stocks.map(s => s.price));
});

test('5턴 종료: 전량 매도, 상태 finished, 이후 조작 거부', async () => {
  const g = await start('완주자');
  await post('/api/buy', { gameId: g.id, stockId: 1, qty: 100 });
  let r;
  for (let i = 0; i < 4; i++) r = (await post('/api/end-turn', { gameId: g.id })).body;
  assert.equal(r.turn, 5);
  const expected = r.cash + r.stocks.reduce((a, s) => a + s.price * s.qty, 0);
  const fin = (await post('/api/end-turn', { gameId: g.id })).body;
  assert.equal(fin.finished, true);
  assert.equal(fin.status, 'finished');
  assert.equal(fin.finalMoney, expected);
  assert.equal(fin.cash, expected);
  assert.ok(fin.stocks.every(s => s.qty === 0));
  assert.equal(fin.turn, 5);
  for (const [u, b] of [['/api/buy', { stockId: 1, qty: 1 }], ['/api/sell', { stockId: 1, qty: 1 }], ['/api/end-turn', {}]]) {
    assert.equal((await post(u, { gameId: g.id, ...b })).status, 400);
  }
});

test('랭킹: 종료한 게임만 저장되고 최종 금액 내림차순, 중복 등록 없음', async () => {
  const playing = await start('진행중');           // 끝내지 않음
  const mk = async (name, qty) => {
    const g = await start(name);
    if (qty) await post('/api/buy', { gameId: g.id, stockId: 1, qty });
    let r;
    for (let i = 0; i < 5; i++) r = (await post('/api/end-turn', { gameId: g.id })).body;
    return r;
  };
  const a = await mk('랭킹A', 0);        // 현금만 → 정확히 1,000,000
  const b = await mk('랭킹B', 150);
  const list = (await call('GET', '/api/rankings')).body;

  assert.ok(!list.some(x => x.game_id === playing.id), '진행 중 게임은 랭킹에 없어야 함');
  assert.equal(list.filter(x => x.game_id === a.id).length, 1);
  for (let i = 0; i < list.length; i++) {
    assert.equal(list[i].rank, i + 1);
    assert.equal(list[i].profit, list[i].final_money - 1_000_000);
    if (i) assert.ok(list[i - 1].final_money >= list[i].final_money, '내림차순이어야 함');
  }
  const ra = list.find(x => x.game_id === a.id), rb = list.find(x => x.game_id === b.id);
  assert.equal(ra.final_money, 1_000_000);
  assert.equal(ra.name, '랭킹A');
  assert.equal(rb.final_money, b.finalMoney);
});

test('랭킹은 서버 재시작 후에도 유지(DB 영속성)', async () => {
  const before = (await call('GET', '/api/rankings')).body;
  assert.ok(before.length > 0);
  proc.kill();
  await new Promise(r => proc.once('exit', r));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(tmp, 'test.db') }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/rankings'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.deepEqual((await call('GET', '/api/rankings')).body, before);
});

test('정적 파일: 메인 페이지 제공, 경로 탈출 차단', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /가상 주식 투자 게임/);
  const esc = await fetch(BASE + '/..%2fserver.js');
  assert.notEqual(esc.status, 200);
  assert.equal((await fetch(BASE + '/nope.html')).status, 404);
});
