// AI 추천 API 테스트: OpenRouter 대신 가짜 서버를 띄워 네트워크/실제 키 없이 검증한다.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmp, fake, fakeReply, fakeRequests = [];
const servers = [];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function spawnApp(env) {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(r => probe.close(r));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmp, `ai-${port}.db`), ...env },
    stdio: 'ignore',
  });
  servers.push(proc);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/rankings'); return base; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('서버가 시작되지 않았습니다.');
}

const post = async (base, url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

let base;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockgame-ai-'));
  fake = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      fakeRequests.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      if (typeof fakeReply === 'number') { res.writeHead(fakeReply); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: fakeReply } }] }));
    });
  });
  const fakePort = await listen(fake);
  base = await spawnApp({ OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: `http://127.0.0.1:${fakePort}` });
});

after(() => {
  servers.forEach(p => p.kill());
  fake.close();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 300).unref();
});

const newGame = async () => (await post(base, '/api/start', { name: 'ai' })).body;

test('AI 추천: 키는 서버에서만 사용되고, 상태/가격이 프롬프트에 담긴다', async () => {
  const g = await newGame();
  fakeRequests = [];
  fakeReply = JSON.stringify({ summary: '요약', actions: [{ action: 'buy', stockId: 1, qty: 10, reason: '테스트' }] });
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary, '요약');
  assert.deepEqual(r.body.actions[0], { action: 'buy', stockId: 1, stockName: '삼성전자', qty: 10, price: 5000, reason: '테스트' });
  assert.equal(fakeRequests[0].auth, 'Bearer test-key');
  assert.match(fakeRequests[0].body.messages[1].content, /보유 현금 1000000원/);
  assert.ok(!JSON.stringify(r.body).includes('test-key'));
});

test('AI 추천은 게임 상태를 바꾸지 않는다', async () => {
  const g = await newGame();
  fakeReply = JSON.stringify({ summary: 's', actions: [{ action: 'buy', stockId: 2, qty: 5, reason: '' }] });
  await post(base, '/api/ai/recommend', { gameId: g.id });
  const after = (await (await fetch(`${base}/api/game/${g.id}`)).json());
  assert.equal(after.cash, 1_000_000);
  assert.equal(after.traded, false);
});

test('불가능한 주문은 걸러지고 수량은 가능한 만큼으로 줄어든다', async () => {
  const g = await newGame();
  fakeReply = '```json\n' + JSON.stringify({
    summary: 's',
    actions: [
      { action: 'sell', stockId: 1, qty: 3, reason: '보유 없음' },          // 보유 0 → 제외
      { action: 'buy', stockId: 1, qty: 999999, reason: '과다' },            // 비중 상한(35%)으로 70주로 축소
      { action: 'buy', stockId: 99, qty: 1, reason: '없는 종목' },           // 제외
      { action: 'hold', stockId: 1, qty: 1, reason: '' },                    // 제외
      { action: 'buy', stockId: 2, qty: 1.5, reason: '소수' },               // 내림하여 1주
    ],
  }) + '\n```';
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.actions.length, 2);
  assert.equal(r.body.actions[0].qty, 70); // 비중 상한 35%
  assert.equal(r.body.actions[1].qty, 1);  // 1.5 → 내림
});

test('추천 주문을 그대로 실행하면 서버가 모두 받아들인다 (매도 먼저)', async () => {
  const g = await newGame();
  await post(base, '/api/buy', { gameId: g.id, stockId: 3, qty: 100 });
  fakeReply = JSON.stringify({
    summary: 's',
    actions: [
      { action: 'buy', stockId: 4, qty: 999, reason: '매도 대금으로 매수' },
      { action: 'sell', stockId: 3, qty: 100, reason: '전량 매도' },
    ],
  });
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.body.actions[0].action, 'sell');
  for (const a of r.body.actions) {
    const t = await post(base, '/api/' + a.action, { gameId: g.id, stockId: a.stockId, qty: a.qty });
    assert.equal(t.status, 200, JSON.stringify(t.body));
  }
});

test('AI가 JSON이 아닌 답을 하면 502', async () => {
  const g = await newGame();
  fakeReply = '잘 모르겠어요';
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 502);
});

test('AI 서버가 오류를 내면 502', async () => {
  const g = await newGame();
  fakeReply = 500;
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 502);
});

test('없는 게임은 404, 종료된 게임은 400', async () => {
  fakeReply = JSON.stringify({ summary: '', actions: [] });
  assert.equal((await post(base, '/api/ai/recommend', { gameId: 999999 })).status, 404);
  const g = await newGame();
  for (let i = 0; i < 5; i++) await post(base, '/api/end-turn', { gameId: g.id });
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 400);
});

test('키가 없으면 503', async () => {
  const noKey = await spawnApp({ OPENROUTER_API_KEY: '' });
  const g = (await post(noKey, '/api/start', { name: 'x' })).body;
  const r = await post(noKey, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.status, 503);
});

