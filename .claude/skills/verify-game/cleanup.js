// 검증용 게임(이름이 'verify-'로 시작)만 실제 DB에서 삭제한다. 다른 기록은 건드리지 않는다.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', '..', 'game.db');
const db = new DatabaseSync(dbPath);

const games = db.prepare("SELECT id FROM games WHERE name LIKE 'verify-%'").all();
for (const { id } of games) {
  for (const table of ['rankings', 'holdings', 'prices']) {
    db.prepare(`DELETE FROM ${table} WHERE game_id=?`).run(id);
  }
  db.prepare('DELETE FROM games WHERE id=?').run(id);
}

const remaining = db.prepare('SELECT COUNT(*) AS n FROM rankings').get().n;
console.log(`삭제한 검증 게임: ${games.length}개, 남은 랭킹: ${remaining}개`);
