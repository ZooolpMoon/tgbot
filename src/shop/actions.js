// ==========================================
// 🛒 商城管理操作
// ==========================================

import { answerCallback } from "../telegram/api.js";
import { sendMessage } from "../telegram/api.js";
import { refundPoint } from "../services/points.js";
import { escapeHtml } from "../utils/html.js";

// 上架/下架
export async function actionToggleItem(token, env, callback, itemId) {
  const it = await env.DB.prepare("SELECT enabled FROM shop_items WHERE id = ?").bind(itemId).first();
  if (!it) return answerCallback(token, callback.id, "❌ 商品不存在", true);

  const next = it.enabled ? 0 : 1;
  await env.DB.prepare("UPDATE shop_items SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(next, itemId).run();

  await answerCallback(token, callback.id, next ? "✅ 已上架" : "🚫 已下架");
}

// 删除商品
export async function actionDeleteItem(token, env, callback, itemId) {
  await env.DB.prepare("DELETE FROM shop_items WHERE id = ?").bind(itemId).run();
  await answerCallback(token, callback.id, "🗑️ 已删除");
}

// 标记已发货
export async function actionShip(token, env, callback, orderId) {
  const o = await env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (o.status !== "pending") {
    return answerCallback(token, callback.id, `⚠️ 当前状态 ${o.status}，无法发货`, true);
  }

  await env.DB.prepare(
    "UPDATE shop_orders SET status = 'shipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(orderId).run();

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'shipped', 'admin')"
  ).bind(orderId).run();

  // 通知用户
  try {
    await sendMessage(
      token, o.chat_id,
      `🚚 <b>订单已发货</b>\n-------------------------\n` +
      `🧾 订单号：<code>${o.order_no}</code>\n` +
      `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n\n` +
      `如有疑问请联系管理员。`,
      "HTML"
    );
  } catch (_) {}

  await answerCallback(token, callback.id, "✅ 已标记发货");
}

// 标记完成
export async function actionDone(token, env, callback, orderId) {
  const o = await env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  await env.DB.prepare(
    "UPDATE shop_orders SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(orderId).run();

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action) VALUES (?, 'done')"
  ).bind(orderId).run();

  await answerCallback(token, callback.id, "✅ 订单已完成");
}

// 取消并退款
export async function actionCancel(token, env, callback, orderId) {
  const o = await env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (o.status !== "pending") {
    return answerCallback(token, callback.id, `⚠️ 当前状态 ${o.status}，无法取消`, true);
  }

  // 退款
  await refundPoint(env, o.user_key, o.price, `订单 ${o.order_no} 取消退款`);

  // 库存回滚
  const item = await env.DB.prepare("SELECT stock FROM shop_items WHERE id = ?").bind(o.item_id).first();
  if (item && item.stock >= 0) {
    await env.DB.prepare("UPDATE shop_items SET stock = stock + 1 WHERE id = ?").bind(o.item_id).run();
  }

  await env.DB.prepare(
    "UPDATE shop_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(orderId).run();

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'cancelled', 'refunded')"
  ).bind(orderId).run();

  try {
    await sendMessage(
      token, o.chat_id,
      `❌ <b>订单已取消</b>\n-------------------------\n` +
      `🧾 订单号：<code>${o.order_no}</code>\n` +
      `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n` +
      `💰 已退还 <b>${o.price}</b> 积分。`,
      "HTML"
    );
  } catch (_) {}

  await answerCallback(token, callback.id, "✅ 已取消并退款");
}
