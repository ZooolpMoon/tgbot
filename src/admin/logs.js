// ==========================================
// 📋 管理员操作日志（审计）
// ==========================================

import { editMessageText, sendMessageWithKeyboard } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";

const PAGE_SIZE = 10;

/** 操作类型 → 中文标签（历史动作也保留，方便查看老日志） */
const ACTION_LABELS = {
  shop_item_add: "➕ 添加商品",
  shop_item_edit: "✏️ 编辑商品",
  shop_item_enable: "✅ 上架商品",
  shop_item_disable: "🚫 下架商品",
  shop_item_delete: "🗑️ 删除商品",
  shop_order_ship: "🚚 订单发货（v1.3.0 及更早的历史记录）",
  shop_order_done: "✅ 订单完成",
  shop_order_cancel: "❌ 订单取消退款",
  user_block: "🚫 封禁用户",
  user_unblock: "✅ 解封用户",
  user_points_mod: "🪙 调整积分",
  scene_limit_mod: "📅 调整限额",
  scene_rate_mod: "⏱️ 调整频率",
  scene_delete: "🗑️ 删除场景",
  scene_clear_memory: "🧹 清除场景记忆",
  group_clear_memory: "🧹 清除整群记忆",
  broadcast_done: "📢 群发完成",
  broadcast_cancel: "🚫 取消群发",
  feature_toggle: "🧩 切换功能开关",
  feature_reset: "🔄 恢复默认开关",
  redeem_code_create: "🎟️ 生成兑换码",
  redeem_code_enable: "✅ 启用兑换码",
  redeem_code_disable: "🚫 停用兑换码",
  task_create: "➕ 新增每日任务",
  task_update: "✏️ 修改每日任务",
  task_delete: "🗑️ 删除每日任务",
  task_enable: "✅ 启用每日任务",
  task_disable: "🚫 停用每日任务",
  task_bonus: "🏆 修改全勤奖",
  kb_doc_add: "📚 新增知识库文档",
  kb_doc_enable: "✅ 启用知识库文档",
  kb_doc_disable: "🚫 停用知识库文档",
  kb_doc_delete: "🗑️ 删除知识库文档",
  guard_request: "🛡️ 发起群规处置（待确认）",
  guard_execute: "🛡️ 执行群规处置",
  guard_cancel: "🚫 取消群规处置",
  guard_unmute: "🔊 解除群内禁言",
  guard_set_rules: "📜 设置群规"
};

/**
 * 操作日志筛选：每个筛选项自带 SQL 条件，翻页时也能正确过滤。
 * key 会出现在 callback_data 里（admin_logs_f_<key>_<page>）。
 */
const FILTERS = {
  all: {
    label: "全部",
    where: "1 = 1",
    params: []
  },
  user: {
    label: "👥 用户",
    where: "(action LIKE 'user_%' OR action LIKE 'scene_%' OR action LIKE 'group_clear%')",
    params: []
  },
  shop: {
    label: "🛒 商城",
    where: "(action LIKE 'shop_%' OR action LIKE 'broadcast_%')",
    params: []
  },
  guard: {
    label: "🛡️ 执法",
    where: "action LIKE 'guard_%'",
    params: []
  },
  kb: {
    label: "📚 知识库",
    where: "action LIKE 'kb_%'",
    params: []
  },
  task: {
    label: "✅ 任务",
    where: "(action LIKE 'task_%' OR action LIKE 'feature_%')",
    params: []
  },
  system: {
    label: "⚙️ 系统",
    where: `NOT (action LIKE 'user_%' OR action LIKE 'scene_%' OR action LIKE 'group_clear%'
      OR action LIKE 'shop_%' OR action LIKE 'broadcast_%' OR action LIKE 'guard_%'
      OR action LIKE 'kb_%' OR action LIKE 'task_%' OR action LIKE 'feature_%')`,
    params: []
  }
};

/** 规范化筛选键（未知一律当 all） */
export function normalizeLogFilter(key) {
  const k = String(key || "all").toLowerCase();
  return FILTERS[k] ? k : "all";
}

/** 日志筛选键盘（纯函数，便于排版测试） */
export function getLogFilterKeyboard(current, safePage, totalPages) {
  const keys = Object.keys(FILTERS);
  const buttons = keys.map((key) => ({
    text: `${key === current ? "✅ " : ""}${FILTERS[key].label}`,
    callback_data: `${ADMIN_CALLBACK.LOGS_FILTER_PREFIX}${key}_1`
  }));

  const inline_keyboard = grid(buttons);
  const navRow = pagerRow({ page: safePage, totalPages, prefix: `${ADMIN_CALLBACK.LOGS_FILTER_PREFIX}${current}_` });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]);
  return { inline_keyboard };
}

/** 把数据库里的动作键翻译成中文（未知动作原样显示，方便排查新功能） */
export function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

/**
 * 管理员操作日志（倒序分页，最新在前）。
 * @param {string} filter all / user / shop / guard / kb / task / system
 */
export async function renderAdminLogs(token, env, chatId, messageId, page = 1, filter = "all") {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定 D1 数据库。");

  const key = normalizeLogFilter(filter);
  const { where, params } = FILTERS[key];

  const countRes = await env.DB.prepare(`SELECT COUNT(*) AS total FROM admin_logs WHERE ${where}`)
    .bind(...params).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, PAGE_SIZE);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    `SELECT id, admin_id, action, detail, created_at FROM admin_logs
     WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...params, PAGE_SIZE, pageOffset(safePage, PAGE_SIZE)).all();

  const rows = results || [];

  let text = `📋 <b>管理员操作日志</b>\n`;
  text += `🔍 筛选：<b>${FILTERS[key].label}</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `${LAYOUT.DIVIDER}\n\n`;

  if (rows.length === 0) {
    text += `<i>暂无操作记录。</i>\n`;
  } else {
    rows.forEach((r) => {
      text += `#${r.id} ${actionLabel(r.action)}\n`;
      if (r.detail) text += `└ ${escapeHtml(r.detail)}\n`;
      text += `🕒 <code>${escapeHtml(r.created_at)}</code> · 👑 <code>${escapeHtml(r.admin_id)}</code>\n\n`;
    });
  }

  const keyboard = getLogFilterKeyboard(key, safePage, totalPages);

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}
