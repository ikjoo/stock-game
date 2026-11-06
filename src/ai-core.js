// AI 매매 추천 핵심 로직. DB/설정에 의존하지 않아 로컬 서버(src/ai.js)와 Vercel(api/handler.js)이 함께 쓴다.
const { HttpError } = require('./errors');

const MAX_ACTIONS = 6;
const MAX_WEIGHT = 0.35; // 한 종목이 총 자산에서 차지할 수 있는 최대 비중

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pct = (now, base) => (base ? `${now >= base ? '+' : ''}${((now - base) / base * 100).toFixed(1)}%` : '-');

function buildPrompt(v) {
  const stockValue = v.stocks.reduce((sum, s) => sum + s.price * s.qty, 0);
  // 목록 순서(삼성전자가 항상 첫 줄)가 선택을 편향시키지 않도록 매번 섞는다.
  const rows = shuffled(v.stocks).map(s =>
    `- ${s.name}(id=${s.id}): 현재가 ${s.price}원, 전 턴 대비 ${s.prev ? pct(s.price, s.prev) : '없음'}, ` +
    `시작가 대비 ${pct(s.price, s.history[0])}, 보유 ${s.qty}주(평가 ${s.price * s.qty}원), 시세추이 [${s.history.join(', ')}]`).join('\n');
  const last = v.turn === v.totalTurns;
  const minPrice = Math.min(...v.stocks.map(s => s.price));
  const held = v.stocks.some(s => s.qty > 0);
  let cashNote = '';
  if (v.cash < minPrice) {
    cashNote = held
      ? '현재 현금으로는 어떤 종목도 살 수 없습니다. 그래도 추천을 포기하지 말고, 보유 종목의 현재가와 이전 가격 추이를 분석해 ' +
        '① 팔아야 할 종목(많이 올라 이익 실현할 종목, 하락세가 이어지는 종목, 한 종목 비중이 큰 경우)과 ' +
        '② 그 매도 대금으로 새로 살 종목을 함께 추천하세요. 매도만 추천해도 됩니다.'
      : '현금도 보유 주식도 없어 거래할 수 없습니다. actions는 빈 배열로 두고 summary에 그 이유를 적으세요.';
  }
  return [
    `가상 주식 게임의 ${v.turn}/${v.totalTurns}턴이 시작되었습니다.`,
    `현재 보유 현금 ${v.cash}원, 보유 주식 평가금액 ${stockValue}원, 총 자산 ${v.cash + stockValue}원.`,
    '규칙: 마지막 턴이 끝나면 보유 주식이 전량 현재가로 매도되어 최종 금액으로 순위가 정해집니다.',
    '매 턴 각 종목 가격은 -20%~+25% 범위에서 무작위로 변하며(과거 추세와 무관), 가격은 100원 이상입니다.',
    '현금이 부족하거나 보유 수량보다 많이 매도할 수 없습니다.',
    '',
    rows,
    '',
    cashNote,
    '이번 턴에 할 매도와 매수를 한 번에 계획하세요. 먼저 매도로 현금을 확보하고, 그 현금과 기존 현금으로 매수하는 순서입니다.',
    '지침: 특정 종목에 몰아서 투자하지 말고 서로 다른 3~5개 종목에 분산하세요(한 종목은 총 자산의 35%를 넘길 수 없습니다).',
    '직전 턴 대비 크게 오른 종목은 이익 실현을, 떨어진 종목은 보유 여부와 분산을 고려해 판단하고, 각 주문의 이유에 현재 상황을 근거로 적으세요.',
    last ? '이번이 마지막 턴입니다. 이 턴이 끝나면 현재가로 자동 정산되므로 새로 거래해도 이득이 없습니다. actions는 빈 배열로 두고 summary에 그 이유를 적으세요.' : '',
    '반드시 아래 JSON 형식으로만 답하세요.',
    '{"summary":"현재 금액과 상황을 반영한 한두 문장 요약(한국어)","actions":[{"action":"sell"|"buy","stockId":숫자,"qty":양의정수,"reason":"짧은 이유(한국어)"}]}',
    `주문은 최대 ${MAX_ACTIONS}개이고, 거래하지 않는 편이 낫다면 actions를 빈 배열로 두세요.`,
  ].filter(Boolean).join('\n');
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** AI가 낸 주문을 실제 상태에 맞춰 검증한다. 불가능한 주문은 버리고 수량은 가능한 만큼으로 줄인다. */
function sanitize(v, raw) {
  const cashBefore = v.cash;
  let cash = v.cash;
  const total = v.cash + v.stocks.reduce((sum, s) => sum + s.price * s.qty, 0);
  const held = Object.fromEntries(v.stocks.map(s => [s.id, s.qty]));
  const byId = Object.fromEntries(v.stocks.map(s => [s.id, s]));
  const list = Array.isArray(raw && raw.actions) ? raw.actions : [];
  // 매도를 먼저 실행해야 그 대금으로 매수할 수 있다.
  const ordered = list.slice(0, MAX_ACTIONS * 2).filter(a => a && typeof a === 'object')
    .sort((a, b) => (b.action === 'sell') - (a.action === 'sell'));
  const actions = [];
  for (const a of ordered) {
    const s = byId[Number(a.stockId)];
    let qty = Math.floor(Number(a.qty));
    if (!s || !(qty > 0) || (a.action !== 'buy' && a.action !== 'sell')) continue;
    if (a.action === 'sell') {
      qty = Math.min(qty, held[s.id]);
      if (qty <= 0) continue;
      held[s.id] -= qty;
      cash += qty * s.price;
    } else {
      const room = Math.floor((total * MAX_WEIGHT - held[s.id] * s.price) / s.price); // 비중 상한까지 남은 수량
      qty = Math.min(qty, Math.floor(cash / s.price), room);
      if (qty <= 0) continue;
      held[s.id] += qty;
      cash -= qty * s.price;
    }
    actions.push({
      action: a.action, stockId: s.id, stockName: s.name, qty, price: s.price,
      reason: String(a.reason || '').slice(0, 120),
    });
    if (actions.length >= MAX_ACTIONS) break;
  }
  return { summary: String((raw && raw.summary) || '').slice(0, 300), actions, cashBefore, cashAfter: cash };
}

/** view(게임 상태)를 OpenRouter에 보내 검증된 추천을 돌려준다. opts: { apiKey, model, baseUrl } */
async function requestRecommendation(v, { apiKey, model, baseUrl }) {
  if (!apiKey) throw new HttpError(503, 'AI 추천이 설정되지 않았습니다. 서버에 OPENROUTER_API_KEY가 필요합니다.');
  if (v.status !== 'playing') throw new HttpError(400, '이미 종료된 게임입니다.');

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        messages: [
          { role: 'system', content: '당신은 가상 주식 게임의 투자 조언가입니다. 요청된 JSON만 출력합니다.' },
          { role: 'user', content: buildPrompt(v) },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, 'AI 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  if (!res.ok) throw new HttpError(502, `AI 서버 오류 (${res.status})`);

  let raw;
  try {
    const body = await res.json();
    raw = parseJson(body.choices[0].message.content);
  } catch {
    throw new HttpError(502, 'AI 응답을 해석하지 못했습니다. 다시 시도하세요.');
  }
  return sanitize(v, raw);
}

module.exports = { requestRecommendation, sanitize, buildPrompt };
