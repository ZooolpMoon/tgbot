// ==========================================
// 🛒 商城订单/商品操作
// 用户自助取消与管理员操作共用同一套退款逻辑。
// ==========================================

import { answerCallback, sendMessage } from "../telegram/api.js";
import { refundPoint } from "../services/points.js";
import { escapeHtml } from "../utils/html.js";
import { logAdminAction } from "../services/admin-log.js";

// ==========================================
// 🧾 订单：取消并退款（原子状态流转）
// ==========================================

/**
 * 把 pending 订单置为 cancelled，并退还积分、回滚库存。
 * 只有「状态确实由 pending 变为 cancelled」时才退款，避免重复退款。
 *
 * @param {string} note 写入订单日志的备注（admin / user / refunded…）
 * @returns {Promise<boolean>} 是否本次调用完成了取消
 */
export async function cancelOrderWithRefund(env, order, note = "refunded") {
  if (!env.DB || !order) return false;

  const upd = await env.DB.prepare(
    "UPDATE shop_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
  ).bind(order.id).run();

  if (upd.meta.changes === 0) return false;

  await refundPoint(env, order.user_key, order.price, `订单 ${order.order_no} 取消退款`);

  // 库存回滚（仅对「有限库存」的商品）
  const item = await env.DB.prepare("SELECT stock FROM shop_items WHERE id = ?").bind(order.item_id).first();
  if (item && Number(item.stock) >= 0) {
    await env.DB.prepare(
      "UPDATE shop_items SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(order.item_id).run();
  }

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'cancelled', ?)"
  ).bind(order.id, String(note || "refunded")).run();

  return true;
}

/** 按主键读订单（不存在返回 null） */
export async function getOrderById(env, orderId) {
  if (!env.DB) return null;
  return env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
}

// ==========================================
// 👤 用户自助取消（仅限 pending 且必须是自己的订单）
// ==========================================

export async function handleUserCancelOrder(token, env, callback, userKey, orderId) {
  const order = await getOrderById(env, orderId);
  if (!order) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (order.user_key !== userKey) {
    return answerCallback(token, callback.id, "❌ 只能取消自己的订单", true);
  }
  if (order.status !== "pending") {
    return answerCallback(token, callback.id, "⚠️ 订单已开始处理，请直接联系管理员", true);
  }

  const ok = await cancelOrderWithRefund(env, order, "user_cancel");
  if (!ok) {
    return answerCallback(token, callback.id, "⚠️ 订单状态已变更，请刷新后查看", true);
  }

  await answerCallback(token, callback.id, `✅ 已取消订单 ${order.order_no}，${order.price} 积分已退回`);

  try {
    await sendMessage(
      token, order.chat_id,
      `❌ <b>订单已取消</b>\n-------------------------\n` +
      `🧾 订单号：<code>${order.order_no}</code>\n` +
      `${order.item_icon} 商品：${escapeHtml(order.item_name)}\n` +
      `💰 已退还 <b>${order.price}</b> 积分。`,
      "HTML"
    );
  } catch (_) {
    /* 通知失败不影响取消结果 */
  }

  // 同步提醒管理员（订单已从待处理队列移除）
  try {
    const { resolveAdminChatId } = await import("./notify.js");
    const adminChat = resolveAdminChatId(env);
    if (adminChat) {
      await sendMessage(
        token, adminChat,
        `ℹ️ <b>用户自助取消订单</b>\n-------------------------\n` +
        `🧾 订单号：<code>${order.order_no}</code>\n` +
        `${order.item_icon} 商品：${escapeHtml(order.item_name)}\n` +
        `👤 用户 ID：<code>${order.user_id}</code>\n` +
        `💰 已自动退款 <b>${order.price}</b> 积分。`,
        "HTML"
      );
    }
  } catch (_) {
    /* 忽略 */
  }

  return true;
}

// ==========================================
// 👑 管理员：商品与订单操作
// ==========================================

