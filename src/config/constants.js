// ==========================================
// ⚙️ 全局常量
// ==========================================

// ==========================================
// 🤖 AI 模型
// ==========================================

// 主模型；可用环境变量 AI_MODELS 覆盖整条回退链
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// 主模型调用失败时，按顺序自动回退到后面的模型（可用环境变量 AI_MODELS 覆盖，逗号分隔）
export const AI_MODELS = [
  AI_MODEL,
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/mistral/mistral-7b-instruct-v0.1"
];
export const AI_MAX_TOKENS = 2048;

// ==========================================
// 🔢 默认值（新建场景 / 没有数据库时使用）
// ==========================================

export const DEFAULTS = {
  LANG: "zh",
  POINTS: 100,
  MAX_DAILY: 50,
  RATE_LIMIT_SEC: 5,
  // 每日额度设为该值表示「不限制」
  UNLIMITED: -1
};

// ==========================================
// 🪙 积分数值 / 奖惩规则
// ==========================================

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

// ==========================================
// 🎁 积分玩法（v3.0.0：转账 + 抽奖）
// ==========================================

export const TRANSFER = {
  // 单笔下限
  MIN: 1,
  // 单笔上限（防止手抖把全部身家打错人）
  MAX: 1000000
};

export const LOTTERY = {
  // 每天免费抽奖次数
  FREE_PER_DAY: 1,
  // 付费抽奖单次消耗
  PAID_COST: 10,
  // 奖池：权重越高越容易中；期望值刻意略低于 PAID_COST（约 9.4），避免刷分
  PRIZES: [
    { points: 1, weight: 30 },
    { points: 2, weight: 25 },
    { points: 3, weight: 18 },
    { points: 5, weight: 12 },
    { points: 8, weight: 8 },
    { points: 12, weight: 4 },
    { points: 20, weight: 2 },
    { points: 50, weight: 1 }
  ]
};

// ==========================================
// 📏 运行规则（时长、历史上下文预算）
// ==========================================

