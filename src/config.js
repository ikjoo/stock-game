const path = require('node:path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  PORT: Number(process.env.PORT) || 3456,
  DB_PATH: process.env.DB_PATH || path.join(ROOT, 'game.db'),
  PUBLIC_DIR: path.join(ROOT, 'public'),

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
