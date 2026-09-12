// ==========================================
// 🎒 商城 · 我的背包
//
// 发放方式为 bag 的商品下单后直接完成，物品进入这张「背包」，
// 用户自己挑时间使用（/bag 或商城首页 → 🎒 我的背包）。
//
// 使用效果由**下单时的快照**决定：
//   points  立刻兑换成积分（原子「先占物品再发分」，发分失败自动退回背包）
//   none    标记已使用 + 通知管理员核销
//
// 还没使用的物品可以随订单一起退款（见 actions.js 的 refundDoneOrder）。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { adjustPoints, logPointChange } from "../services/points.js";
import { getUserPoints } from "../services/users.js";
import { formatAppTime } from "../services/time.js";
import { logError } from "../core/logger.js";
import { USE_TYPE, useTypeOf, useValueOf } from "./delivery.js";

/** 背包每页件数（5 件 = 最多 5 行按钮 + 翻页 + 返回，不超过 8 行） */
export const BAG_PER_PAGE = 5;

// ==========================================
// 入库
// ==========================================

/**
 * 把一件商品放进用户背包（下单时调用）。
 * use_type / use_value 在这里快照下来，之后管理员改商品配置不影响已买到的物品。
 */
export async function addBagItem(env, { userKey, userId = "", item, orderId = 0, note = "" }) {
  if (!env?.DB || !userKey || !item) return false;
  await env.DB.prepare(`
    INSERT INTO user_bag_items
      (user_key, user_id, item_id, item_name, item_icon, order_id, status, use_type, use_value, note)
    VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?, ?)
  `).bind(
    String(userKey), String(userId || ""), Number(item.id) || 0,
    String(item.name || "商品"), String(item.icon || "🎁"),
    Number(orderId) || 0, useTypeOf(item), useValueOf(item), String(note || "")
  ).run();
  return true;
}

// ==========================================
// 读取
// ==========================================

