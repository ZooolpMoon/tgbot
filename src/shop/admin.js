// ==========================================
// 🛒 商城管理（管理员）
// 入口：管理员主菜单 → 商城管理；也可用 /shop_admin
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, pageInfoText, LAYOUT } from "../utils/layout.js";
import { categoryText } from "./categories.js";
import { DELIVERY, deliveryText, deliveryOf, useTypeText, useTypeOf, useValueOf, USE_TYPE } from "./delivery.js";
import { formatAppTime } from "../services/time.js";

const ITEMS_PER_PAGE = 8;
const ORDERS_PER_PAGE = 5;

// ---------- 管理首页 ----------
/** 商城管理首页键盘（纯函数，便于排版测试） */
export function getShopAdminHomeKeyboard() {
  return {
    inline_keyboard: [
      ...grid([
        { text: "➕ 添加商品", callback_data: "shop_admin_add" },
        { text: "📦 商品列表", callback_data: "shop_admin_items_1" },
        { text: "⏳ 待处理订单", callback_data: "shop_admin_orders_pending_1" },
        { text: "📜 全部订单", callback_data: "shop_admin_orders_all_1" }
      ]),
      [{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]
    ]
  };
}

/** 商城管理首页：商品总数 + 待处理订单数 + 四个入口 */
export async function renderShopAdmin(token, env, chatId, messageId = null) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const itemCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_items").first();
  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shop_orders WHERE status = 'pending'"
  ).first();

  const text =
    `🛒 <b>商城管理</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `📦 商品总数：<b>${Number(itemCount?.n) || 0}</b>\n` +
    `⏳ 待处理订单：<b>${Number(pendingCount?.n) || 0}</b>\n\n` +
    `请选择操作：`;

  const keyboard = getShopAdminHomeKeyboard();

  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ---------- 商品列表 ----------
/** 商品列表键盘（纯函数，便于排版测试）：每页 8 件 = 4 行 + 翻页 + 返回 */
export function getShopAdminItemsKeyboard(items, safePage, totalPages) {
  const inline_keyboard = grid(
    items.map((it) => ({
      text: compactLabel(`${it.enabled ? "✅" : "🚫"} ${it.icon} ${it.name} · 🪙${it.price}`, 30),
      callback_data: `shop_admin_item_${it.id}`
    }))
  );

  const navRow = pagerRow({ page: safePage, totalPages, prefix: "shop_admin_items_" });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回商城管理", callback_data: "shop_admin_home" }]);
  return { inline_keyboard };
}

/** 商品列表（管理侧，倒序分页，含上下架状态） */
export async function renderShopAdminItems(token, env, chatId, messageId, page = 1) {
  if (!env.DB) return;

  const countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM shop_items").first();
  const total = Number(countRes?.n) || 0;
  const totalPages = totalPagesOf(total, ITEMS_PER_PAGE);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    "SELECT id, name, icon, price, stock, enabled FROM shop_items ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(ITEMS_PER_PAGE, pageOffset(safePage, ITEMS_PER_PAGE)).all();

  let text = `📦 <b>商品列表</b>\n`;
  text += `${pageInfoText({ page: safePage, totalPages, total, unit: "件" })}\n`;
  text += `${LAYOUT.DIVIDER}\n\n`;

  if (!results || results.length === 0) {
    text += `<i>还没有商品。</i>\n`;
  } else {
    for (const it of results) {
      const stockText = Number(it.stock) === -1 ? "∞" : it.stock;
      const state = it.enabled ? "✅" : "🚫";
      text += `${state} ${it.icon} <b>${escapeHtml(it.name)}</b> · 🪙${it.price} · 库存 ${stockText}\n`;
    }
  }

  const keyboard = getShopAdminItemsKeyboard(results || [], safePage, totalPages);
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ---------- 商品详情 ----------
export async function renderShopAdminItem(token, env, chatId, messageId, itemId) {
  if (!env.DB) return;

  const item = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled, per_user_limit, delivery, use_type, use_value FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  if (!item) {
    return editMessageText(token, chatId, messageId, "❌ 商品不存在",
      { inline_keyboard: [[{ text: "🔙 返回商品列表", callback_data: "shop_admin_items_1" }]] });
  }

  const catText = categoryText(item.category);
  const stockText = item.stock === -1 ? "无限" : item.stock;
  const limitText = Number(item.per_user_limit) > 0 ? `每人 ${item.per_user_limit} 件` : "不限";
  const useText = deliveryOf(item) === DELIVERY.BAG
    ? (useTypeOf(item) === USE_TYPE.POINTS
      ? `${useTypeText(USE_TYPE.POINTS)}（🪙 ${useValueOf(item)}）`
      : useTypeText(USE_TYPE.NONE))
    : "—";

  const text =
    `${item.icon} <b>${escapeHtml(item.name)}</b>\n` +
    `-------------------------\n` +
    `🆔 ID：<code>${item.id}</code>\n` +
    `💰 价格：🪙 ${item.price}\n` +
    `📦 库存：${stockText}\n` +
    `🙋 限购：${limitText}\n` +
    `📂 分类：${catText}\n` +
    `🚚 发放方式：${deliveryText(deliveryOf(item))}\n` +
    `🎒 背包用法：${useText}\n` +
    `🔘 状态：${item.enabled ? "✅ 已上架" : "🚫 已下架"}\n\n` +
    `📝 <b>说明：</b>\n${escapeHtml(item.description) || "（无）"}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "✏️ 编辑商品信息", callback_data: `shop_admin_edit_${item.id}` }],
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
/** 订单列表键盘（纯函数，便于排版测试）：每页 5 条 = 3 行 + 翻页 + 返回 */
export function getShopAdminOrdersKeyboard(orders, safePage, totalPages, filter = "pending") {
  const statusMap = { pending: "⏳", done: "✅", cancelled: "❌", refunded: "↩️" };
  const inline_keyboard = grid(
    orders.map((o) => ({
      text: `${statusMap[o.status] || "❔"} ${o.order_no}`,
      callback_data: `shop_admin_order_${o.id}`
    }))
  );

  const prefix = filter === "all" ? "shop_admin_orders_all_" : "shop_admin_orders_pending_";
  const navRow = pagerRow({ page: safePage, totalPages, prefix });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回商城管理", callback_data: "shop_admin_home" }]);
  return { inline_keyboard };
}

