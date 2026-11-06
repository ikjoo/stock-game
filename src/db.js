const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./config');

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 1,
  cash INTEGER NOT NULL,
  traded INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'playing',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS holdings (
  game_id INTEGER NOT NULL,
  stock_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, stock_id)
);
CREATE TABLE IF NOT EXISTS prices (
  game_id INTEGER NOT NULL,
  stock_id INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  price INTEGER NOT NULL,
  PRIMARY KEY (game_id, stock_id, turn)
);
CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  final_money INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

/** 하나의 트랜잭션으로 실행한다. 예외가 나면 롤백. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { all, get, run, tx };
