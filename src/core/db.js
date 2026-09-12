// ==========================================
// 🗄️ 数据库 Schema（首次部署时手动执行）
// ==========================================

export const SCHEMA_SQL = `
-- ==========================================
-- 👤 用户与场景
-- ==========================================

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key      TEXT    NOT NULL UNIQUE,
  user_id       TEXT,
  username      TEXT,
  first_name    TEXT,
  points        INTEGER DEFAULT 100,
  blocked       INTEGER DEFAULT 0,
  updated_at    TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_updated_at ON users(updated_at DESC);

CREATE TABLE IF NOT EXISTS user_scenes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_key      TEXT    NOT NULL UNIQUE,
  user_key       TEXT    NOT NULL,
  chat_id        TEXT,
  chat_type      TEXT,
  user_id        TEXT,
  username       TEXT,
  first_name     TEXT,
  lang           TEXT DEFAULT 'zh',
  custom_prompt  TEXT DEFAULT '',
  max_daily      INTEGER DEFAULT 50,
  rate_limit_sec INTEGER DEFAULT 5,
  last_msg_time  INTEGER DEFAULT 0,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scenes_chat_type ON user_scenes(chat_type);
CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON user_scenes(updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_history (
  scene_key  TEXT PRIMARY KEY,
  messages   TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 📅 每日额度与签到
-- ==========================================

CREATE TABLE IF NOT EXISTS daily_stats (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  scene_key TEXT NOT NULL,
  date_str  TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scene_key, date_str)
);

CREATE TABLE IF NOT EXISTS daily_checkin (
  user_key   TEXT NOT NULL,
  date_str   TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_key, date_str)
);

-- ==========================================
-- 🪙 积分流水
-- ==========================================

CREATE TABLE IF NOT EXISTS points_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_key       TEXT    NOT NULL,
  change_amount  INTEGER NOT NULL,
  balance_after  INTEGER NOT NULL,
  reason         TEXT    NOT NULL,
  created_at     TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_points_log_key ON points_log(user_key, id DESC);

-- ==========================================
-- 👑 管理员会话
-- ==========================================

CREATE TABLE IF NOT EXISTS admin_sessions (
  chat_id     TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

-- ==========================================
-- 🛒 商城
-- ==========================================

-- 商品表
CREATE TABLE IF NOT EXISTS shop_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  description   TEXT    DEFAULT '',
  icon          TEXT    DEFAULT '🎁',
  price         INTEGER NOT NULL,
  stock         INTEGER DEFAULT -1,
  category      TEXT    DEFAULT 'virtual',
  per_user_limit INTEGER DEFAULT 0,        -- 每人限购数量，0 = 不限
  enabled       INTEGER DEFAULT 1,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- 订单表
CREATE TABLE IF NOT EXISTS shop_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT    NOT NULL UNIQUE,
  user_key      TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  chat_id       TEXT    NOT NULL,
  item_id       INTEGER NOT NULL,
  item_name     TEXT    NOT NULL,
  item_icon     TEXT    DEFAULT '🎁',
  price         INTEGER NOT NULL,
  status        TEXT    DEFAULT 'pending',
  remark        TEXT    DEFAULT '',
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON shop_orders(user_key, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON shop_orders(status, id DESC);

-- 订单日志
CREATE TABLE IF NOT EXISTS shop_order_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  note       TEXT    DEFAULT '',
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shop_add_sessions (
  chat_id     TEXT PRIMARY KEY,
  step        INTEGER NOT NULL DEFAULT 1,
  name        TEXT DEFAULT '',
  price       INTEGER DEFAULT 0,
  stock       INTEGER DEFAULT -1,
  category    TEXT DEFAULT 'virtual',
  icon        TEXT DEFAULT '',
  description TEXT DEFAULT '',
  updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 管理员的引导式编辑会话（记录正在编辑的商品与字段）
CREATE TABLE IF NOT EXISTS shop_edit_sessions (
  chat_id    TEXT PRIMARY KEY,
  item_id    INTEGER NOT NULL,
  field      TEXT    NOT NULL,
  updated_at TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 📋 审计与运营
-- ==========================================

-- 管理员操作日志
CREATE TABLE IF NOT EXISTS admin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   TEXT NOT NULL,
  chat_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_id ON admin_logs(id DESC);

-- 群发草稿（等待管理员二次确认）
CREATE TABLE IF NOT EXISTS broadcast_drafts (
  chat_id    TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  cursor_id  INTEGER NOT NULL DEFAULT 0,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 🎟️ 兑换码
-- ==========================================

-- 兑换码（当前只发积分，points 即面额）
CREATE TABLE IF NOT EXISTS redeem_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL UNIQUE,
  points     INTEGER NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,   -- 0 = 不限次数
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT    DEFAULT NULL,         -- 'YYYY-MM-DD'，NULL = 永久
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_by TEXT    DEFAULT '',
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_code ON redeem_codes(code);

-- 兑换记录：UNIQUE 保证「每个码每人只能兑一次」
CREATE TABLE IF NOT EXISTS redeem_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id    INTEGER NOT NULL,
  code       TEXT    NOT NULL,
  user_key   TEXT    NOT NULL,
  points     INTEGER NOT NULL,
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code_id, user_key)
);
CREATE INDEX IF NOT EXISTS idx_redeem_logs_user ON redeem_logs(user_key, id DESC);

-- ==========================================
-- 🧾 下单草稿（填写订单备注用）
-- ==========================================

CREATE TABLE IF NOT EXISTS shop_order_drafts (
  chat_id    TEXT PRIMARY KEY,
  item_id    INTEGER NOT NULL,
  note       TEXT    DEFAULT '',
  pending    INTEGER NOT NULL DEFAULT 0,   -- 1 = 正在等用户回复备注内容
  updated_at TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- ⚙️ 功能开关（scene_key = 'global' 为全局默认）
-- ==========================================

CREATE TABLE IF NOT EXISTS scene_settings (
  scene_key  TEXT NOT NULL,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scene_key, name)
);

-- ==========================================
-- ✅ 每日任务
-- ==========================================

-- 任务定义（管理员可引导式增删改）
CREATE TABLE IF NOT EXISTS daily_task_defs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger    TEXT    NOT NULL DEFAULT 'custom',  -- checkin / chat / game / shop / redeem
  label      TEXT    NOT NULL,
  hint       TEXT    DEFAULT '',
  points     INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- 任务管理的引导式输入状态 / 新建草稿
CREATE TABLE IF NOT EXISTS task_edit_sessions (
  chat_id    TEXT PRIMARY KEY,
  task_id    INTEGER,
  step       TEXT NOT NULL,
  draft      TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_tasks (
  user_key   TEXT    NOT NULL,
  date_str   TEXT    NOT NULL,
  task       TEXT    NOT NULL,   -- "t<def id>" 或 "all_bonus"
  points     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_key, date_str, task)
);
CREATE INDEX IF NOT EXISTS idx_daily_tasks_key ON daily_tasks(user_key, date_str);
`;

