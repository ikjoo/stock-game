const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// .env 가 있으면 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env 없음 */ }

module.exports = {
  PORT: Number(process.env.PORT) || 3456,
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'game.db'),
  PUBLIC_DIR: path.join(ROOT, 'public'),

  // AI 추천 (OpenRouter). 키는 서버에서만 사용한다.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',

  START_MONEY: 1_000_000,
  START_PRICE: 5000,
  TOTAL_TURNS: 5,
  MIN_PRICE: 100,
  PRICE_UNIT: 10,
  // 턴마다 종목별 변동률: -20% ~ +25%
  CHANGE_MIN: -0.20,
  CHANGE_MAX: 0.25,

  STOCKS: [
    '삼성전자', '하이닉스', '네이버', '카카오', '현대차',
    '셀트리온', '포스코', 'LG화학', '기아', '크래프톤',
  ].map((name, i) => ({ id: i + 1, name })),
};
