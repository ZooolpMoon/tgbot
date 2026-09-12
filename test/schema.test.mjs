// ==========================================
// 🗄️ 数据库结构测试
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import { SCHEMA_SQL } from "../src/core/db.js";

const EXPECTED_TABLES = [
  "users", "user_scenes", "chat_history", "daily_stats", "daily_checkin", "points_log",
  "admin_sessions", "shop_items", "shop_orders", "shop_order_log",
  "shop_add_sessions", "shop_edit_sessions", "admin_logs", "broadcast_drafts",
  "redeem_codes", "redeem_logs", "shop_order_drafts"
];

test("SCHEMA_SQL 覆盖全部预期的表", { skip: !hasSqlite && "需要 node:sqlite" }, () => {
  for (const table of EXPECTED_TABLES) {
    assert.match(SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `缺少表 ${table}`);
  }
});

test("建表后所有表都存在", { skip: !hasSqlite && "需要 node:sqlite" }, () => {
  const db = createTestDB();
  const rows = db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  const names = new Set(rows.map((r) => r.name));
  for (const table of EXPECTED_TABLES) {
    assert.ok(names.has(table), `表 ${table} 未创建`);
  }
  db.close();
});

test("users 表带 blocked 字段，redeem_logs 有「每人一次」唯一约束", { skip: !hasSqlite && "需要 node:sqlite" }, () => {
  const db = createTestDB();
  const cols = db.all("SELECT name FROM pragma_table_info('users')").map((r) => r.name);
  assert.ok(cols.includes("blocked"), "users.blocked 缺失");

  db.exec("INSERT INTO redeem_codes (code, points) VALUES ('TGAAAAAAAA', 10)");
  db.exec("INSERT INTO redeem_logs (code_id, code, user_key, points) VALUES (1, 'TGAAAAAAAA', 'user:1', 10)");
  assert.throws(
    () => db.exec("INSERT INTO redeem_logs (code_id, code, user_key, points) VALUES (1, 'TGAAAAAAAA', 'user:1', 10)"),
    /UNIQUE|constraint/i,
    "同一用户重复兑换应被唯一约束拦下"
  );
  db.close();
});

test("ensureSchema 能建表并对老库补齐 blocked 字段", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB({ withSchema: false });
  // 模拟「老库」：users 表没有 blocked 字段
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL UNIQUE,
      user_id TEXT, username TEXT, first_name TEXT,
      points INTEGER DEFAULT 100,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (user_key, user_id, points) VALUES ('user:old', '1', 5);
  `);

  // db.js 内部对 schemaReady 做了模块级缓存，这里用带 query 的导入拿到全新实例
  const { ensureSchema } = await import(`../src/core/db.js?fresh=${Date.now()}`);
  await ensureSchema({ DB: db });

  const cols = db.all("SELECT name FROM pragma_table_info('users')").map((r) => r.name);
  assert.ok(cols.includes("blocked"), "迁移后应补上 blocked 字段");

  const row = db.get("SELECT points, blocked FROM users WHERE user_key = 'user:old'");
  assert.equal(row.points, 5, "迁移不应破坏已有数据");
  assert.equal(Number(row.blocked), 0, "老用户默认未封禁");

  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
  assert.ok(tables.has("redeem_codes"), "迁移应同时建出新表");
  db.close();
});
