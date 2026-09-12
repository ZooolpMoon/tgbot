// ==========================================
// 🛒 积分商城 - 用户侧
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { escapeHtml } from "../utils/html.js";
import { answerCallback } from "../telegram/api.js";
import { tryDeductPoints, refundPoint, logPointChange } from "../services/points.js";
import { randomInt } from "../utils/random.js";
import { logError } from "../core/logger.js";
import { SHOP } from "../config/constants.js";
import { getOrderNote, cancelOrderNote } from "./notes.js";
import { completeTask } from "../services/tasks.js";

export async function renderShopHome(token, env, chatId, userKey, messageId = null, page = 1) {
  if (!env.DB) {
    return sendMessage(token, chatId, "❌ 商城未启用（未绑定数据库）。");
  }

  const pageSize = SHOP.ITEMS_PER_PAGE;
  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shop_items WHERE enabled = 1"
  ).first();
  const total = Number(countRes?.n) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;

  let safePage = Math.max(1, Math.floor(Number(page) || 1));
  if (safePage > totalPages) safePage = totalPages;
  const offset = (safePage - 1) * pageSize;

  const pts = await getUserPoints(env, userKey);
  const { results } = await env.DB.prepare(
    "SELECT id, name, icon, price, stock FROM shop_items WHERE enabled = 1 ORDER BY id ASC LIMIT ? OFFSET ?"
  ).bind(pageSize, offset).all();

  const items = results || [];

  let text = `🛒 <b>积分商城</b>\n`;
  text += `-------------------------\n`;
  text += `💰 <b>我的积分：</b> <code>${pts}</code>\n\n`;
  text += `📦 <b>在售商品：</b> ${safePage} / ${totalPages} 页（共 ${total} 件）\n\n`;

  const inline_keyboard = [];

  if (items.length === 0) {
    text += `<i>(暂无在售商品，请稍后再来)</i>\n`;
  } else {
    items.forEach((it) => {
      const stockText = it.stock === -1 ? "∞" : (it.stock > 0 ? `${it.stock}` : "已售罄");
      text += `${it.icon} <b>${escapeHtml(it.name)}</b> — 🪙 ${it.price}（库存：${stockText}）\n`;
      inline_keyboard.push([
        { text: `${it.icon} ${it.name} · 🪙 ${it.price}`, callback_data: `shop_view_${it.id}` }
      ]);
    });
  }

  const navRow = [];
  if (safePage > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `shop_home_page_${safePage - 1}` });
  if (safePage < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `shop_home_page_${safePage + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "📜 我的订单", callback_data: "shop_orders_1" }]);
  inline_keyboard.push([{ text: "🔙 关闭", callback_data: "shop_close" }]);

  const keyboard = { inline_keyboard };

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ---------- 商品详情 ----------
export async function renderShopItem(token, env, chatId, userKey, messageId, itemId) {
  if (!env.DB) {
    const text = "❌ 商城未启用（未绑定数据库）。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const item = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  if (!item || item.enabled !== 1) {
    const text = "❌ 该商品已下架或不存在。";
    const keyboard = { inline_keyboard: [[{ text: "🔙 返回商城", callback_data: "shop_home" }]] };
    return messageId
      ? editMessageText(token, chatId, messageId, text, keyboard)
      : sendMessageWithKeyboard(token, chatId, text, keyboard);
  }

  const pts = await getUserPoints(env, userKey);
  const stockText = item.stock === -1 ? "无限" : (item.stock > 0 ? `${item.stock}` : "已售罄");
  const catText = { virtual: "虚拟物品", service: "服务" }[item.category] || item.category;
  const note = await getOrderNote(env, chatId, item.id);
  const perUserLimit = Number(item.per_user_limit) || 0;

  const text =
    `${item.icon} <b>${escapeHtml(item.name)}</b>\n` +
    `-------------------------\n` +
    `📂 <b>分类：</b> ${catText}\n` +
    `💰 <b>价格：</b> 🪙 ${item.price}\n` +
    `📦 <b>库存：</b> ${stockText}${perUserLimit > 0 ? `\n🙋 <b>限购：</b> 每人 ${perUserLimit} 件` : ""}\n` +
    `🪙 <b>我的积分：</b> ${pts}\n` +
    `🧾 <b>下单备注：</b> ${note ? escapeHtml(note) : "（未填写）"}\n\n` +
    `📝 <b>说明：</b>\n${escapeHtml(item.description) || "（无）"}\n`;

  const inline_keyboard = [];

  if (item.stock === 0) {
    inline_keyboard.push([{ text: "❌ 已售罄", callback_data: `shop_soldout_${item.id}` }]);
  } else if (pts < item.price) {
    inline_keyboard.push([{ text: `❌ 积分不足（差 ${item.price - pts}）`, callback_data: `shop_nopts_${item.id}` }]);
  } else {
    inline_keyboard.push([{ text: `✅ 确认兑换 · 🪙 ${item.price}`, callback_data: `shop_buy_${item.id}` }]);
  }

  // 服务类商品常需要补充说明（想要的款式、联系方式等），这里提供可选的备注
  inline_keyboard.push([
    { text: note ? "✍️ 修改备注" : "✍️ 填写备注", callback_data: `shop_note_${item.id}` }
  ]);

  inline_keyboard.push([{ text: "🔙 返回商城", callback_data: "shop_home" }]);

  if (!messageId) {
    return sendMessageWithKeyboard(token, chatId, text, { inline_keyboard }, "HTML");
  }
  return editMessageText(token, chatId, messageId, text, { inline_keyboard }, "HTML");
}

// ---------- 执行兑换 ----------
export async function handleShopBuy(token, env, callback, chatId, userKey, userId, messageId, itemId, firstName = "") {
  if (!env.DB) return answerCallback(token, callback.id, "❌ 商城未启用", true);

  const item = await env.DB.prepare(
    "SELECT id, name, icon, price, stock, category, enabled, per_user_limit FROM shop_items WHERE id = ?"
  ).bind(itemId).first();

  if (!item || item.enabled !== 1) {
    return answerCallback(token, callback.id, "❌ 商品已下架", true);
  }

  if (item.stock === 0) {
    return answerCallback(token, callback.id, "❌ 已售罄", true);
  }

  // 每人限购（已取消的订单不占名额）
  const perUserLimit = Number(item.per_user_limit) || 0;
  if (perUserLimit > 0) {
    const boughtRes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM shop_orders WHERE user_key = ? AND item_id = ? AND status <> 'cancelled'"
    ).bind(userKey, item.id).first();
    if ((Number(boughtRes?.n) || 0) >= perUserLimit) {
      return answerCallback(token, callback.id, `❌ 该商品每人限购 ${perUserLimit} 件，你已达到上限`, true);
    }
  }

  // 扣积分（原子操作）
  const afterDeduct = await tryDeductPoints(env, userKey, item.price);
  if (afterDeduct === null) {
    return answerCallback(token, callback.id, "❌ 积分不足", true);
  }

  // 扣库存
  let stockDecremented = false;
  if (item.stock > 0) {
    const stockRes = await env.DB.prepare(
      "UPDATE shop_items SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock > 0"
    ).bind(item.id).run();

    if (stockRes.meta.changes === 0) {
      await refundPoint(env, userKey, item.price, `商品 [${item.name}] 库存不足自动退款`);
      return answerCallback(token, callback.id, "❌ 手慢了，已被抢完", true);
    }
    stockDecremented = true;
  }

  // 下单备注（用户在商品详情里填写过才存在）
  const note = await getOrderNote(env, chatId, item.id);

  // 创建订单
  const orderNo = "S" + Date.now().toString(36).toUpperCase() + randomInt(1679616).toString(36).padStart(4, "0").toUpperCase();

  try {
    await env.DB.prepare(`
      INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).bind(orderNo, userKey, userId, chatId, item.id, item.name, item.icon, item.price, note || "").run();
  } catch (e) {
    // 订单创建失败时回滚：退回积分，并恢复已扣减的库存。
    if (stockDecremented) {
      await env.DB.prepare(
        "UPDATE shop_items SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(item.id).run();
    }
    await refundPoint(env, userKey, item.price, `创建订单失败自动退款 [${item.name}]`);
    logError("商城创建订单失败:", e);
    return answerCallback(token, callback.id, "❌ 下单失败，积分和库存已自动退回", true);
  }

  // 订单已创建，清掉备注草稿（失败时不清理，用户不用重填）
  await cancelOrderNote(env, chatId);

  // 完成「在商城兑换一次」任务（商城仅私聊，场景键即 private:<uid>）
  await completeTask(env, userKey, "shop", { sceneKey: `private:${chatId}`, chatId, token });

  await logPointChange(env, userKey, -item.price, afterDeduct, `兑换 [${item.name}] 订单 ${orderNo}`);

  await answerCallback(token, callback.id, `✅ 兑换成功！订单 ${orderNo}`);

  const successText =
    `🎉 <b>兑换成功！</b>\n` +
    `-------------------------\n` +
    `🧾 <b>订单号：</b> <code>${orderNo}</code>\n` +
    `${item.icon} <b>商品：</b> ${escapeHtml(item.name)}\n` +
    `💰 <b>消耗积分：</b> ${item.price}\n` +
    `🪙 <b>当前积分：</b> ${afterDeduct}\n` +
    (note ? `🧾 <b>备注：</b> ${escapeHtml(note)}\n` : ``) +
    `\n` +
    `⏳ 请等待管理员处理（虚拟物品/服务由管理员人工确认发放）。`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📜 我的订单", callback_data: "shop_orders_1" }],
      [{ text: "🔙 返回商城", callback_data: "shop_home" }]
    ]
  };

  await editMessageText(token, chatId, messageId, successText, keyboard, "HTML");

  // 通知管理员（新订单）
  try {
    const { notifyAdminNewOrder } = await import("./notify.js");
    await notifyAdminNewOrder(token, env,
      { order_no: orderNo, price: item.price, chat_id: chatId, created_at: new Date().toISOString(), remark: note || "" },
      item,
      { userId, firstName }
    );
  } catch (e) {
    logError("通知管理员失败:", e);
  }
}