// 上架/下架
/** 切换商品上架状态，并写管理员操作日志 */
export async function actionToggleItem(token, env, callback, itemId, adminId = null) {
  const it = await env.DB.prepare("SELECT name, enabled FROM shop_items WHERE id = ?").bind(itemId).first();
  if (!it) return answerCallback(token, callback.id, "❌ 商品不存在", true);

  const next = it.enabled ? 0 : 1;
  await env.DB.prepare("UPDATE shop_items SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(next, itemId).run();

  await logAdminAction(env, {
    adminId, chatId: callback.message?.chat?.id,
    action: next ? "shop_item_enable" : "shop_item_disable",
    detail: `#${itemId} ${it.name}`
  });

  await answerCallback(token, callback.id, next ? "✅ 已上架" : "🚫 已下架");
}

// 删除商品
/** 删除商品（已产生的订单记录会保留，不受影响） */
export async function actionDeleteItem(token, env, callback, itemId, adminId = null) {
  const it = await env.DB.prepare("SELECT name FROM shop_items WHERE id = ?").bind(itemId).first();
  await env.DB.prepare("DELETE FROM shop_items WHERE id = ?").bind(itemId).run();
  await logAdminAction(env, {
    adminId, chatId: callback.message?.chat?.id,
    action: "shop_item_delete",
    detail: `#${itemId} ${it?.name || ""}`
  });
  await answerCallback(token, callback.id, "🗑️ 已删除");
}

// 标记完成（虚拟物品/服务由管理员人工确认发放）
/** 把待处理订单标记为已完成，并通知用户 */
export async function actionDone(token, env, callback, orderId, adminId = null) {
  const o = await getOrderById(env, orderId);
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (o.status !== "pending") {
    return answerCallback(token, callback.id, `⚠️ 当前状态 ${o.status}，无法标记完成`, true);
  }

  await env.DB.prepare(
    "UPDATE shop_orders SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(orderId).run();

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action) VALUES (?, 'done')"
  ).bind(orderId).run();

  // 通知用户已完成发放
  try {
    await sendMessage(
      token, o.chat_id,
      `✅ <b>订单已完成</b>\n-------------------------\n` +
      `🧾 订单号：<code>${o.order_no}</code>\n` +
      `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n` +
      (o.remark ? `🧾 备注：${escapeHtml(o.remark)}\n` : ``) +
      `\n如有疑问请联系管理员。`,
      "HTML"
    );
  } catch (_) {}

  await logAdminAction(env, {
    adminId, chatId: callback.message?.chat?.id,
    action: "shop_order_done", detail: `${o.order_no} ${o.item_name}`
  });

  await answerCallback(token, callback.id, "✅ 订单已完成");
}

// 管理员：取消并退款
/** 管理员取消订单：退积分 + 回滚库存（复用原子状态流转，避免重复退款） */
export async function actionCancel(token, env, callback, orderId, adminId = null) {
  const o = await getOrderById(env, orderId);
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (o.status !== "pending") {
    return answerCallback(token, callback.id, `⚠️ 当前状态 ${o.status}，无法取消`, true);
  }

  const ok = await cancelOrderWithRefund(env, o, "admin_refund");
  if (!ok) {
    return answerCallback(token, callback.id, "⚠️ 订单状态已变更，请刷新后查看", true);
  }

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

  await logAdminAction(env, {
    adminId, chatId: callback.message?.chat?.id,
    action: "shop_order_cancel", detail: `${o.order_no} ${o.item_name} 退款 ${o.price}`
  });

  await answerCallback(token, callback.id, "✅ 已取消并退款");
}

// ==========================================
// ↩️ 已完成订单退款（回收还没使用的背包物品）
// ==========================================

/**
 * 已完成订单退款：done → refunded，并把订单里还没使用的背包物品一并回收。
 * 只有真正把状态从 done 改掉的那一次才退款，避免重复退款。
 *
 * @param {object} order shop_orders 行
 * @param {string} note 写入订单日志的备注（user_refund / admin_refund…）
 * @param {object} [opts]
 * @param {boolean} [opts.requireReclaimable] true = 只允许「背包物品还没用」的订单（用户自助退款）
 * @returns {Promise<{ok:boolean, reason?:string}>} reason：no_order / status / used / not_bag
 */