/**
 * 订单列表（管理侧）。
 * @param {"pending"|"all"} filter pending = 只看待处理，all = 全部订单
 */
export async function renderShopAdminOrders(token, env, chatId, messageId, filter = "pending", page = 1) {
  if (!env.DB) return;

  const where = filter === "all" ? "" : "WHERE status = 'pending'";

  const countRes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM shop_orders ${where}`).first();
  const total = Number(countRes?.n) || 0;
  const totalPages = totalPagesOf(total, ORDERS_PER_PAGE);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    `SELECT id, order_no, user_id, item_name, item_icon, price, status, created_at FROM shop_orders ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(ORDERS_PER_PAGE, pageOffset(safePage, ORDERS_PER_PAGE)).all();

  const statusMap = { pending: "⏳", done: "✅", cancelled: "❌", refunded: "↩️" };

  let text = `📜 <b>${filter === "all" ? "全部订单" : "待处理订单"}</b>\n`;
  text += `${pageInfoText({ page: safePage, totalPages, total, unit: "条" })}\n`;
  text += `${LAYOUT.DIVIDER}\n\n`;

  if (!results || results.length === 0) {
    text += `<i>没有订单。</i>\n`;
  } else {
    for (const o of results) {
      text += `${o.item_icon} <b>${escapeHtml(o.item_name)}</b> · 🪙${o.price}\n`;
      text += `🧾 <code>${o.order_no}</code> · 👤 <code>${o.user_id}</code>\n`;
      text += `📌 ${statusMap[o.status] || o.status} · 🕒 ${escapeHtml(formatAppTime(env, o.created_at))}\n\n`;
    }
  }

  const keyboard = getShopAdminOrdersKeyboard(results || [], safePage, totalPages, filter);
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

// ---------- 订单详情 ----------
export async function renderShopAdminOrder(token, env, chatId, messageId, orderId) {
  if (!env.DB) return;

  const o = await env.DB.prepare(
    `SELECT o.id, o.order_no, o.user_key, o.user_id, o.chat_id, o.item_id, o.item_name, o.item_icon,
            o.price, o.status, o.remark, o.created_at,
            COALESCE(i.delivery, 'manual') AS delivery,
            (SELECT COUNT(*) FROM user_bag_items b WHERE b.order_id = o.id AND b.status = 'unused') AS bag_unused,
            (SELECT COUNT(*) FROM user_bag_items b WHERE b.order_id = o.id) AS bag_total
       FROM shop_orders o LEFT JOIN shop_items i ON i.id = o.item_id
      WHERE o.id = ?`
  ).bind(orderId).first();

  if (!o) {
    return editMessageText(token, chatId, messageId, "❌ 订单不存在",
      { inline_keyboard: [[{ text: "🔙 返回订单列表", callback_data: "shop_admin_orders_pending_1" }]] });
  }

  const statusMap = { pending: "⏳ 待处理", done: "✅ 已完成", cancelled: "❌ 已取消", refunded: "↩️ 已退款" };

  const bagText = Number(o.bag_total) > 0
    ? (Number(o.bag_unused) > 0 ? `🎒 背包：${o.bag_unused} 件未使用（可退回）` : "🎒 背包：已全部使用（不可退）")
    : "";

  const text =
    `🧾 <b>订单详情</b>\n` +
    `-------------------------\n` +
    `订单号：<code>${o.order_no}</code>\n` +
    `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n` +
    `💰 积分：${o.price}\n` +
    `👤 用户：<code>${o.user_id}</code>\n` +
    `💬 会话：<code>${o.chat_id}</code>\n` +
    `📌 状态：${statusMap[o.status] || o.status}\n` +
    `🚚 发放方式：${deliveryText(deliveryOf(o))}\n` +
    (bagText ? `${bagText}\n` : ``) +
    `📝 备注：${escapeHtml(o.remark) || "（无）"}\n` +
    `🕒 下单：${escapeHtml(formatAppTime(env, o.created_at))}`;

  const inline_keyboard = [];

  if (o.status === "pending") {
    inline_keyboard.push([
      { text: "✅ 标记已完成（已发放）", callback_data: `shop_admin_done_${o.id}` },
      { text: "❌ 取消并退款", callback_data: `shop_admin_cancel_${o.id}` }
    ]);
  }
  // 已完成的订单可以退款；进背包且还没使用的会一并收回
  if (o.status === "done") {
    inline_keyboard.push([
      { text: "↩️ 退款（收回未使用物品）", callback_data: `shop_admin_refund_${o.id}` }
    ]);
  }

  inline_keyboard.push([{ text: "🔙 返回订单列表", callback_data: "shop_admin_orders_pending_1" }]);

  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}
