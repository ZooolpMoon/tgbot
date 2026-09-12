// ==========================================
// 🛒 商城管理（管理员）
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";

// ---------- 管理首页 ----------
export async function renderShopAdmin(token, env, chatId, messageId = null) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const itemCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_items").first();
  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'pending'"
  ).first();

  const text =
    `🛒 <b>商城管理</b>\n` +
    `-------------------------\n` +
    `📦 商品总数：<b>${Number(itemCount?.n) || 0}</b>\n` +
    `⏳ 待处理订单：<b>${Number(pendingCount?.n) || 0}</b>\n\n` +
    `请选择操作：`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "➕ 添加商品", callback_data: "shop_admin_add" }],
      [{ text: "📦 商品列表", callback_data: "shop_admin_items_1" }],
      [{ text: "⏳ 待处理订单", callback_data: "shop_admin_orders_pending_1" }],
      [{ text: "📜 全部订单", callback_data: "shop_admin_orders_all_1" }],
      [{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]
    ]
  };

  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ---------- 商品列表 ----------
export async function renderShopAdminItems(token, env, chatId, messageId, page = 1) {
  if (!env.DB) return;

  const pageSize = 8;
  const offset = (page - 1) * pageSize;

  const countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_items").first();
  const total = Number(countRes?.n) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const { results } = await env.DB.prepare(
    "SELECT id, name, icon, price, stock, enabled FROM shop_items ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(pageSize, offset).all();

  let text = `📦 <b>商品列表</b>\n`;
  text += `页码：<b>${page} / ${totalPages}</b>（共 ${total} 件）\n`;
  text += `-------------------------\n\n`;

  const inline_keyboard = [];

  if (!results || results.length === 0) {
    text += `<i>还没有商品。</i>\n`;
  } else {
    results.forEach((it) => {
      const stockText = it.stock === -1 ? "∞" : it.stock;
      const state = it.enabled ? "✅" : "🚫";
      text += `${state} ${it.icon} <b>${escapeHtml(it.name)}</b> · 🪙${it.price} · 库存 ${stockText}\n`;
      inline_keyboard.push([
        { text: `${state} ${it.icon} ${it.name} · 🪙${it.price}`, callback_data: `shop_admin_item_${it.id}` }
      ]);
    });
  }

  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `shop_admin_items_${page - 1}` });
  if (page < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `shop_admin_items_${page + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "🔙 返回商城管理", callback_data: "shop_admin_home" }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 商品详情 ----------
export async function renderShopAdminItem(token, env, chatId, messageId, itemId) {
  if (!env.DB) return;

  const item = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  if (!item) {
    return editMessageText(token, chatId, messageId, "❌ 商品不存在",
      { inline_keyboard: [[{ text: "🔙 返回商品列表", callback_data: "shop_admin_items_1" }]] });
  }

  const catText = { virtual: "虚拟", physical: "实物", service: "服务" }[item.category] || item.category;
  const stockText = item.stock === -1 ? "无限" : item.stock;

  const text =
    `${item.icon} <b>${escapeHtml(item.name)}</b>\n` +
    `-------------------------\n` +
    `🆔 ID：<code>${item.id}</code>\n` +
    `💰 价格：🪙 ${item.price}\n` +
    `📦 库存：${stockText}\n` +
    `📂 分类：${catText}\n` +
    `🔘 状态：${item.enabled ? "✅ 已上架" : "🚫 已下架"}\n\n` +
    `📝 <b>说明：</b>\n${escapeHtml(item.description) || "（无）"}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✏️ 编辑名称/价格/库存/说明", callback_data: `shop_admin_edit_${item.id}` }],
      [
        { text: item.enabled ? "🚫 下架" : "✅ 上架", callback_data: `shop_admin_toggle_${item.id}` },
        { text: "🗑️ 删除", callback_data: `shop_admin_del_${item.id}` }
      ],
      [{ text: "🔙 返回商品列表", callback_data: "shop_admin_items_1" }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ---------- 订单列表 ----------
export async function renderShopAdminOrders(token, env, chatId, messageId, filter = "pending", page = 1) {
  if (!env.DB) return;

  const pageSize = 5;
  const offset = (page - 1) * pageSize;
  const where = filter === "all" ? "" : "WHERE status = 'pending'";

  const countRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shop_orders ${where}`).first();
  const total = Number(countRes?.n) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  const { results } = await env.DB.prepare(
    `SELECT id, order_no, user_id, item_name, item_icon, price, status, created_at FROM shop_orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(pageSize, offset).all();

  const statusMap = { pending: "⏳", shipped: "🚚", done: "✅", cancelled: "❌" };

  let text = `📜 <b>${filter === "all" ? "全部订单" : "待处理订单"}</b>\n`;
  text += `页码：<b>${page} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `-------------------------\n\n`;

  const inline_keyboard = [];

  if (!results || results.length === 0) {
    text += `<i>没有订单。</i>\n`;
  } else {
    results.forEach((o) => {
      text += `${o.item_icon} <b>${escapeHtml(o.item_name)}</b> · 🪙${o.price}\n`;
      text += `🧾 <code>${o.order_no}</code> · 👤 <code>${o.user_id}</code>\n`;
      text += `📌 ${statusMap[o.status] || o.status} · 🕒 ${o.created_at}\n\n`;
      inline_keyboard.push([
        { text: `${statusMap[o.status]} ${o.order_no}`, callback_data: `shop_admin_order_${o.id}` }
      ]);
    });
  }

  const navRow = [];
  const prefix = filter === "all" ? "shop_admin_orders_all_" : "shop_admin_orders_pending_";
  if (page > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `${prefix}${page - 1}` });
  if (page < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `${prefix}${page + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "🔙 返回商城管理", callback_data: "shop_admin_home" }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 订单详情 ----------
export async function renderShopAdminOrder(token, env, chatId, messageId, orderId) {
  if (!env.DB) return;

  const o = await env.DB.prepare(
    "SELECT id, order_no, user_key, user_id, chat_id, item_name, item_icon, price, status, remark, created_at FROM shop_orders WHERE id = ?"
  ).bind(orderId).first();

  if (!o) {
    return editMessageText(token, chatId, messageId, "❌ 订单不存在",
      { inline_keyboard: [[{ text: "🔙 返回订单列表", callback_data: "shop_admin_orders_pending_1" }]] });
  }

  const statusMap = { pending: "⏳ 待处理", shipped: "🚚 已发货", done: "✅ 已完成", cancelled: "❌ 已取消" };

  const text =
    `🧾 <b>订单详情</b>\n` +
    `-------------------------\n` +
    `订单号：<code>${o.order_no}</code>\n` +
    `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n` +
    `💰 积分：${o.price}\n` +
    `👤 用户：<code>${o.user_id}</code>\n` +
    `💬 会话：<code>${o.chat_id}</code>\n` +
    `📌 状态：${statusMap[o.status] || o.status}\n` +
    `📝 备注：${escapeHtml(o.remark) || "（无）"}\n` +
    `🕒 下单：${o.created_at}`;

  const inline_keyboard = [];

  if (o.status === "pending") {
    inline_keyboard.push([
      { text: "🚚 标记已发货", callback_data: `shop_admin_ship_${o.id}` },
      { text: "❌ 取消并退款", callback_data: `shop_admin_cancel_${o.id}` }
    ]);
  } else if (o.status === "shipped") {
    inline_keyboard.push([
      { text: "✅ 标记完成", callback_data: `shop_admin_done_${o.id}` }
    ]);
  }

  inline_keyboard.push([{ text: "🔙 返回订单列表", callback_data: "shop_admin_orders_pending_1" }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}