export async function refundDoneOrder(env, order, note = "refunded", { requireReclaimable = false } = {}) {
  if (!env.DB || !order) return { ok: false, reason: "no_order" };

  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM user_bag_items WHERE order_id = ?)                       AS total,
      (SELECT COUNT(*) FROM user_bag_items WHERE order_id = ? AND status = 'unused') AS unused
  `).bind(order.id, order.id).first();
  const hasBag = (Number(counts?.total) || 0) > 0;
  const hasUnused = (Number(counts?.unused) || 0) > 0;

  // 背包物品已经用掉：东西已经交付，不能退
  if (hasBag && !hasUnused) return { ok: false, reason: "used" };
  // 用户自助退款只支持背包订单；人工发放的订单要管理员确认
  if (!hasBag && requireReclaimable) return { ok: false, reason: "not_bag" };

  const upd = await env.DB.prepare(
    "UPDATE shop_orders SET status = 'refunded', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'done'"
  ).bind(order.id).run();
  if ((Number(upd?.meta?.changes) || 0) === 0) return { ok: false, reason: "status" };

  if (hasBag) {
    // 原子回收：万一这一瞬间用户正好点了「使用」，回滚订单状态，不产生「既退款又拿到东西」
    const reclaimed = await env.DB.prepare(
      "UPDATE user_bag_items SET status = 'refunded', used_at = CURRENT_TIMESTAMP WHERE order_id = ? AND status = 'unused'"
    ).bind(order.id).run();
    if ((Number(reclaimed?.meta?.changes) || 0) === 0) {
      await env.DB.prepare(
        "UPDATE shop_orders SET status = 'done', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'refunded'"
      ).bind(order.id).run();
      return { ok: false, reason: "used" };
    }
  }

  await refundPoint(env, order.user_key, order.price, `订单 ${order.order_no} 退款`);

  // 库存回滚（仅对「有限库存」的商品）
  const item = await env.DB.prepare("SELECT stock FROM shop_items WHERE id = ?").bind(order.item_id).first();
  if (item && Number(item.stock) >= 0) {
    await env.DB.prepare(
      "UPDATE shop_items SET stock = stock + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(order.item_id).run();
  }

  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'refunded', ?)"
  ).bind(order.id, String(note || "refunded")).run();

  return { ok: true };
}

/** 退款失败原因 → 给用户看的中文提示 */
function refundFailText(reason) {
  if (reason === "used") return "⚠️ 物品已经用过了，不能退款";
  if (reason === "not_bag") return "⚠️ 这个订单不支持自助退款，请联系管理员";
  return "⚠️ 订单状态已变更，请刷新后查看";
}

/**
 * 用户自助退款：仅限「自己的、已完成的、背包物品还没用的」订单。
 * 退款成功后物品退回库存、积分原路返还，并同步通知管理员。
 */
export async function handleUserRefundOrder(token, env, callback, userKey, orderId) {
  const order = await getOrderById(env, orderId);
  if (!order) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (order.user_key !== userKey) {
    return answerCallback(token, callback.id, "❌ 只能退自己的订单", true);
  }
  if (order.status !== "done") {
    return answerCallback(token, callback.id, "⚠️ 只有已完成的订单能在这里退款", true);
  }

  const res = await refundDoneOrder(env, order, "user_refund", { requireReclaimable: true });
  if (!res.ok) {
    return answerCallback(token, callback.id, refundFailText(res.reason), true);
  }

  await answerCallback(token, callback.id, `✅ 已退款 ${order.price} 积分`);

  try {
    await sendMessage(
      token, order.chat_id,
      `↩️ <b>订单已退款</b>\n-------------------------\n` +
      `🧾 订单号：<code>${order.order_no}</code>\n` +
      `${order.item_icon} 商品：${escapeHtml(order.item_name)}\n` +
      `💰 已退还 <b>${order.price}</b> 积分，背包里的物品已收回。`,
      "HTML"
    );
  } catch (_) {
    /* 通知失败不影响退款结果 */
  }

  // 同步提醒管理员（东西已收回，可能还要处理后续）
  try {
    const { resolveAdminChatId } = await import("./notify.js");
    const adminChat = resolveAdminChatId(env);
    if (adminChat) {
      await sendMessage(
        token, adminChat,
        `ℹ️ <b>用户自助退款</b>\n-------------------------\n` +
        `🧾 订单号：<code>${order.order_no}</code>\n` +
        `${order.item_icon} 商品：${escapeHtml(order.item_name)}\n` +
        `👤 用户 ID：<code>${order.user_id}</code>\n` +
        `💰 已自动退款 <b>${order.price}</b> 积分，未使用的背包物品已收回。`,
        "HTML"
      );
    }
  } catch (_) {
    /* 忽略 */
  }

  return true;
}

/** 管理员退款：已完成订单 → 退款（背包物品还没用的会自动收回） */
export async function actionRefund(token, env, callback, orderId, adminId = null) {
  const o = await getOrderById(env, orderId);
  if (!o) return answerCallback(token, callback.id, "❌ 订单不存在", true);

  if (o.status !== "done") {
    return answerCallback(token, callback.id, `⚠️ 当前状态 ${o.status}，无法退款`, true);
  }

  const res = await refundDoneOrder(env, o, "admin_refund");
  if (!res.ok) {
    return answerCallback(token, callback.id, refundFailText(res.reason), true);
  }

  try {
    await sendMessage(
      token, o.chat_id,
      `↩️ <b>订单已退款</b>\n-------------------------\n` +
      `🧾 订单号：<code>${o.order_no}</code>\n` +
      `${o.item_icon} 商品：${escapeHtml(o.item_name)}\n` +
      `💰 管理员已退还 <b>${o.price}</b> 积分。`,
      "HTML"
    );
  } catch (_) {}

  await logAdminAction(env, {
    adminId, chatId: callback.message?.chat?.id,
    action: "shop_order_refund", detail: `${o.order_no} ${o.item_name} 退款 ${o.price}`
  });

  await answerCallback(token, callback.id, "✅ 已退款");
}
