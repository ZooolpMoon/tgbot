// ==========================================
// 📋 管理员操作日志（审计）
// ==========================================

import { editMessageText, sendMessageWithKeyboard } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";

const PAGE_SIZE = 10;

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
  task_bonus: "🏆 修改全勤奖"
};

export function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

export async function renderAdminLogs(token, env, chatId, messageId, page = 1) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定 D1 数据库。");

  let safePage = Math.max(1, Math.floor(Number(page) || 1));

  const countRes = await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_logs").first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (safePage > totalPages) safePage = totalPages;
  const offset = (safePage - 1) * PAGE_SIZE;

  const { results } = await env.DB.prepare(
    "SELECT id, admin_id, action, detail, created_at FROM admin_logs ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(PAGE_SIZE, offset).all();

  const rows = results || [];

  let text = `📋 <b>管理员操作日志</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `-------------------------\n\n`;

  if (rows.length === 0) {
    text += `<i>暂无操作记录。</i>\n`;
  } else {
    rows.forEach((r) => {
      text += `#${r.id} ${actionLabel(r.action)}\n`;
      if (r.detail) text += `└ ${escapeHtml(r.detail)}\n`;
      text += `🕒 <code>${escapeHtml(r.created_at)}</code> · 👑 <code>${escapeHtml(r.admin_id)}</code>\n\n`;
    });
  }

  const inline_keyboard = [];
  const navRow = [];
  if (safePage > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `admin_logs_${safePage - 1}` });
  if (safePage < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `admin_logs_${safePage + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]);

  const keyboard = { inline_keyboard };

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}
