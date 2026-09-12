// ==========================================
// 🛒 积分商城 - 用户侧
// 浏览商品 → 商品详情 → 填写备注 → 确认兑换 → 我的订单（可自助取消退款）
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { tryDeductPoints, refundPoint, logPointChange } from "../services/points.js";
import { randomInt } from "../utils/random.js";
import { logError } from "../core/logger.js";
import { SHOP } from "../config/constants.js";
import { getOrderNote, cancelOrderNote } from "./notes.js";
import { categoryText } from "./categories.js";
import { formatAppTime } from "../services/time.js";

/** 自动发放类商品：下单即完成，由机器人自己把东西交付给用户（不需要管理员发货） */
export const AUTO_DELIVERY = { GROUP_TAG: "group_tag" };

/** 商品的发放方式（未知/空一律按人工发放处理） */
export function deliveryOf(item) {
  const value = String(item?.delivery || "").trim();
  return value || "manual";
}

/**
 * 商城首页键盘（纯函数，便于排版测试）。
 * 8 件商品 = 4 行，加翻页 1 行、我的订单 1 行、关闭 1 行，最多 7 行。
 */
export function getShopHomeKeyboard(items, safePage, totalPages) {
  const inline_keyboard = grid(
    items.map((it) => ({
      text: compactLabel(`${it.icon} ${it.name} · 🪙${it.price}`, 30),
      callback_data: `shop_view_${it.id}`
    }))
  );

  const navRow = pagerRow({ page: safePage, totalPages, prefix: "shop_home_page_" });
  if (navRow) inline_keyboard.push(navRow);

  inline_keyboard.push([{ text: "📜 我的订单", callback_data: "shop_orders_1" }]);
  inline_keyboard.push([{ text: "🔙 关闭", callback_data: "shop_close" }]);
  return { inline_keyboard };
}