// ---------- 我的订单 ----------
export async function renderMyOrders(token, env, chatId, userKey, messageId, page = 1) {
  if (!env.DB) {
    const text = "❌ 商城未启用（未绑定数据库）。";
    return messageId
      ? editMessageText(token, chatId, messageId, text)
      : sendMessage(token, chatId, text);
  }

  const pageSize = SHOP.ORDERS_PER_PAGE;
  let safePage = Math.max(1, Math.floor(Number(page) || 1));

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM shop_orders WHERE user_key = ?"
  ).bind(userKey).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  if (safePage > totalPages) safePage = totalPages;

  const offset = (safePage - 1) * pageSize;

  const { results } = await env.DB.prepare(
    "SELECT id, order_no, item_name, item_icon, price, status, created_at FROM shop_orders WHERE user_key = ? ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(userKey, pageSize, offset).all();

  const statusMap = {
    pending: "⏳ 待处理",
    done: "✅ 已完成",
    cancelled: "❌ 已取消"
  };

  let text = `📜 <b>我的订单</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `-------------------------\n\n`;

  const inline_keyboard = [];

  if (!results || results.length === 0) {
    text += `<i>还没有兑换记录，去商城看看吧～</i>\n`;
  } else {
    results.forEach((o) => {
      text += `${o.item_icon} <b>${escapeHtml(o.item_name)}</b>\n`;
      text += `🧾 <code>${o.order_no}</code> · 🪙 ${o.price}\n`;
      text += `📌 状态：${statusMap[o.status] || o.status}\n`;
      text += `🕒 ${o.created_at}\n\n`;

      // 待处理订单允许用户自助取消并退款
      if (o.status === "pending") {
        inline_keyboard.push([
          { text: `❌ 取消订单 ${o.order_no} 并退款`, callback_data: `shop_ucancel_${o.id}_${safePage}` }
        ]);
      }
    });
  }

  const navRow = [];
  if (safePage > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `shop_orders_${safePage - 1}` });
  if (safePage < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `shop_orders_${safePage + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回商城", callback_data: "shop_home" }]);

  const keyboard = { inline_keyboard };

  if (!messageId) {
    return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
  }
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}
