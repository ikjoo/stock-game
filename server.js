// 가상 주식 투자 게임 서버 진입점 (Node 내장 SQLite 사용, 외부 패키지 불필요)
const { PORT } = require('./src/config');
const { createServer } = require('./src/app');

createServer().listen(PORT, '127.0.0.1', () => console.log(`주식 게임 서버 실행 중: http://localhost:${PORT}`));
