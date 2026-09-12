// ==========================================
// 🧪 测试用 D1 替身
// 用 Node 自带的 node:sqlite 在内存里跑真实 SQL，
// 对外暴露与 Cloudflare D1 相同的 prepare/bind/first/run/all/batch 接口。
// Node 22.5+ 才有 node:sqlite；低版本会跳过依赖它的测试。
// ==========================================

import { SCHEMA_SQL, splitSchemaStatements } from "../src/core/db.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export const hasSqlite = Boolean(DatabaseSync);

/**
 * 把 SCHEMA_SQL 里的注释去掉后整段建表。
 * 复用 src/core/db.js 的拆分逻辑，保证测试与生产建表语句完全一致。
 */
function schemaSql() {
  return splitSchemaStatements(SCHEMA_SQL).join(";\n") + ";";
}

/**
 * 建一个内存 D1。
 * @param {object} [opts]
 * @param {boolean} [opts.withSchema=true] 是否自动建表
 */
export function createTestDB({ withSchema = true } = {}) {
  if (!hasSqlite) throw new Error("当前 Node 版本不支持 node:sqlite，无法运行测试");

  const sqlite = new DatabaseSync(":memory:");
  if (withSchema) sqlite.exec(schemaSql());

  const makeStmt = (sql) => {
    let params = [];
    const stmt = {
      bind: (...args) => {
        params = args;
        return stmt;
      },
      first: async () => {
        const row = sqlite.prepare(sql).get(...params);
        return row === undefined ? null : row;
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...params);
        return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      }
    };
    return stmt;
  };

  return {
    prepare: makeStmt,
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),

    // 测试便利方法（不是 D1 接口）
    _sqlite: sqlite,
    exec: (sql) => sqlite.exec(sql),
    get: (sql, ...params) => sqlite.prepare(sql).get(...params) ?? null,
    all: (sql, ...params) => sqlite.prepare(sql).all(...params),
    count: (table, where = "1=1", ...params) =>
      Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params)?.n) || 0,
    close: () => sqlite.close()
  };
}

/** 造一个测试用户 */
export function seedUser(db, userKey = "user:1", points = 100) {
  db.exec(
    `INSERT INTO users (user_key, user_id, username, first_name, points)
     VALUES ('${userKey}', '${userKey.replace(/\D/g, "") || "1"}', 'tester', '测试用户', ${points})`
  );
  return userKey;
}

/** 造一个测试商品 */
export function seedItem(db, { name = "测试商品", price = 10, stock = 5, enabled = 1 } = {}) {
  db.exec(
    `INSERT INTO shop_items (name, description, icon, price, stock, category, enabled)
     VALUES ('${name}', '说明', '🎁', ${price}, ${stock}, 'virtual', ${enabled})`
  );
  return Number(db.get("SELECT id FROM shop_items ORDER BY id DESC LIMIT 1").id);
}
