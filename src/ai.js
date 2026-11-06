// AI 매매 추천 (로컬 서버용): DB에서 게임 상태를 읽어 ai-core에 넘기고, 턴당 1회 사용을 강제한다.
const cfg = require('./config');
const game = require('./game');
const { run } = require('./db');
const { HttpError } = require('./errors');
const { requestRecommendation } = require('./ai-core');

const pending = new Set(); // 같은 게임·턴에 대한 동시 요청 방지

async function recommend({ gameId }) {
  const v = game.view(Number(gameId)); // 없는 게임은 404
  if (v.aiUsed) throw new HttpError(409, '이번 턴에는 AI 추천을 이미 사용했습니다. 다음 턴에 다시 받을 수 있습니다.');
  const key = `${v.id}:${v.turn}`;
  if (pending.has(key)) throw new HttpError(409, 'AI 추천을 이미 요청 중입니다.');
  pending.add(key);
  try {
    const rec = await requestRecommendation(v, {
      apiKey: cfg.OPENROUTER_API_KEY, model: cfg.OPENROUTER_MODEL, baseUrl: cfg.OPENROUTER_BASE_URL,
    });
    run('INSERT OR IGNORE INTO ai_uses (game_id, turn) VALUES (?, ?)', v.id, v.turn); // 성공했을 때만 사용으로 기록
    return rec;
  } finally {
    pending.delete(key);
  }
}

module.exports = { recommend };