export const RULES = {
  // 群聊里指令类消息的自动删除延迟
  AUTO_DELETE_MS: 5000,
  // 管理员控制台解锁有效期（秒）
  ADMIN_SESSION_SEC: 1800,
  // 落库的历史消息条数上限
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

// ==========================================
// 📚 知识库（RAG）参数
// 检索时把问题与库内分块做余弦相似度；向量存在 D1，因此对容量做了上限。
// ==========================================

export const KB = {
  // 每个分块的最大字符数与相邻分块的重叠字符数
  CHUNK_CHARS: 600,
  CHUNK_OVERLAP: 80,
  // 单篇文档最多切多少块 / 单个作用域（本群或全局）最多多少块
  MAX_CHUNKS_PER_DOC: 400,
  MAX_TOTAL_CHUNKS: 400,
  // 单篇文档正文上限（字符）与上传文件大小上限（字节）
  MAX_DOC_CHARS: 200000,
  MAX_FILE_BYTES: 512 * 1024,
  // 每次检索取回的资料条数、相似度阈值与拼进提示词的最大长度
  TOP_K: 4,
  MIN_SCORE: 0.30,
  // 语义分数达到该值才算「强相关」；低于它时必须有真实关键词重叠才采用，
  // 避免「勉强过线的无关资料」被拼进提示词，导致模型被迫说「资料中未提及」
  STRONG_SCORE: 0.45,
  MIN_SCORE_KEYWORD: 0.12,
  MAX_CONTEXT_CHARS: 2000,
  // 回答模式：hybrid = 资料优先，资料没覆盖就用 AI 自己的知识正常回答；
  //           strict = 只依据资料，资料没有就明说（客服式严格问答）
  ANSWER_MODE: "hybrid",
  // 向量模型（可用环境变量 KB_EMBED_MODEL 覆盖；换模型后需要重建索引）
  EMBED_MODEL: "@cf/baai/bge-m3",
  EMBED_BATCH: 8
};

// ==========================================
// 👑 管理员回调数据（callback_data）
// 前缀统一为 admin_ / shop_ / game_ / rank_ / points_，分发时按前缀路由。
// 注意：新增前缀时不要与已有前缀互为前缀关系，否则会被提前匹配。
// ==========================================

export const ADMIN_CALLBACK = {
  MAIN_MENU: "admin_main_menu",
  STATUS: "admin_status",
  STATS: "admin_stats",
  CLEAR_HISTORY: "admin_clear_history",
  CLOSE: "admin_close",
  USERS_PRIVATE_PREFIX: "admin_users_private_",
  USERS_GROUP_PREFIX: "admin_users_group_",
  // 一级「用户管理」菜单（二级才是私聊 / 群组用户列表）
  USERS_HOME: "admin_users_home",
  // 群组用户 → 群列表 → 群成员
  USER_GROUPS_PREFIX: "admin_groups_",
  GROUP_MEMBERS_PREFIX: "admin_group_m_",
  // 封禁名单
  BANNED_PREFIX: "admin_banned_",
  UNBAN_PREFIX: "admin_unban_",
  GROUP_INFO_PREFIX: "admin_group_info_",

  // ---------- 🛡️ 群规执法确认卡片 ----------
  // 形如 guard_go_12 / guard_no_12 / guard_set_12_mute
  GUARD_PREFIX: "guard_",

  // ---------- 📜 群规执法面板（引导式编辑）----------
  GUARD_HOME: "admin_guard",
  GUARD_EDIT_RULES: "admin_guard_rules",
  GUARD_APPEND_RULES: "admin_guard_append",
  GUARD_CLEAR_RULES: "admin_guard_clearrules",
  GUARD_ACTION_PREFIX: "admin_guard_act_",
  GUARD_MUTE_PREFIX: "admin_guard_mute_",
  GUARD_TOGGLE: "admin_guard_toggle",
  GUARD_HISTORY_PREFIX: "admin_guard_hist_",
  GUARD_ALERT_TOGGLE: "admin_guard_alert",
  GUARD_ALERT_KEYWORDS: "admin_guard_keywords",
  GUARD_VERSIONS_PREFIX: "admin_guard_ver_",
  GUARD_VERSION_RESTORE_PREFIX: "admin_guard_vr_",
  GUARD_REVOKE_PREFIX: "admin_guard_rev_",
  // 申诉卡片（发给管理员私聊）
  APPEAL_OK_PREFIX: "appeal_ok_",
  APPEAL_NO_PREFIX: "appeal_no_",
  MANAGE_USER_PREFIX: "admin_manage_user_",
  MENU_PTS_PREFIX: "admin_menu_pts_",
  MODPTS_PREFIX: "admin_modpts_",
  LOG_PTS_PREFIX: "admin_log_pts_",
  MENU_LIMIT_PREFIX: "admin_menu_limit_",
  MODLIMIT_PREFIX: "admin_modlimit_",
  MENU_RATE_PREFIX: "admin_menu_rate_",
  SETRATE_PREFIX: "admin_setrate_",
  DELUSER_PREFIX: "admin_deluser_confirm_",
  DELUSER_DONE_PREFIX: "admin_deluser_do_",
  BLOCK_PREFIX: "admin_block_",
  CLEARMEM_PREFIX: "admin_clearmem_",
  LOGS_PREFIX: "admin_logs_",
  CODES_PREFIX: "admin_codes_",
  CODE_TOGGLE_PREFIX: "admin_code_toggle_",
  FEATURES_HOME: "admin_feat_home",
  FEATURES_GLOBAL: "admin_feat_g",
  FEATURES_GROUP_PREFIX: "admin_feat_gl_",
  FEATURES_PRIVATE_PREFIX: "admin_feat_pl_",
  FEATURES_SCENE_PREFIX: "admin_feat_s_",
  FEATURES_RESET_PREFIX: "admin_feat_r_",
  FEATURE_TOGGLE_PREFIX: "admin_feat_t_",

  // ---------- 👑 管理员与权限 ----------
  ADMINS_HOME: "admin_admins",
  ADMINS_ADD: "admin_admins_add",
  ADMINS_HELP: "admin_admins_help",
  ADMINS_PAGE_PREFIX: "admin_admins_p_",
  ADMINS_USER_PREFIX: "admin_admins_u_",
  ADMINS_SET_PREFIX: "admin_admins_s_",
  ADMINS_DEL_PREFIX: "admin_admins_d_",
  ADMINS_DELOK_PREFIX: "admin_admins_dok_",
  ADMINS_GUIDE_ROLE_PREFIX: "admin_admins_gr_",

  // ---------- 🗑️ 消息自动删除 ----------
  // 首页 admin_autodel；o_ = 切换范围；k_ = 某一类；s_ = 写入时长
  AUTO_DELETE_HOME: "admin_autodel",
  AUTO_DELETE_SCOPE_PREFIX: "admin_autodel_o_",
  AUTO_DELETE_KIND_PREFIX: "admin_autodel_k_",
  AUTO_DELETE_SET_PREFIX: "admin_autodel_s_",
  // 全局兜底上限（所有消息都按它兜底）
  AUTO_DELETE_CAP: "admin_autodel_cap",
  AUTO_DELETE_CAP_SET_PREFIX: "admin_autodel_cap_s_",

  // ---------- 📚 知识库 ----------
  KB_HOME: "admin_kb",
  KB_ADD: "admin_kb_add",
  KB_TEST: "admin_kb_test",
  KB_LIST_PREFIX: "admin_kb_list_",
  KB_DOC_PREFIX: "admin_kb_doc_",
  KB_TOGGLE_PREFIX: "admin_kb_t_",
  KB_DEL_PREFIX: "admin_kb_d_",
  KB_DELOK_PREFIX: "admin_kb_dok_",
  KB_REINDEX: "admin_kb_reindex",
  KB_PROMOTE_PREFIX: "admin_kb_promote_",
  KB_COPY_PREFIX: "admin_kb_copy_",

  // ---------- 📋 操作日志筛选 ----------
  LOGS_FILTER_PREFIX: "admin_logs_f_",

  BROADCAST_CONFIRM: "admin_broadcast_confirm",
  BROADCAST_CANCEL: "admin_broadcast_cancel",
  BROADCAST_CONTINUE: "admin_broadcast_continue"
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
  STATUS_DONE: "done",
  STATUS_CANCELLED: "cancelled",
  // 已完成订单退款后进入的状态（积分已退、未使用的背包物品已回收）
  STATUS_REFUNDED: "refunded"
};

export const SHOP_CALLBACK = {
  HOME: "shop_home",
  CLOSE: "shop_close",
  VIEW_PREFIX: "shop_view_",
  BUY_PREFIX: "shop_buy_",
  ORDERS_PREFIX: "shop_orders_",
  USER_CANCEL_PREFIX: "shop_ucancel_",
  USER_REFUND_PREFIX: "shop_urefund_",
  SOLD_OUT_PREFIX: "shop_soldout_",
  NO_PTS_PREFIX: "shop_nopts_",
  // 🎒 背包
  BAG_PREFIX: "shop_bag",
  BAG_PAGE_PREFIX: "shop_bag_page_",
  BAG_USE_PREFIX: "shop_bag_use_",

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
  ADMIN_DONE_PREFIX: "shop_admin_done_",
  ADMIN_CANCEL_PREFIX: "shop_admin_cancel_",
  ADMIN_REFUND_PREFIX: "shop_admin_refund_"
};

// 管理员可编辑的商品字段
export const SHOP_EDIT_FIELDS = {
  name: "名称",
  price: "价格",
  stock: "库存",
  limit: "限购",
  category: "分类",
  icon: "图标",
  description: "说明",
  delivery: "发放方式",
  use: "背包用法"
};

export const SHOP_MSG = {
  GROUP_FORBIDDEN: "🛒 商城功能仅支持<b>私聊</b>使用。",
  DB_NOT_BOUND: "❌ 商城未启用（未绑定数据库）。",
  ITEM_NOT_FOUND: "❌ 商品不存在或已下架。",
  SOLD_OUT: "❌ 已售罄",
  NO_POINTS: "❌ 积分不足",
  BUY_SUCCESS: "✅ 兑换成功！"
};
