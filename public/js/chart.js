import { $ } from './util.js';

const COLORS = ['#e6194b', '#3cb44b', '#f58231', '#4363d8', '#911eb4', '#0aa5a5', '#c9a800', '#f032e6', '#7a5230', '#6b7488'];
const W = 800, H = 320, L = 60, R = 20, T = 15, B = 30;

/** 종목별 시세 꺾은선 그래프. selected 종목은 강조하고 나머지는 흐리게 그린다. */
export function drawChart(game, selected) {
  const N = game.totalTurns;
  const prices = game.stocks.flatMap(s => s.history);
  let lo = Math.min(...prices, game.startPrice);
  let hi = Math.max(...prices, game.startPrice);
  const pad = Math.max((hi - lo) * 0.1, 200);
  lo = Math.max(0, lo - pad);
  hi += pad;

  const x = t => L + (W - L - R) * (N === 1 ? 0 : t / (N - 1));
  const y = p => T + (H - T - B) * (1 - (p - lo) / (hi - lo));

  let svg = '';
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" stroke="var(--line)"/>` +
      `<text x="${L - 6}" y="${y(p) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(p).toLocaleString()}</text>`;
  }
  for (let t = 0; t < N; t++) {
    svg += `<text x="${x(t)}" y="${H - 8}" text-anchor="middle" font-size="12" fill="var(--muted)">${t + 1}턴</text>`;
  }
  svg += `<line x1="${L}" x2="${W - R}" y1="${y(game.startPrice)}" y2="${y(game.startPrice)}" stroke="var(--muted)" stroke-dasharray="4 4"/>`;

  // 선택된 종목이 맨 위에 그려지도록 정렬
  const ordered = game.stocks.slice().sort((a, b) => (a.id === selected) - (b.id === selected));
  for (const s of ordered) {
    const color = COLORS[s.id - 1];
    const isSel = s.id === selected;
    const opacity = !selected || isSel ? 1 : 0.18;
    const line = s.history.map((p, t) => `${x(t)},${y(p)}`).join(' ');
    const dots = s.history.map((p, t) =>
      `<circle cx="${x(t)}" cy="${y(p)}" r="${isSel ? 5 : 3.5}" fill="${color}"><title>${s.name} ${t + 1}턴: ${p.toLocaleString()}원</title></circle>`).join('');
    svg += `<g opacity="${opacity}"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="${isSel ? 3.5 : 2}"/>${dots}</g>`;
  }
  $('chart').innerHTML = svg;

  $('legend').innerHTML = game.stocks.map(s =>
    `<span style="opacity:${!selected || s.id === selected ? 1 : 0.45}"><span style="color:${COLORS[s.id - 1]}">●</span> ${s.name}</span>`).join('');
  $('chartCard').classList.remove('hidden');
}

export function hideChart() {
  $('chartCard').classList.add('hidden');
}