let schemaReady = false;
let schemaPromise = null;

/**
 * Schema 版本号：每次新增表 / 字段 / 数据迁移都要 +1。
 * Worker 冷启动时先读这个标记，已是最新就跳过建表与迁移，
 * 避免每次冷启动都跑几十条语句（D1 对单次调用的查询数有限制）。
 */
export const SCHEMA_VERSION = 8;

const SCHEMA_VERSION_KEY = "schema.version";

/**
 * 增量迁移语句。
 * 老库升级时补字段，重复执行会报 "duplicate column name"，
 * 这里逐条执行并忽略错误，保证幂等。
 */
const MIGRATIONS = [
  // 结构迁移
  "ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0",
  "ALTER TABLE shop_items ADD COLUMN per_user_limit INTEGER DEFAULT 0",
  // 数据迁移：v1.3.1 起商城只保留「虚拟物品 / 服务」，不再有实物与发货环节
  "UPDATE shop_items SET category = 'virtual' WHERE category = 'physical'",
  "UPDATE shop_orders SET status = 'done' WHERE status = 'shipped'",

  // v2.1.0：每日任务改为数据库驱动 —— 用一次性标记灌入默认任务
  // （标记存在后不再灌入，管理员删掉的任务不会复活）
  `INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
   SELECT 'checkin', '完成每日签到', '发送 /checkin', 5, 1, 1
   WHERE NOT EXISTS (SELECT 1 FROM scene_settings WHERE scene_key = 'global' AND name = 'task.seeded')`,
  `INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
   SELECT 'chat', '和 AI 聊一次', '直接发消息；群聊里 @ 我', 3, 1, 2
   WHERE NOT EXISTS (SELECT 1 FROM scene_settings WHERE scene_key = 'global' AND name = 'task.seeded')`,
  `INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
   SELECT 'game', '玩一局游戏', '发送 /game 开一局', 3, 1, 3
   WHERE NOT EXISTS (SELECT 1 FROM scene_settings WHERE scene_key = 'global' AND name = 'task.seeded')`,
  `INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
   SELECT 'shop', '在商城兑换一次', '发送 /shop 挑一件商品（仅私聊）', 2, 1, 4
   WHERE NOT EXISTS (SELECT 1 FROM scene_settings WHERE scene_key = 'global' AND name = 'task.seeded')`,
  `INSERT INTO scene_settings (scene_key, name, value)
   SELECT 'global', 'task.seeded', '1'
   WHERE NOT EXISTS (SELECT 1 FROM scene_settings WHERE scene_key = 'global' AND name = 'task.seeded')`,

  // 旧版按任务键记录的完成记录（checkin/chat/...）迁移成按任务 ID 记录（t<id>）
  `UPDATE daily_tasks
     SET task = 't' || (SELECT d.id FROM daily_task_defs d WHERE d.trigger = daily_tasks.task)
   WHERE task IN ('checkin', 'chat', 'game', 'shop', 'redeem')
     AND EXISTS (SELECT 1 FROM daily_task_defs d WHERE d.trigger = daily_tasks.task)`,

  // 注意：v2.2.0 恢复了「场景级功能开关」，所以这里 **不要** 删除非 global 的记录
  // （v2.1.0 曾加过一条 DELETE，已移除；否则场景开关会在每次冷启动被清空）
  `UPDATE scene_settings SET value = 'on' WHERE value NOT IN ('on', 'off') AND name LIKE 'feature.%'`
];

