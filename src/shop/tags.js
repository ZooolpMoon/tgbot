// ==========================================
// 🏷️ 商城 · 自定义群组标签（引导式流程）
//
// 商品「自定义群组标签」的发放方式：下单即完成，不需要管理员发货；
// 用户自己选一个「机器人所在的群」→ 发送想要的个人标签 → 机器人直接设置。
//
//   购买 → 选群（按钮）→ 发标签（纯文本）→ setChatMemberTag 生效
//
// 会话状态在 group_tag_sessions（30 分钟过期 + 定时任务兜底清理），
// 过期/放弃后可以从「📜 我的订单」重新进入，钱不会白花。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, compactLabel, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { logError } from "../core/logger.js";
import { clearGuideSessions } from "../services/sessions.js";
import {
  TAG_CLEAR_INPUT, TAG_MAX_LENGTH, applyMemberTag, fillGroupTitles, getAppliedTag,
  getBotTagRights, listTagGroups, validateTagText
} from "../services/group-tags.js";

/** 引导会话有效期（和其它流程一致：30 分钟） */
const SESSION_TTL_MINUTES = 30;

/** 群列表每页多少个（两列一行 → 5 行，加翻页与放弃按钮不超过 8 行） */
const GROUPS_PER_PAGE = 10;

// ==========================================
// 会话读写
// ==========================================

