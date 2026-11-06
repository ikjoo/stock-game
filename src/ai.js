// AI 매매 추천 (로컬 서버용): DB에서 게임 상태를 읽어 ai-core에 넘긴다.
const cfg = require('./config');
const game = require('./game');
const { requestRecommendation } = require('./ai-core');

const recommend = ({ gameId }) => requestRecommendation(game.view(Number(gameId)), {
  apiKey: cfg.OPENROUTER_API_KEY, model: cfg.OPENROUTER_MODEL, baseUrl: cfg.OPENROUTER_BASE_URL,
});

module.exports = { recommend };