function splitSchemaStatements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/**
 * 幂等初始化表结构。
 * 每个 Worker isolate 只会真正执行一次；
 * 重复部署或冷启动都不会破坏已有数据。
 */
export async function ensureSchema(env) {
  if (!env?.DB) return;
  if (schemaReady) return;

  if (!schemaPromise) {
    schemaPromise = bootstrapSchema(env)
      .then(() => {
        schemaReady = true;
      })
      .catch((err) => {
        schemaPromise = null;
        throw err;
      });
  }

  return schemaPromise;
}

/** 读取已应用的 Schema 版本（表还不存在时视为 0） */
async function readSchemaVersion(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM scene_settings WHERE scene_key = 'global' AND name = ?"
    ).bind(SCHEMA_VERSION_KEY).first();
    const n = Number(row?.value);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0; // 首次部署：连 scene_settings 都还没有
  }
}

async function writeSchemaVersion(env, version) {
  try {
    await env.DB.prepare(`
      INSERT INTO scene_settings (scene_key, name, value, updated_at)
      VALUES ('global', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
    `).bind(SCHEMA_VERSION_KEY, String(version)).run();
  } catch (e) {
    console.warn("[DB] 写入 Schema 版本失败（不影响运行）:", String(e?.message || e));
  }
}

async function bootstrapSchema(env) {
  const applied = await readSchemaVersion(env);
  if (applied >= SCHEMA_VERSION) return;

  await env.DB.batch(
    splitSchemaStatements(SCHEMA_SQL).map((stmt) => env.DB.prepare(stmt))
  );
  await runMigrations(env);
  await writeSchemaVersion(env, SCHEMA_VERSION);
}

async function runMigrations(env) {
  for (const stmt of MIGRATIONS) {
    try {
      await env.DB.prepare(stmt).run();
    } catch (e) {
      // 字段已存在（duplicate column name）等情况直接跳过
      const msg = String(e?.message || e || "");
      if (!/duplicate column|already exists/i.test(msg)) {
        console.warn("[DB] 迁移语句执行失败（已忽略）:", stmt.slice(0, 80), msg);
      }
    }
  }
}
