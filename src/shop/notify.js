// ==========================================
// 🔔 商城通知
// ==========================================

import { sendMessage, sendMessageWithKeyboard } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { logError } from "../core/logger.js";

/**
 * 解析管理员通知 chatId
 * 优先 ADMIN_NOTIFY_CHAT_ID，否则用 MY_TELEGRAM_ID
 */
export function resolveAdminChatId(env) {
  if (env.ADMIN_NOTIFY_CHAT_ID) return String(env.ADMIN_NOTIFY_CHAT_ID).trim();
  if (env.MY_TELEGRAM_ID) return String(env.MY_TELEGRAM_ID).trim();
  return null;
}

/**
 * 下单成功 → 通知管理员
 */
export async function notifyAdminNewOrder(token, env, order, item, userInfo) {
  const adminChat = resolveAdminChatId(env);
  if (!adminChat) {
    logError("notifyAdminNewOrder: 未配置管理员通知 chatId");
    return;
  }

  const text =
    `🔔 <b>新订单待处理</b>\n` +
    `-------------------------\n` +
    `🧾 订单号：<code>${order.order_no}</code>\n` +
    `${item.icon} 商品：<b>${escapeHtml(item.name)}</b>\n` +
    `💰 消耗积分：${order.price}\n` +
    (order.remark ? `🧾 备注：${escapeHtml(order.remark)}\n` : ``) +
    `\n` +
    `👤 用户：<b>${escapeHtml(userInfo.firstName || "未命名")}</b>\n` +
    `🆔 用户 ID：<code>${userInfo.userId}</code>\n` +
    `💬 下单会话：<code>${order.chat_id}</code>\n` +
    `🕒 时间：${order.created_at || new Date().toISOString()}\n\n` +
    `点击下方按钮处理：`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "⏳ 待处理订单", callback_data: "shop_admin_orders_pending_1" }],
      [{ text: "📦 打开商城管理", callback_data: "shop_admin_home" }]
    ]
  };

  try {
    await sendMessageWithKeyboard(token, adminChat, text, keyboard, "HTML");
  } catch (e) {
    logError("通知管理员失败:", e);
  }
}
