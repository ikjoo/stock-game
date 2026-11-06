import { $, api, won, signed, trendClass, escapeHtml } from './util.js';
import { drawChart, hideChart } from './chart.js';

let game = null;      // 서버가 내려준 최신 게임 상태 (view)
let selected = null;  // 선택된 종목 id

// 새로고침해도 진행 중인 게임을 이어서 할 수 있도록 게임 id만 브라우저에 저장한다.
const STORAGE_KEY = 'stockGame.gameId';
const storage = {
  get() { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } },
  set(id) { try { localStorage.setItem(STORAGE_KEY, String(id)); } catch { /* 저장 불가 환경은 무시 */ } },
  clear() { try { localStorage.removeItem(STORAGE_KEY); } catch { /* 무시 */ } },
};

// ---------- 렌더링 ----------

function say(text, isError = false) {
  $('msg').textContent = text;
  $('msg').className = 'msg' + (isError ? ' err' : '');
}

function diffCell(s) {
  if (!s.prev) return '-';
  const d = s.price - s.prev;
  const pct = (d / s.prev * 100).toFixed(1);
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '';
  return `<span class="${trendClass(d)}">${arrow} ${Math.abs(d).toLocaleString()} (${pct}%)</span>`;
}

/**
 * 입력 가능한 수량의 상한을 정한다.
 * 보유 수량이 없어 매도할 수 없으면 현재 현금으로 살 수 있는 최대 수량까지만 입력할 수 있다.
 * 보유 중이면 매수·매도 모두 가능하므로 둘 중 큰 값이 상한이다.
 */
function maxQty(s) {
  const buyable = Math.floor(game.cash / s.price);
  return s.qty > 0 ? Math.max(s.qty, buyable) : buyable;
}

function limitQty(sel) {
  const input = $('qty');
  if (!sel) { input.removeAttribute('max'); input.disabled = false; $('buyBtn').disabled = $('sellBtn').disabled = false; return; }
  const max = maxQty(sel);
  input.disabled = $('buyBtn').disabled = $('sellBtn').disabled = max < 1;
  input.max = String(Math.max(max, 1));
  input.title = max < 1 ? '매수할 현금이 없고 보유 수량도 없습니다' : `최대 ${max}주`;
  if (max < 1) { input.value = ''; return; }
  const n = Number(input.value);
  if (!(n >= 1)) input.value = '1';
  else if (n > max) input.value = String(max);
  $('selLabel').textContent += ` (최대 ${max}주)`;
}

function renderGame() {
  $('sName').textContent = game.name;
  $('sTurn').textContent = `${game.turn} / ${game.totalTurns}`;
  $('sCash').textContent = won(game.cash);
  $('sTotal').textContent = won(game.total);
  $('stockBody').innerHTML = game.stocks.map(s => `
    <tr class="row ${s.id === selected ? 'sel' : ''}" data-id="${s.id}">
      <td>${s.name}</td><td>${won(s.price)}</td><td>${diffCell(s)}</td><td>${s.qty}주</td><td>${won(s.price * s.qty)}</td>
    </tr>`).join('');
  const sel = game.stocks.find(s => s.id === selected);
  $('selLabel').textContent = sel ? `선택: ${sel.name}` : '종목을 선택하세요';
  limitQty(sel);
  $('endBtn').textContent = game.turn === game.totalTurns ? '최종 턴 종료' : '턴 종료';
  drawChart(game, selected);
}