test('한 종목 집중 매수는 총 자산의 35%로 제한되고, 현금 전후가 계산된다', async () => {
  const g = await newGame();
  fakeReply = JSON.stringify({ summary: 's', actions: [
    { action: 'buy', stockId: 1, qty: 200, reason: '몰빵' },
    { action: 'buy', stockId: 1, qty: 50, reason: '추가(상한 초과)' },
    { action: 'buy', stockId: 2, qty: 40, reason: '분산' },
  ] });
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.deepEqual(r.body.actions.map(a => [a.stockId, a.qty]), [[1, 70], [2, 40]]);
  assert.equal(r.body.cashBefore, 1_000_000);
  assert.equal(r.body.cashAfter, 1_000_000 - 110 * 5000);
});

test('프롬프트: 현재 금액·분산 지침 포함, 종목 순서는 매번 섞인다', async () => {
  const g = await newGame();
  fakeReply = JSON.stringify({ summary: '', actions: [] });
  fakeRequests = [];
  for (let i = 0; i < 6; i++) await post(base, '/api/ai/recommend', { gameId: (await newGame()).id }); // 턴당 1회 제한이 있어 게임마다 한 번씩
  const prompts = fakeRequests.map(q => q.body.messages[1].content);
  assert.match(prompts[0], /총 자산 1000000원/);
  assert.match(prompts[0], /분산/);
  const firstStock = p => p.match(/- (\S+)\(id=/)[1];
  assert.ok(new Set(prompts.map(firstStock)).size > 1, '첫 줄 종목이 항상 같으면 편향 가능');
});

test('AI 추천은 턴당 한 번만: 두 번째는 409, 다음 턴에는 다시 가능', async () => {
  const g = await newGame();
  fakeReply = JSON.stringify({ summary: 's', actions: [] });
  fakeRequests = [];
  assert.equal(g.aiUsed, false);
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 200);
  const again = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /이미 사용/);
  assert.equal(fakeRequests.length, 1, '두 번째 요청은 AI를 호출하지 않는다');
  assert.equal((await (await fetch(`${base}/api/game/${g.id}`)).json()).aiUsed, true);
  const next = (await post(base, '/api/end-turn', { gameId: g.id })).body;
  assert.equal(next.aiUsed, false);
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 200);
});

test('실패한 추천은 사용 횟수를 소모하지 않는다', async () => {
  const g = await newGame();
  fakeReply = 500;
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 502);
  fakeReply = '횡설수설';
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 502);
  fakeReply = JSON.stringify({ summary: 's', actions: [] });
  assert.equal((await post(base, '/api/ai/recommend', { gameId: g.id })).status, 200);
});

test('동시에 두 번 요청해도 AI는 한 번만 호출된다', async () => {
  const g = await newGame();
  fakeReply = JSON.stringify({ summary: 's', actions: [] });
  fakeRequests = [];
  const [a, b] = await Promise.all([post(base, '/api/ai/recommend', { gameId: g.id }), post(base, '/api/ai/recommend', { gameId: g.id })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(fakeRequests.length, 1);
});

test('현금이 없어도 보유 종목을 매도하고 그 대금으로 매수하는 추천이 나온다', async () => {
  const g = await newGame();
  await post(base, '/api/buy', { gameId: g.id, stockId: 1, qty: 200 }); // 현금 0, 삼성전자 200주
  fakeRequests = [];
  fakeReply = JSON.stringify({ summary: '갈아타기', actions: [
    { action: 'buy', stockId: 2, qty: 50, reason: '매도 대금으로 매수' },
    { action: 'sell', stockId: 1, qty: 100, reason: '비중 축소' },
  ] });
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.actions.map(a => [a.action, a.stockId, a.qty]), [['sell', 1, 100], ['buy', 2, 50]]);
  assert.equal(r.body.cashBefore, 0);
  assert.equal(r.body.cashAfter, 500000 - 250000);
  const prompt = fakeRequests[0].body.messages[1].content;
  assert.match(prompt, /어떤 종목도 살 수 없습니다/);
  assert.match(prompt, /매도 대금으로 새로 살 종목/);
});

test('현금도 보유도 없으면 거래 불가 안내를 프롬프트에 담는다', async () => {
  // 1턴에 전량 매수 후 전량 매도하면 보유 0, 현금은 그대로이므로 별도 시나리오: 현금 0 + 보유 0은 만들 수 없어 순수 함수로 확인
  const { buildPrompt } = require('../src/ai-core');
  const v = { turn: 2, totalTurns: 5, cash: 0, status: 'playing',
    stocks: [{ id: 1, name: 'A', price: 5000, prev: 5000, history: [5000, 5000], qty: 0 }] };
  assert.match(buildPrompt(v), /현금도 보유 주식도 없어/);
});