/** 背包概览（未使用件数 / 已使用件数 / 总数） */
export async function getBagCounts(env, userKey) {
  if (!env?.DB) return { unused: 0, used: 0, total: 0 };
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM user_bag_items WHERE user_key = ? AND status = 'unused') AS unused,
      (SELECT COUNT(*) FROM user_bag_items WHERE user_key = ? AND status = 'used')   AS used,
      (SELECT COUNT(*) FROM user_bag_items WHERE user_key = ?)                       AS total
  `).bind(userKey, userKey, userKey).first();
  return {
    unused: Number(row?.unused) || 0,
    used: Number(row?.used) || 0,
    total: Number(row?.total) || 0
  };
}

/** 背包某一页（未使用的排在前面） */
export async function listBagItems(env, userKey, safePage, pageSize = BAG_PER_PAGE) {
  if (!env?.DB) return [];
  const { results } = await env.DB.prepare(`
    SELECT id, item_id, item_name, item_icon, order_id, status, use_type, use_value, obtained_at, used_at
      FROM user_bag_items
     WHERE user_key = ?
     ORDER BY CASE status WHEN 'unused' THEN 1 ELSE 2 END, id DESC
     LIMIT ? OFFSET ?
  `).bind(userKey, pageSize, pageOffset(safePage, pageSize)).all();
  return results || [];
}

// ==========================================
// 渲染
// ==========================================

/** 背包键盘（纯函数，便于排版测试）：未使用的物品各一行「使用」按钮 */
export function getBagKeyboard(items, safePage, totalPages) {
  const inline_keyboard = grid(
    (items || [])
      .filter((it) => it.status === "unused")
      .map((it) => ({
        text: compactLabel(`✅ 使用 ${it.item_icon}${it.item_name}`, 30),
        callback_data: `shop_bag_use_${it.id}_${safePage}`
      })),
    1
  );

  const navRow = pagerRow({ page: safePage, totalPages, prefix: "shop_bag_page_" });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回商城", callback_data: "shop_home" }]);
  return { inline_keyboard };
}

/**
 * 🎒 我的背包面板。
 * @param {object} [opts]
 * @param {string} [opts.notice] 顶部提示（例如「已兑换 100 积分」）
 */
export async function renderBag(token, env, chatId, userKey, messageId = null, page = 1, { notice = "" } = {}) {
  const fallback = "❌ 背包未启用（未绑定数据库）。";
  if (!env?.DB) {
    return messageId
      ? editMessageText(token, chatId, messageId, fallback)
      : sendMessage(token, chatId, fallback);
  }

  const counts = await getBagCounts(env, userKey);
  const totalPages = totalPagesOf(counts.total, BAG_PER_PAGE);
  const safePage = clampPage(page, totalPages);
  const items = await listBagItems(env, userKey, safePage);
  const pts = await getUserPoints(env, userKey);

  let text = `🎒 <b>我的背包</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  if (notice) text += `${notice}\n`;
  text += `🪙 <b>我的积分：</b> <code>${pts}</code>\n`;
  text += `📦 <b>未使用 ${counts.unused} 件 · 已使用 ${counts.used} 件</b>（共 ${counts.total} 件）\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>\n\n`;

  if (items.length === 0) {
    text += `<i>背包还是空的。去商城看看有没有能装进来的东西吧～</i>\n`;
  } else {
    for (const it of items) {
      const state = it.status === "unused"
        ? "🟢 未使用"
        : (it.status === "used" ? "⚪️ 已使用" : "↩️ 已退回");
      text += `${it.item_icon} <b>${escapeHtml(it.item_name)}</b> · ${state}\n`;
      if (it.status === "unused") {
        const effect = useTypeOf(it) === USE_TYPE.POINTS
          ? `使用后换成 🪙 ${useValueOf(it)} 积分`
          : "使用后由管理员核销";
        text += `　↳ ${effect}\n`;
        text += `　↳ 🕒 ${escapeHtml(formatAppTime(env, it.obtained_at))}\n`;
      } else {
        text += `　↳ 🕒 ${escapeHtml(formatAppTime(env, it.used_at || it.obtained_at))}\n`;
      }
    }
    text += `\n💡 还没使用的物品可以到「📜 我的订单」连同订单一起退款。\n`;
  }

  const keyboard = getBagKeyboard(items, safePage, totalPages);
  if (messageId) {
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ==========================================
// 使用
// ==========================================

/**
 * 使用一件背包物品。
 * 顺序：原子占用（unused → used）→ 按用法结算；积分发放失败会把物品退回背包。
 */
export async function handleUseBagItem({
  token, env, callback, chatId, userKey, messageId, bagId, page = 1
}) {
  if (!env?.DB) return answerCallback(token, callback.id, "❌ 背包未启用", true);

  const bag = await env.DB.prepare(
    "SELECT * FROM user_bag_items WHERE id = ?"
  ).bind(Number(bagId) || 0).first();

  if (!bag) return answerCallback(token, callback.id, "❌ 物品不存在", true);
  if (String(bag.user_key) !== String(userKey)) {
    return answerCallback(token, callback.id, "❌ 只能使用自己背包里的物品", true);
  }
  if (bag.status !== "unused") {
    await answerCallback(token, callback.id, "⚠️ 这件物品已经用过了", true);
    return renderBag(token, env, chatId, userKey, messageId, page, {
      notice: "⚠️ 这件物品已经用过了，背包已刷新。"
    });
  }

  // 原子占用：只有把状态从 unused 改掉的那一次才继续，避免连点重复发奖
  const claim = await env.DB.prepare(
    "UPDATE user_bag_items SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ? AND user_key = ? AND status = 'unused'"
  ).bind(bag.id, String(userKey)).run();

  if ((Number(claim?.meta?.changes) || 0) === 0) {
    await answerCallback(token, callback.id, "⚠️ 物品状态已变更，请刷新后重试", true);
    return renderBag(token, env, chatId, userKey, messageId, page);
  }

  const useType = useTypeOf(bag);
  const useValue = useValueOf(bag);

  // ---------- 用法一：立刻兑换成积分 ----------
  if (useType === USE_TYPE.POINTS && useValue > 0) {
    const after = await adjustPoints(env, userKey, useValue);
    if (after === null) {
      // 发分失败（用户记录不存在等）：把物品退回背包，别让用户白丢一件
      await env.DB.prepare(
        "UPDATE user_bag_items SET status = 'unused', used_at = NULL WHERE id = ?"
      ).bind(bag.id).run();
      await answerCallback(token, callback.id, "❌ 兑换失败，物品已退回背包", true);
      return renderBag(token, env, chatId, userKey, messageId, page, {
        notice: "❌ 兑换失败，物品已退回背包，请稍后再试。"
      });
    }

    await logPointChange(env, userKey, useValue, after, `使用背包物品 [${bag.item_name}] 兑换积分`);
    try {
      await env.DB.prepare(
        "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'bag_used', ?)"
      ).bind(Number(bag.order_id) || 0, `+${useValue}`).run();
    } catch (e) {
      logError("写背包使用日志失败：", e);
    }

    await answerCallback(token, callback.id, `✅ 已兑换 ${useValue} 积分`);
    return renderBag(token, env, chatId, userKey, messageId, page, {
      notice: `✅ 已使用 ${bag.item_icon} <b>${escapeHtml(bag.item_name)}</b>，兑换到 <b>${useValue}</b> 积分（当前 ${after}）。`
    });
  }

  // ---------- 用法二：仅核销（通知管理员处理）----------
  await answerCallback(token, callback.id, "✅ 已使用，等待管理员核销");
  try {
    await env.DB.prepare(
      "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'bag_used', 'manual')"
    ).bind(Number(bag.order_id) || 0).run();
  } catch (e) {
    logError("写背包使用日志失败：", e);
  }

  const result = await renderBag(token, env, chatId, userKey, messageId, page, {
    notice: `✅ 已使用 ${bag.item_icon} <b>${escapeHtml(bag.item_name)}</b>，已通知管理员核销。`
  });
  await notifyAdminBagUsed(token, env, bag);
  return result;
}

/** 通知管理员「有人用了一件要人工核销的背包物品」 */
async function notifyAdminBagUsed(token, env, bag) {
  try {
    const { resolveAdminChatId } = await import("./notify.js");
    const adminChat = resolveAdminChatId(env);
    if (!adminChat) return;
    await sendMessage(
      token, adminChat,
      `🎒 <b>背包物品待核销</b>\n${LAYOUT.DIVIDER}\n` +
      `${bag.item_icon} 物品：<b>${escapeHtml(bag.item_name)}</b>\n` +
      `👤 用户 ID：<code>${escapeHtml(String(bag.user_id || "未知"))}</code>\n` +
      `🗂️ 积分键：<code>${escapeHtml(String(bag.user_key || ""))}</code>\n` +
      (Number(bag.order_id) ? `🧾 订单行 ID：<code>${Number(bag.order_id)}</code>\n` : ``) +
      (bag.note ? `🧾 备注：${escapeHtml(bag.note)}\n` : ``) +
      `\n用户已在「🎒 我的背包」里点击使用，请核对后交付。`,
      "HTML"
    );
  } catch (e) {
    logError("通知管理员核销失败：", e);
  }
}
