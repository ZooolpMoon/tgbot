// ==========================================
// ⚙️ 全局常量
// ==========================================

export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// 主模型调用失败时，按顺序自动回退到后面的模型（可用环境变量 AI_MODELS 覆盖，逗号分隔）
export const AI_MODELS = [
  AI_MODEL,
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/mistral/mistral-7b-instruct-v0.1"
];
export const AI_MAX_TOKENS = 2048;

export const DEFAULTS = {
  LANG: "zh",
  POINTS: 100,
  MAX_DAILY: 50,
  RATE_LIMIT_SEC: 5,
  UNLIMITED: -1
};

export const POINTS = {
  AI_COST: 1,
  // 连续签到第 1 天的基础奖励（兼容旧版文案）
  CHECKIN_REWARD: 5,
  // 连续签到递增奖励：min(BASE + (连续天数-1) * STEP, MAX)
  CHECKIN_BASE: 5,
  CHECKIN_STEP: 1,
  CHECKIN_MAX: 20,
  // 每连续满 N 天，额外奖励一次
  CHECKIN_MILESTONE_DAYS: 7,
  CHECKIN_MILESTONE_BONUS: 20
};

export const RULES = {
  AUTO_DELETE_MS: 5000,
  ADMIN_SESSION_SEC: 1800,
  HISTORY_LIMIT: 10,
  // AI 上下文总量上限（字符数），超出时从最旧的消息开始丢弃
  HISTORY_MAX_CHARS: 6000,
  // 单条消息写入历史前的截断长度
  HISTORY_MESSAGE_MAX_CHARS: 2000
};

// ==========================================
// 📢 群发 / 分页
// ==========================================

export const BROADCAST = {
  // 每批发送间隔（毫秒），避免触发 Telegram 限流
  INTERVAL_MS: 60,
  // 每批处理的用户数
  BATCH_SIZE: 50,
  // 单次执行的时间预算（毫秒），超出则保存进度等待「继续发送」
  TIME_BUDGET_MS: 20000,
  // 单次群发最多覆盖的用户数（防止超时）
  MAX_RECIPIENTS: 10000,
  // 群发正文最大长度
  MAX_CHARS: 3500
};

export const PAGING = {
  POINTS_PER_PAGE: 10,
  RANK_TOP: 10
};

export const ADMIN_CALLBACK = {
  MAIN_MENU: "admin_main_menu",
  STATUS: "admin_status",
  STATS: "admin_stats",
  CLEAR_HISTORY: "admin_clear_history",
  CLOSE: "admin_close",
  USERS_PRIVATE_PREFIX: "admin_users_private_",
  USERS_GROUP_PREFIX: "admin_users_group_",
  GROUP_INFO_PREFIX: "admin_group_info_",
  MANAGE_USER_PREFIX: "admin_manage_user_",
  MENU_PTS_PREFIX: "admin_menu_pts_",
  MODPTS_PREFIX: "admin_modpts_",
  LOG_PTS_PREFIX: "admin_log_pts_",
  MENU_LIMIT_PREFIX: "admin_menu_limit_",
  MODLIMIT_PREFIX: "admin_modlimit_",
  MENU_RATE_PREFIX: "admin_menu_rate_",
  SETRATE_PREFIX: "admin_setrate_",
  DELUSER_PREFIX: "admin_deluser_confirm_",
  BLOCK_PREFIX: "admin_block_",
  CLEARMEM_PREFIX: "admin_clearmem_",
  LOGS_PREFIX: "admin_logs_",
  BROADCAST_CONFIRM: "admin_broadcast_confirm",
  BROADCAST_CANCEL: "admin_broadcast_cancel"
};

// ==========================================
// 🛒 商城相关常量
// ==========================================

export const SHOP = {
  // 每页显示商品数
  ITEMS_PER_PAGE: 8,
  // 每页显示订单数
  ORDERS_PER_PAGE: 5,
  // 订单号前缀
  ORDER_PREFIX: "S",
  // 状态
  STATUS_PENDING: "pending",
  STATUS_SHIPPED: "shipped",
  STATUS_DONE: "done",
  STATUS_CANCELLED: "cancelled"
};

export const SHOP_CALLBACK = {
  HOME: "shop_home",
  CLOSE: "shop_close",
  VIEW_PREFIX: "shop_view_",
  BUY_PREFIX: "shop_buy_",
  ORDERS_PREFIX: "shop_orders_",
  USER_CANCEL_PREFIX: "shop_ucancel_",
  SOLD_OUT_PREFIX: "shop_soldout_",
  NO_PTS_PREFIX: "shop_nopts_",

  ADMIN_HOME: "shop_admin_home",
  ADMIN_ITEMS_PREFIX: "shop_admin_items_",
  ADMIN_ITEM_PREFIX: "shop_admin_item_",
  ADMIN_EDIT_PREFIX: "shop_admin_edit_",
  ADMIN_EDIT_FIELD_PREFIX: "shop_admin_editf_",
  ADMIN_TOGGLE_PREFIX: "shop_admin_toggle_",
  ADMIN_DEL_PREFIX: "shop_admin_del_",
  ADMIN_ORDERS_PENDING_PREFIX: "shop_admin_orders_pending_",
  ADMIN_ORDERS_ALL_PREFIX: "shop_admin_orders_all_",
  ADMIN_ORDER_PREFIX: "shop_admin_order_",
  ADMIN_SHIP_PREFIX: "shop_admin_ship_",
  ADMIN_DONE_PREFIX: "shop_admin_done_",
  ADMIN_CANCEL_PREFIX: "shop_admin_cancel_"
};

// 管理员可编辑的商品字段
export const SHOP_EDIT_FIELDS = {
  name: "名称",
  price: "价格",
  stock: "库存",
  category: "分类",
  icon: "图标",
  description: "说明"
};

export const SHOP_MSG = {
  GROUP_FORBIDDEN: "🛒 商城功能仅支持<b>私聊</b>使用。",
  DB_NOT_BOUND: "❌ 商城未启用（未绑定数据库）。",
  ITEM_NOT_FOUND: "❌ 商品不存在或已下架。",
  SOLD_OUT: "❌ 已售罄",
  NO_POINTS: "❌ 积分不足",
  BUY_SUCCESS: "✅ 兑换成功！"
};
