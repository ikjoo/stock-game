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
      { action: 'buy', stockId: 1, qty: 999999, reason: '과다' },            // 200주로 축소
      { action: 'buy', stockId: 99, qty: 1, reason: '없는 종목' },           // 제외
      { action: 'hold', stockId: 1, qty: 1, reason: '' },                    // 제외
      { action: 'buy', stockId: 2, qty: 1.5, reason: '소수' },               // 1주 (현금 없음 → 제외)
    ],
  }) + '\n```';
  const r = await post(base, '/api/ai/recommend', { gameId: g.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.actions.length, 1);
  assert.equal(r.body.actions[0].qty, 200);
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
