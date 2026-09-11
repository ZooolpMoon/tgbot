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
`;