/** 商城首页：商品列表（两列网格）+ 翻页 + 我的订单 */
export async function renderShopHome(token, env, chatId, userKey, messageId = null, page = 1) {
  if (!env.DB) {
    return sendMessage(token, chatId, "❌ 商城未启用（未绑定数据库）。");
  }

  const pageSize = SHOP.ITEMS_PER_PAGE;
  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM shop_items WHERE enabled = 1"
  ).first();
  const total = Number(countRes?.n) || 0;
  const totalPages = totalPagesOf(total, pageSize);
  const safePage = clampPage(page, totalPages);

  const pts = await getUserPoints(env, userKey);
  const { results } = await env.DB.prepare(
    "SELECT id, name, icon, price, stock FROM shop_items WHERE enabled = 1 ORDER BY id ASC LIMIT ? OFFSET ?"
  ).bind(pageSize, pageOffset(safePage, pageSize)).all();

  const items = results || [];

  let text = `🛒 <b>积分商城</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `💰 <b>我的积分：</b> <code>${pts}</code>\n\n`;
  text += `📦 <b>在售商品：</b> ${safePage} / ${totalPages} 页（共 ${total} 件）\n\n`;

  if (items.length === 0) {
    text += `<i>(暂无在售商品，请稍后再来)</i>\n`;
  } else {
    // 正文列出价格与库存，按钮只放「图标 + 名称」，避免按钮被挤爆
    for (const it of items) {
      const stockText = it.stock === -1 ? "∞" : (it.stock > 0 ? `${it.stock}` : "已售罄");
      text += `${it.icon} <b>${escapeHtml(it.name)}</b> — 🪙 ${it.price}（库存：${stockText}）\n`;
    }
  }

  const keyboard = getShopHomeKeyboard(items, safePage, totalPages);

  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ---------- 商品详情 ----------
/** 商品详情：展示价格/库存/限购/备注，并提供兑换入口 */
export async function renderShopItem(token, env, chatId, userKey, messageId, itemId) {
  if (!env.DB) {
    const text = "❌ 商城未启用（未绑定数据库）。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const item = await env.DB.prepare(
    "SELECT id, name, description, icon, price, stock, category, enabled, per_user_limit, delivery FROM shop_items WHERE id = ?"
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
  const catText = categoryText(item.category);
  const note = await getOrderNote(env, chatId, item.id);
  const perUserLimit = Number(item.per_user_limit) || 0;
  const autoTag = deliveryOf(item) === AUTO_DELIVERY.GROUP_TAG;

  const text =
    `${item.icon} <b>${escapeHtml(item.name)}</b>\n` +
    `-------------------------\n` +
    `📂 <b>分类：</b> ${catText}\n` +
    `💰 <b>价格：</b> 🪙 ${item.price}\n` +
    `📦 <b>库存：</b> ${stockText}${perUserLimit > 0 ? `\n🙋 <b>限购：</b> 每人 ${perUserLimit} 件` : ""}\n` +
    `🪙 <b>我的积分：</b> ${pts}\n` +
    (autoTag ? `🚚 <b>发放方式：</b> 购买后自动完成，接着选一个群设置你的标签\n` : "") +
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
/**
 * 用户点击「确认兑换」：
 * 校验上架/库存/限购 → 原子扣积分 → 扣库存 → 建订单 →
 * 任何一步失败都会把前面已发生的扣减补偿回来。
 */
export async function handleShopBuy(token, env, callback, chatId, userKey, userId, messageId, itemId, firstName = "") {
  if (!env.DB) return answerCallback(token, callback.id, "❌ 商城未启用", true);

  const item = await env.DB.prepare(
    "SELECT id, name, icon, price, stock, category, enabled, per_user_limit, delivery FROM shop_items WHERE id = ?"
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

  // 自动发放类商品（如「自定义群组标签」）：下单即完成，不需要管理员发货
  const autoDelivery = deliveryOf(item) === AUTO_DELIVERY.GROUP_TAG;

  // 创建订单
  const orderNo = "S" + Date.now().toString(36).toUpperCase() + randomInt(1679616).toString(36).padStart(4, "0").toUpperCase();

  let orderId = null;
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      orderNo, userKey, userId, chatId, item.id, item.name, item.icon, item.price,
      autoDelivery ? "done" : "pending", note || ""
    ).run();
    orderId = Number(inserted?.meta?.last_row_id) || null;
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

  // 限购兜底：并发点击时两条请求可能同时通过前置校验，
  // 这里以「落库后的真实订单数」为准，多出来的那一单自动取消并退款。
  if (perUserLimit > 0 && orderId) {
    const afterRes = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM shop_orders WHERE user_key = ? AND item_id = ? AND status <> 'cancelled'"
    ).bind(userKey, item.id).first();
    if ((Number(afterRes?.n) || 0) > perUserLimit) {
      await env.DB.prepare(
        "UPDATE shop_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      ).bind(orderId).run();
      if (stockDecremented) {
        await env.DB.prepare(
          "UPDATE shop_items SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(item.id).run();
      }
      await refundPoint(env, userKey, item.price, `超出限购自动退款 [${item.name}]`);
      return answerCallback(token, callback.id, `❌ 该商品每人限购 ${perUserLimit} 件，本单已自动退款`, true);
    }
  }

  // 订单已创建，清掉备注草稿（失败时不清理，用户不用重填）
  await cancelOrderNote(env, chatId);

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
    (autoDelivery
      ? `🚚 本商品<b>无需发货，已自动完成</b>，接下来选一个群设置你的标签。`
      : `⏳ 请等待管理员处理（虚拟物品/服务由管理员人工确认发放）。`);

  const keyboard = {
    inline_keyboard: [
      [{ text: "📜 我的订单", callback_data: "shop_orders_1" }],
      [{ text: "🔙 返回商城", callback_data: "shop_home" }]
    ]
  };

  await editMessageText(token, chatId, messageId, successText, keyboard, "HTML");

  // 自动发放类：直接进引导流程（选群 → 填标签），不打扰管理员
  if (autoDelivery && orderId) {
    try {
      const { startTagFlow } = await import("./tags.js");
      await startTagFlow({
        token, env, chatId, userId, orderId, itemId: item.id, messageId
      });
    } catch (e) {
      logError("启动群标签设置流程失败:", e);
      await sendMessage(
        token, chatId,
        "⚠️ 订单已完成，但设置流程启动失败了。请到「📜 我的订单」点「🏷️ 设置标签」重新进入。",
        "HTML"
      );
    }
    return;
  }

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
/**
 * 我的订单键盘（纯函数，便于排版测试）。
 * 待处理订单的「取消并退款」单独占一行，避免误触相邻订单。
 */
export function getMyOrdersKeyboard(orders, safePage, totalPages) {
  const inline_keyboard = [];

  for (const o of orders) {
    if (o.status === "pending") {
      inline_keyboard.push([
        {
          text: compactLabel(`❌ 取消 ${o.order_no} 并退款`, 30),
          callback_data: `shop_ucancel_${o.id}_${safePage}`
        }
      ]);
      continue;
    }
    // 自动发放类商品（群标签）还没设置完：给一个回到设置流程的入口，钱不白花
    if (o.status === "done" && o.delivery === AUTO_DELIVERY.GROUP_TAG && Number(o.tag_applied) === 0) {
      inline_keyboard.push([
        {
          text: compactLabel(`🏷️ 设置标签 ${o.order_no}`, 30),
          callback_data: `shop_tag_order_${o.id}`
        }
      ]);
    }
  }

  const navRow = pagerRow({ page: safePage, totalPages, prefix: "shop_orders_" });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回商城", callback_data: "shop_home" }]);

  return { inline_keyboard };
}

/** 我的订单：按最新在前分页，待处理订单可自助取消并退款 */
export async function renderMyOrders(token, env, chatId, userKey, messageId, page = 1) {
  if (!env.DB) {
    const text = "❌ 商城未启用（未绑定数据库）。";
    return messageId
      ? editMessageText(token, chatId, messageId, text)
      : sendMessage(token, chatId, text);
  }

  const pageSize = SHOP.ORDERS_PER_PAGE;

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM shop_orders WHERE user_key = ?"
  ).bind(userKey).first();
  const total = Number(countRes?.total) || 0;
  const totalPages = totalPagesOf(total, pageSize);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.order_no, o.item_name, o.item_icon, o.price, o.status, o.created_at,
            COALESCE(i.delivery, 'manual') AS delivery,
            (SELECT COUNT(*) FROM user_group_tags t WHERE t.order_id = o.id) AS tag_applied
       FROM shop_orders o
       LEFT JOIN shop_items i ON i.id = o.item_id
      WHERE o.user_key = ? ORDER BY o.id DESC LIMIT ? OFFSET ?`
  ).bind(userKey, pageSize, pageOffset(safePage, pageSize)).all();

  const statusMap = {
    pending: "⏳ 待处理",
    done: "✅ 已完成",
    cancelled: "❌ 已取消"
  };

  let text = `📜 <b>我的订单</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `${LAYOUT.DIVIDER}\n\n`;

  if (!results || results.length === 0) {
    text += `<i>还没有兑换记录，去商城看看吧～</i>\n`;
  } else {
    results.forEach((o) => {
      text += `${o.item_icon} <b>${escapeHtml(o.item_name)}</b>\n`;
      text += `🧾 <code>${o.order_no}</code> · 🪙 ${o.price}\n`;
      text += `📌 状态：${statusMap[o.status] || o.status}\n`;
      text += `🕒 ${escapeHtml(formatAppTime(env, o.created_at))}\n\n`;
    });
  }

  const keyboard = getMyOrdersKeyboard(results || [], safePage, totalPages);

  if (!messageId) {
    return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
  }
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}