async function loadRankings() {
  const list = await api('GET', '/api/rankings');
  const medal = ['🥇', '🥈', '🥉'];
  $('rankBody').innerHTML = list.length
    ? list.map(r => `
      <tr>
        <td class="medal">${medal[r.rank - 1] || r.rank}</td><td>${escapeHtml(r.name)}</td>
        <td>${won(r.final_money)}</td><td class="${trendClass(r.profit)}">${signed(r.profit)}</td>
        <td>${r.created_at}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">아직 기록이 없습니다</td></tr>';
}

// ---------- AI 추천 ----------

let recommendation = null; // { summary, actions } — 현재 턴에서 받은 추천

function renderAi(note) {
  const box = $('aiBox');
  $('aiApplyBtn').classList.toggle('hidden', !(recommendation && recommendation.actions.length));
  if (note) { box.textContent = note; return; }
  if (!recommendation) { box.textContent = ''; return; }
  const { summary, actions } = recommendation;
  box.innerHTML = `<p>${escapeHtml(summary)}</p>` + (actions.length
    ? `<ul>${actions.map(a => `<li><b class="${a.action === 'buy' ? 'up' : 'down'}">${a.action === 'buy' ? '매수' : '매도'}</b>
        ${escapeHtml(a.stockName)} ${a.qty}주 <small class="muted">(${won(a.price)}/주)</small> — ${escapeHtml(a.reason)}</li>`).join('')}</ul>`
    : '<p class="muted">이번 턴은 거래하지 않는 것을 추천합니다.</p>');
}

function resetAi() {
  recommendation = null;
  renderAi();
}

async function askAi() {
  $('aiBtn').disabled = true;
  recommendation = null;
  renderAi('AI가 분석 중입니다…');
  try {
    recommendation = await api('POST', '/api/ai/recommend', { gameId: game.id });
    renderAi();
  } catch (e) {
    renderAi(e.message);
  } finally {
    $('aiBtn').disabled = false;
  }
}

async function applyAi() {
  if (!recommendation) return;
  $('aiApplyBtn').disabled = true;
  const done = [];
  try {
    for (const a of recommendation.actions) {
      game = await api('POST', '/api/' + a.action, { gameId: game.id, stockId: a.stockId, qty: a.qty });
      done.push(a);
    }
    renderGame();
    say(`AI 추천 ${done.length}건을 실행했습니다.`);
  } catch (e) {
    renderGame();
    say(`추천 실행 중 오류 (${done.length}건 실행됨): ${e.message}`, true);
  } finally {
    $('aiApplyBtn').disabled = false;
    resetAi();
  }
}

function showGameScreen() {
  $('start').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('aiCard').classList.remove('hidden');
  resetAi();
  say('');
  renderGame();
}

/** 저장된 게임이 아직 진행 중이면 복원한다. */
async function restoreGame() {
  const id = storage.get();
  if (!id) return;
  try {
    const saved = await api('GET', `/api/game/${encodeURIComponent(id)}`);
    if (saved.status !== 'playing') return storage.clear();
    game = saved;
    selected = null;
    showGameScreen();
  } catch {
    storage.clear();
  }
}

function showStartScreen() {
  $('game').classList.add('hidden');
  $('aiCard').classList.add('hidden');
  hideChart();
  $('start').classList.remove('hidden');
  $('name').value = '';
  $('startMsg').textContent = '';
}

// ---------- 이벤트 ----------

async function startGame() {
  try {
    game = await api('POST', '/api/start', { name: $('name').value });
    selected = null;
    storage.set(game.id);
    showGameScreen();
  } catch (e) {
    $('startMsg').textContent = e.message;
    $('startMsg').className = 'msg err';
  }
}

async function trade(kind) {
  if (!selected) return say('먼저 종목을 선택하세요.', true);
  try {
    game = await api('POST', '/api/' + kind, { gameId: game.id, stockId: selected, qty: $('qty').value });
    renderGame();
    say(kind === 'buy' ? '매수 완료' : '매도 완료');
  } catch (e) {
    say(e.message, true);
  }
}

async function endTurn() {
  if (!game.traded && !confirm('이번 턴에 매수/매도를 하지 않았습니다.\n정말 턴을 종료하시겠습니까?')) return;
  try {
    game = await api('POST', '/api/end-turn', { gameId: game.id });
    if (game.finished) {
      storage.clear();
      alert(`게임 종료!\n보유 주식을 모두 매도했습니다.\n최종 금액: ${won(game.finalMoney)}\n(손익 ${(game.finalMoney - game.startMoney).toLocaleString()}원)\n랭킹에 저장되었습니다.`);
      showStartScreen();
      await loadRankings();
    } else {
      resetAi(); // 이전 턴 가격 기준 추천은 더 이상 유효하지 않다
      renderGame();
      say(`${game.turn}턴이 시작되었습니다. 시세가 변동되었습니다.`);
    }
  } catch (e) {
    say(e.message, true);
  }
}

$('startBtn').onclick = startGame;
$('buyBtn').onclick = () => trade('buy');
$('sellBtn').onclick = () => trade('sell');
$('endBtn').onclick = endTurn;
$('aiBtn').onclick = askAi;
$('aiApplyBtn').onclick = applyAi;
// 직접 입력하거나 스피너로 올려도 상한을 넘기지 못하게 한다.
$('qty').oninput = () => {
  const sel = game && game.stocks.find(s => s.id === selected);
  if (!sel) return;
  const max = maxQty(sel);
  if (Number($('qty').value) > max) $('qty').value = String(max);
};
$('stockBody').onclick = e => {
  const tr = e.target.closest('tr.row');
  if (!tr) return;
  selected = Number(tr.dataset.id);
  renderGame();
};

loadRankings();
restoreGame();
