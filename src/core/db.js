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
-- 📚 知识库（RAG）
-- scope_key = 'global' 为全局知识，其余按场景隔离（例如 group:<群ID>:user:<管理员ID>）
-- ==========================================

-- 文档：一次上传对应一条记录，正文会切成多个 chunk
CREATE TABLE IF NOT EXISTS kb_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key   TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  source      TEXT    DEFAULT '',
  content     TEXT    NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT    DEFAULT '',
  created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kb_docs_scope ON kb_docs(scope_key, id DESC);

-- 文档分块：embedding 存 base64(Float32Array)，检索时在 Worker 内做余弦相似度
CREATE TABLE IF NOT EXISTS kb_chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id    INTEGER NOT NULL,
  scope_key TEXT    NOT NULL,
  seq       INTEGER NOT NULL DEFAULT 0,
  content   TEXT    NOT NULL,
  dim       INTEGER NOT NULL DEFAULT 0,
  embedding TEXT    NOT NULL DEFAULT '',
  model     TEXT    DEFAULT '',                          -- 生成向量的模型名（换模型后据此重建索引）
  created_at TEXT   DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_scope ON kb_chunks(scope_key, id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id, seq);

-- 知识库引导式操作状态（添加文档 / 检索测试），30 分钟过期
CREATE TABLE IF NOT EXISTS kb_sessions (
  chat_id    TEXT PRIMARY KEY,
  step       TEXT NOT NULL,
  draft      TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 🛡️ 群规执法
-- 管理员在群里 @ 机器人说「封禁 @某人 原因」时，先按群规校验理由，再执行处置
-- ==========================================

-- 每个群一份执法配置：群规正文、默认处置方式、默认禁言时长
CREATE TABLE IF NOT EXISTS group_guard (
  chat_id              TEXT PRIMARY KEY,
  rules                TEXT    DEFAULT '',
  default_action       TEXT    NOT NULL DEFAULT 'bot',   -- bot / kick / group_ban / mute
  default_mute_minutes INTEGER NOT NULL DEFAULT 60,
  enabled              INTEGER NOT NULL DEFAULT 1,
  alert_enabled        INTEGER NOT NULL DEFAULT 1,       -- 主动预警开关
  alert_keywords       TEXT    DEFAULT '',               -- 自定义预警关键词（空 = 用内置默认）
  updated_at           TEXT    DEFAULT CURRENT_TIMESTAMP
);

-- 处置记录：既做审计，也承载「待确认」的中间状态
CREATE TABLE IF NOT EXISTS group_punishments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  user_label   TEXT    DEFAULT '',
  action       TEXT    NOT NULL,                          -- bot_ban / kick / group_ban / mute / unban / unmute
  reason       TEXT    DEFAULT '',
  matched_rule TEXT    DEFAULT '',
  duration_min INTEGER NOT NULL DEFAULT 0,
  until_at     INTEGER NOT NULL DEFAULT 0,                 -- Unix 秒；0 = 永久或不需要
  operator_id  TEXT    DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'pending',         -- pending / done / cancelled / rejected / failed
  detail       TEXT    DEFAULT '',
  created_at   TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_guard_pending ON group_punishments(chat_id, status, id DESC);
CREATE INDEX IF NOT EXISTS idx_guard_user ON group_punishments(user_id, status, id DESC);

-- 群规引导式编辑的中间状态（正在改群规正文 / 等管理员输入），30 分钟过期
CREATE TABLE IF NOT EXISTS guard_sessions (
  chat_id    TEXT PRIMARY KEY,
  step       TEXT NOT NULL,
  draft      TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 处置申诉：被处置人可以私聊机器人申诉，管理员在私聊里批准（撤销处置）或驳回
CREATE TABLE IF NOT EXISTS punishment_appeals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  punishment_id INTEGER NOT NULL,
  chat_id       TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  user_label    TEXT    DEFAULT '',
  reason        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',   -- pending / approved / rejected
  decided_by    TEXT    DEFAULT '',
  decided_at    TEXT,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON punishment_appeals(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_appeals_user ON punishment_appeals(user_id, id DESC);

-- 群规版本历史（每次改动留一条，可回滚）
CREATE TABLE IF NOT EXISTS group_rule_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  rules      TEXT    NOT NULL,
  changed_by TEXT    DEFAULT '',
  note       TEXT    DEFAULT '',
  created_at TEXT    DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rule_versions ON group_rule_versions(chat_id, version DESC);
`;

let schemaReady = false;
let schemaPromise = null;

/**
 * Schema 版本号：每次新增表 / 字段 / 数据迁移都要 +1。
 * Worker 冷启动时先读这个标记，已是最新就跳过建表与迁移，
 * 避免每次冷启动都跑几十条语句（D1 对单次调用的查询数有限制）。
 */
// v2.9.0 移除「每日任务」后不再建 daily_task_defs / task_edit_sessions / daily_tasks
// （老库里这三张表会保留但不再使用，需要清理可手动 DROP）
export const SCHEMA_VERSION = 13;

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
  // v2.6.0：群规执法的主动预警开关与关键词
  "ALTER TABLE group_guard ADD COLUMN alert_enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE group_guard ADD COLUMN alert_keywords TEXT DEFAULT ''",
  // v2.6.0：记录每条分块用了哪个向量模型，便于换模型后精准重建
  "ALTER TABLE kb_chunks ADD COLUMN model TEXT DEFAULT ''",
  // 数据迁移：v1.3.1 起商城只保留「虚拟物品 / 服务」，不再有实物与发货环节
  "UPDATE shop_items SET category = 'virtual' WHERE category = 'physical'",
  "UPDATE shop_orders SET status = 'done' WHERE status = 'shipped'",

  // 注意：v2.2.0 恢复了「场景级功能开关」，所以这里 **不要** 删除非 global 的记录
  // （v2.1.0 曾加过一条 DELETE，已移除；否则场景开关会在每次冷启动被清空）
  `UPDATE scene_settings SET value = 'on' WHERE value NOT IN ('on', 'off') AND name LIKE 'feature.%'`
  ,
  // v2.9.0：每日任务下线，清掉遗留的全局设置（如 task.seeded / task.all_bonus）；
  // 三张 daily_task* 表老库里保留但不再读写，需要彻底清干净可手动 DROP
  `DELETE FROM scene_settings WHERE scene_key = 'global' AND name LIKE 'task.%'`
];

/**
 * 把整段建表 SQL 拆成可逐条执行的语句。
 * 先按行去掉 `--` 注释（含行尾注释），再按分号切分，
 * 避免注释里出现的分号把语句切坏。测试用的 D1 替身也复用这个函数。
 */
export function splitSchemaStatements(sql) {
  return String(sql || "")
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("--");
      return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trimEnd();
    })
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

/** 把 Schema 版本号写回 scene_settings（失败只告警，不影响运行） */
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

/**
 * 冷启动引导：版本落后时才建表 + 跑迁移，最后写回版本号。
 * 版本已经是最新时只花费一次查询。
 */
async function bootstrapSchema(env) {
  const applied = await readSchemaVersion(env);
  if (applied >= SCHEMA_VERSION) return;

  await env.DB.batch(
    splitSchemaStatements(SCHEMA_SQL).map((stmt) => env.DB.prepare(stmt))
  );
  await runMigrations(env);
  await writeSchemaVersion(env, SCHEMA_VERSION);
}

/**
 * 逐条执行增量迁移。
 * 迁移都必须幂等：重复执行报「字段已存在」之类的错误直接忽略。
 */
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
