// ==========================================
// /orders 我的订单
// ==========================================

import { renderMyOrders } from "../../shop/index.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";

export async function cmdOrders({ env, token, chatId, userKey, isGroupCtx, ctx }) {
  if (isGroupCtx) {
    await sendAutoDelete(
      token, chatId,
      "🛒 订单功能仅支持<b>私聊</b>使用。",
      "HTML", isGroupCtx, ctx
    );
    return;
  }
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 商城未启用", null, isGroupCtx, ctx);
    return;
  }

  // 由于 renderMyOrders 是编辑已有消息，这里改用「新发一条」
  const { sendMessageWithKeyboard } = await import("../../telegram/api.js");
  const pageSize = 5;
  const offset = 0;

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM shop_orders WHERE user_key = ?"
  ).bind(userKey).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const { results } = await env.DB.prepare(
    "SELECT id, order_no, item_name, item_icon, price, status, created_at FROM shop_orders WHERE user_key = ? ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(userKey, pageSize, offset).all();

  const statusMap = {
    pending: "⏳ 待处理",
    shipped: "🚚 已发货",
    done: "✅ 已完成",
    cancelled: "❌ 已取消"
  };

  let text = `📜 <b>我的订单</b>\n`;
  text += `页码：<b>1 / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `-------------------------\n\n`;

  if (!results || results.length === 0) {
    text += `<i>还没有兑换记录，输入 /shop 去商城看看～</i>\n`;
  } else {
    results.forEach((o) => {
      text += `${o.item_icon} <b>${o.item_name}</b>\n`;
      text += `🧾 <code>${o.order_no}</code> · 🪙 ${o.price}\n`;
      text += `📌 状态：${statusMap[o.status] || o.status}\n`;
      text += `🕒 ${o.created_at}\n\n`;
    });
  }

  const inline_keyboard = [];
  if (totalPages > 1) {
    inline_keyboard.push([{ text: "下一页 ➡️", callback_data: `shop_orders_2` }]);
  }
  inline_keyboard.push([{ text: "🔙 返回商城", callback_data: "shop_home" }]);

  await sendMessageWithKeyboard(token, chatId, text, { inline_keyboard }, "HTML");
}