/** 读当前会话（带 30 分钟有效期） */
export async function getTagSession(env, chatId) {
  if (!env?.DB) return null;
  try {
    return await env.DB.prepare(
      `SELECT * FROM group_tag_sessions
        WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
    ).bind(String(chatId)).first();
  } catch (e) {
    logError("读取群标签会话失败：", e);
    return null;
  }
}

/** 写一条会话（同一个会话只保留一条） */
async function saveTagSession(env, { chatId, userId, orderId, itemId, step, targetChat = "" }) {
  await env.DB.prepare(`
    INSERT INTO group_tag_sessions (chat_id, user_id, order_id, item_id, step, target_chat, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = EXCLUDED.user_id, order_id = EXCLUDED.order_id, item_id = EXCLUDED.item_id,
      step = EXCLUDED.step, target_chat = EXCLUDED.target_chat, updated_at = CURRENT_TIMESTAMP
  `).bind(
    String(chatId), String(userId), Math.floor(orderId) || 0, Math.floor(itemId) || 0,
    String(step), String(targetChat || "")
  ).run();
}

/** 结束会话（设置完成 / 用户放弃都走它） */
export async function clearTagSession(env, chatId) {
  if (!env?.DB) return;
  await env.DB.prepare("DELETE FROM group_tag_sessions WHERE chat_id = ?").bind(String(chatId)).run();
}

// ==========================================
// 选群
// ==========================================

/** 群列表键盘（纯函数，便于排版测试）：两列网格 + 翻页 + 放弃 */
export function getTagGroupKeyboard(groups, safePage, totalPages) {
  const inline_keyboard = grid(
    groups.map((g) => ({
      text: compactLabel(`🏷️ ${g.title}`, 30),
      callback_data: `shop_tag_grp_${g.chatId}`
    }))
  );
  const navRow = pagerRow({ page: safePage, totalPages, prefix: "shop_tag_page_" });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "❌ 放弃设置", callback_data: "shop_tag_cancel" }]);
  return { inline_keyboard };
}

/**
 * 渲染「选群」面板。
 * @param {object} [opts]
 * @param {string} [opts.warning] 顶部提示（比如上次选的群没权限）
 */
export async function renderTagGroupPicker(token, env, chatId, messageId, session, { page = 1, warning = "" } = {}) {
  const order = await env.DB.prepare(
    "SELECT order_no FROM shop_orders WHERE id = ?"
  ).bind(Number(session.order_id) || 0).first();

  const all = await fillGroupTitles(token, env, await listTagGroups(env, session.user_id));
  const usable = all.filter((g) => !g.gone);
  const hidden = all.length - usable.length;

  const totalPages = totalPagesOf(usable.length, GROUPS_PER_PAGE);
  const safePage = clampPage(page, totalPages);
  const slice = usable.slice(pageOffset(safePage, GROUPS_PER_PAGE), pageOffset(safePage, GROUPS_PER_PAGE) + GROUPS_PER_PAGE);

  let text = `🏷️ <b>自定义群组标签 · 选择群组</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  if (order?.order_no) text += `🧾 <b>订单：</b> <code>${escapeHtml(order.order_no)}</code> ✅ 已完成\n`;
  text += `⏳ <b>有效期：</b> ${SESSION_TTL_MINUTES} 分钟内完成设置（过期后到「📜 我的订单」重新进入）\n`;
  if (warning) text += `\n⚠️ ${warning}\n`;

  if (usable.length === 0) {
    text += `\n<i>机器人目前不在任何群里，暂时没法设置标签。可以把机器人拉进群并设为管理员后再来。</i>`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 返回商城", callback_data: "shop_home" }]] };
    return messageId
      ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
      : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
  }

  text += `\n请选择要把<b>你的人标签</b>设置在哪个群：\n`;
  text += `• 只能选机器人是管理员、且有「管理标签」权限的群\n`;
  text += `• 标签 ${1}~${TAG_MAX_LENGTH} 字，不支持 emoji\n`;
  if (hidden > 0) text += `• 另有 ${hidden} 个群机器人已经不在，已隐藏\n`;

  const keyboard = getTagGroupKeyboard(slice, safePage, totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/**
 * 开始（或重新开始）某个订单的标签流程：清掉其它引导会话 → 记会话 → 渲染选群。
 */
export async function startTagFlow({ token, env, chatId, userId, orderId, itemId = 0, messageId = null }) {
  await clearGuideSessions(env, chatId);
  await saveTagSession(env, {
    chatId, userId, orderId, itemId, step: "group", targetChat: ""
  });
  const session = await getTagSession(env, chatId);
  return renderTagGroupPicker(token, env, chatId, messageId, session, { page: 1 });
}

/** 用户点了某个群：查权限 → 进入「等标签文字」 */
export async function handleTagGroupPick({ token, env, callback, chatId, messageId, groupChatId }) {
  const session = await getTagSession(env, chatId);
  if (!session) {
    await answerCallback(token, callback.id, "⌛️ 这次设置已经过期，请到「我的订单」重新进入", true);
    return;
  }

  const rights = await getBotTagRights(token, env, groupChatId);
  if (!rights.canManageTags) {
    await answerCallback(token, callback.id, "⚠️ 机器人在这个群没有「管理标签」权限", true);
    await renderTagGroupPicker(token, env, chatId, messageId, session, {
      warning: "机器人在你选的群里还不是管理员，或者没有勾选「管理标签」权限，换一个群试试。"
    });
    return;
  }

  await saveTagSession(env, {
    chatId, userId: session.user_id, orderId: session.order_id, itemId: session.item_id,
    step: "tag", targetChat: groupChatId
  });
  const titleRow = await env.DB.prepare(
    "SELECT title FROM bot_chats WHERE chat_id = ?"
  ).bind(String(groupChatId)).first();
  const title = String(titleRow?.title || `群 ${groupChatId}`);
  const current = await getAppliedTag(env, groupChatId, session.user_id);

  await answerCallback(token, callback.id, `已选择：${title}`);

  const text =
    `🏷️ <b>设置你的群标签</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `👥 <b>群组：</b> ${escapeHtml(title)}\n` +
    `🏷️ <b>当前标签：</b> ${current?.tag ? escapeHtml(current.tag) : "（无）"}\n\n` +
    `请直接发送你想显示的标签（<b>${1}~${TAG_MAX_LENGTH} 字</b>，不支持 emoji）。\n` +
    `• 回复 <code>${TAG_CLEAR_INPUT}</code> 清除该群标签\n` +
    `• 回复 <code>/cancel</code> 放弃设置（之后可在「📜 我的订单」重新进入）`;

  const keyboard = { inline_keyboard: [[{ text: "❌ 放弃设置", callback_data: "shop_tag_cancel" }]] };
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

// ==========================================
// 收标签文字
// ==========================================

/**
 * 处理引导流程里的纯文本（message.js 调用）。
 * @returns {Promise<boolean>} true = 已消费这条消息
 */
export async function handleTagInput({ token, env, chatId, uctx, userText }) {
  if (!env?.DB) return false;
  const session = await getTagSession(env, chatId);
  if (!session) return false;
  // 只认下单人自己的输入（私聊会话，这里再兜一层）
  if (String(session.user_id) !== String(uctx?.userId || "")) return false;
  // 还在「选群」这一步：用户发的是文字，提醒他点按钮
  if (session.step !== "tag") {
    await sendMessage(
      token, chatId,
      "🏷️ 请先点上方的<b>群组按钮</b>选择要设置的群（回复 <code>/cancel</code> 可以放弃）。",
      "HTML"
    );
    return true;
  }

  const checked = validateTagText(userText);
  if (!checked.ok) {
    await sendMessage(
      token, chatId,
      `⚠️ ${escapeHtml(checked.error)}\n请重新发送，或回复 /cancel 放弃。`,
      "HTML"
    );
    return true;
  }

  const rights = await getBotTagRights(token, env, session.target_chat);
  if (!rights.canManageTags) {
    await sendMessage(
      token, chatId,
      "⚠️ 机器人现在没有那个群的「管理标签」权限，标签没能设置。\n" +
      "请让群管理员把机器人设为管理员并勾选『管理标签』，或回复 /cancel 换一个群。",
      "HTML"
    );
    return true;
  }

  const result = await applyMemberTag({
    env, token, chatId: session.target_chat, userId: session.user_id,
    tag: checked.tag, orderId: session.order_id
  });
  if (!result.ok) {
    await sendMessage(
      token, chatId,
      `⚠️ ${escapeHtml(result.error)}\n\n请重新发送标签，或回复 /cancel 放弃。`,
      "HTML"
    );
    return true;
  }

  await clearTagSession(env, chatId);
  await env.DB.prepare(
    "INSERT INTO shop_order_log (order_id, action, note) VALUES (?, 'tag_set', ?)"
  ).bind(Number(session.order_id) || 0, `${session.target_chat}:${checked.tag || "（清空）"}`).run();

  const titleRow = await env.DB.prepare(
    "SELECT title FROM bot_chats WHERE chat_id = ?"
  ).bind(String(session.target_chat)).first();
  const title = String(titleRow?.title || `群 ${session.target_chat}`);

  const keyboard = {
    inline_keyboard: [
      [{ text: "📜 我的订单", callback_data: "shop_orders_1" }],
      [{ text: "🔙 返回商城", callback_data: "shop_home" }]
    ]
  };
  await sendMessageWithKeyboard(
    token, chatId,
    `✅ <b>标签已设置</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `👥 <b>群组：</b> ${escapeHtml(title)}\n` +
    `🏷️ <b>标签：</b> ${checked.tag ? escapeHtml(checked.tag) : "（已清除）"}\n\n` +
    `在群里发一条消息就能看到你的标签。想改的话再买一次，或到「📜 我的订单」重新进入。`,
    keyboard, "HTML"
  );
  return true;
}

/** 用户点「放弃设置」/回复 /cancel */
export async function handleTagCancel({ token, env, callback = null, chatId, messageId = null }) {
  await clearTagSession(env, chatId);
  if (callback) await answerCallback(token, callback.id, "已放弃设置");
  const text =
    `🚫 <b>已放弃设置</b>\n${LAYOUT.DIVIDER}\n` +
    `订单仍然有效，随时可以到「📜 我的订单」重新进入设置。`;
  const keyboard = { inline_keyboard: [[{ text: "📜 我的订单", callback_data: "shop_orders_1" }]] };
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 从「我的订单」重新进入：校验订单归属与商品类型 */
export async function handleTagOrderEntry({ token, env, callback, chatId, userKey, userId, messageId, orderId }) {
  const order = await env.DB.prepare(
    `SELECT o.id, o.order_no, o.item_id, o.status, o.user_key, o.user_id, i.delivery
       FROM shop_orders o LEFT JOIN shop_items i ON i.id = o.item_id
      WHERE o.id = ?`
  ).bind(Number(orderId) || 0).first();

  if (!order || String(order.user_key) !== String(userKey)) {
    await answerCallback(token, callback.id, "❌ 订单不存在", true);
    return;
  }
  if (String(order.delivery || "manual") !== "group_tag") {
    await answerCallback(token, callback.id, "❌ 这个订单不是群标签商品", true);
    return;
  }
  if (order.status !== "done") {
    await answerCallback(token, callback.id, "⚠️ 订单还没完成，无法设置标签", true);
    return;
  }

  await answerCallback(token, callback.id, "开始设置标签");
  await startTagFlow({
    token, env, chatId, userId: order.user_id || userId,
    orderId: order.id, itemId: order.item_id, messageId
  });
}
