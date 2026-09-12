// ==========================================
// 📜 群规执法面板（引导式编辑）
//
// 入口：管理控制台 → 📜 群规执法（群里打开），或在群里发 /guard、/rules
//
// 能做的事：
//   • 📝 编辑群规 / ➕ 追加一条 / 🧹 清空
//   • ⚖️ 设置默认处置方式（机器人封禁 / 踢出 / 群内封禁 / 禁言）
//   • ⏱️ 设置默认禁言时长
//   • ✅/🚫 一键开关执法
//   • 📜 查看最近处置记录（含待确认与已到期）
//
// 引导式输入的中间状态存在 guard_sessions，30 分钟过期。
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, clampPage, totalPagesOf, pageOffset, pagerRow, LAYOUT } from "../utils/layout.js";
import { ADMIN_CALLBACK } from "../config/constants.js";
import {
  ACTIONS, formatDuration, getGroupGuard, setGroupGuard, VIOLATION_RULES
} from "../services/guard.js";
import { kbStats } from "../services/knowledge.js";
import { logAdminAction } from "../services/admin-log.js";

const HISTORY_PER_PAGE = 5;
const SESSION_TTL_MINUTES = 30;
/** 默认禁言的候选时长（分钟） */
const MUTE_CHOICES = [10, 30, 60, 120, 1440, 0];

// ==========================================
// 引导会话
// ==========================================

async function getSession(env, chatId) {
  if (!env?.DB || !chatId) return null;
  return env.DB.prepare(
    `SELECT * FROM guard_sessions
     WHERE chat_id = ? AND updated_at >= datetime('now', '-${SESSION_TTL_MINUTES} minutes')`
  ).bind(chatId).first();
}

async function setSession(env, chatId, step) {
  await env.DB.prepare(`
    INSERT INTO guard_sessions (chat_id, step, draft, updated_at)
    VALUES (?, ?, '', CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET step = EXCLUDED.step, updated_at = CURRENT_TIMESTAMP
  `).bind(chatId, step).run();
}

async function clearSession(env, chatId) {
  await env.DB.prepare("DELETE FROM guard_sessions WHERE chat_id = ?").bind(chatId).run();
}

/** 管理员是否正在编辑群规（用于放行群里未 @ 的文本） */
export async function isGuardGuideActive(env, chatId) {
  if (!env?.DB) return false;
  return Boolean(await getSession(env, chatId));
}

/** 取消编辑 */
export async function cancelGuardGuide({ env, token, chatId }) {
  if (env.DB) await clearSession(env, chatId);
  return sendMessage(token, chatId, "🚫 已取消编辑群规。");
}

// ==========================================
// 面板
// ==========================================

/** 面板键盘（纯函数，便于排版测试） */
export function getGuardPanelKeyboard(settings) {
  const enabled = Number(settings.enabled) === 1;
  return {
    inline_keyboard: [
      ...grid([
        { text: "📝 编辑群规", callback_data: ADMIN_CALLBACK.GUARD_EDIT_RULES },
        { text: "➕ 追加一条", callback_data: ADMIN_CALLBACK.GUARD_APPEND_RULES }
      ]),
      ...grid([
        { text: "⚖️ 默认处置", callback_data: `${ADMIN_CALLBACK.GUARD_ACTION_PREFIX}menu` },
        { text: "⏱️ 默认禁言时长", callback_data: `${ADMIN_CALLBACK.GUARD_MUTE_PREFIX}menu` }
      ]),
      ...grid([
        { text: enabled ? "🚫 关闭执法" : "✅ 开启执法", callback_data: ADMIN_CALLBACK.GUARD_TOGGLE },
        { text: "🧹 清空群规", callback_data: ADMIN_CALLBACK.GUARD_CLEAR_RULES }
      ]),
      ...grid([
        { text: "📜 处置记录", callback_data: `${ADMIN_CALLBACK.GUARD_HISTORY_PREFIX}1` },
        { text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }
      ])
    ]
  };
}

/** 渲染群规面板（群里） */
export async function renderGuardPanel(token, env, chatId, messageId, uctx) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const isGroup = uctx?.chatType === "group" || uctx?.chatType === "supergroup";
  if (!isGroup) {
    const text =
      `📜 <b>群规执法</b>\n${LAYOUT.DIVIDER}\n` +
      `群规是<b>按群</b>设置的，请把机器人拉进目标群并设为管理员，然后在<b>群里</b>打开这个面板（或发送 <code>/guard</code>）。\n\n` +
      `💡 也可以先用 /setrules 在群里写入群规正文。`;
    return messageId
      ? editMessageText(token, chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] }, "HTML")
      : sendMessageWithKeyboard(token, chatId, text, { inline_keyboard: [[{ text: "🔙 返回主菜单", callback_data: ADMIN_CALLBACK.MAIN_MENU }]] }, "HTML");
  }

  const settings = await getGroupGuard(env, chatId);
  const stats = await kbStats(env, `group:${chatId}`);
  const action = ACTIONS[settings.default_action]?.short || settings.default_action;
  const categories = VIOLATION_RULES.length;

  let text = `📜 <b>群规执法</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `🔘 <b>执法开关：</b>${Number(settings.enabled) === 1 ? "✅ 已开启" : "🚫 已关闭"}\n`;
  text += `⚖️ <b>默认处置：</b>${action}${settings.default_action === "mute" ? `（${formatDuration(settings.default_mute_minutes)}）` : ""}\n`;
  text += `⏱️ <b>默认禁言：</b>${formatDuration(settings.default_mute_minutes)}\n`;
  text += `📚 <b>本群知识库：</b>${stats.docs} 篇（理由校验会用到）\n`;
  text += `📌 <b>可识别违规类型：</b>${categories} 类\n\n`;
  text += settings.rules
    ? `📝 <b>当前群规（${settings.rules.length} 字）：</b>\n${escapeHtml(settings.rules.slice(0, 600))}${settings.rules.length > 600 ? "…" : ""}`
    : `<i>还没有群规。点「📝 编辑群规」发送正文，或「➕ 追加一条」逐条添加。</i>`;

  const keyboard = getGuardPanelKeyboard(settings);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 默认处置方式选择键盘 */
function actionPickerKeyboard(current) {
  const items = ["bot_ban", "kick", "group_ban", "mute"].map((key) => ({
    text: `${key === current ? "✅ " : ""}${ACTIONS[key].short}`,
    callback_data: `${ADMIN_CALLBACK.GUARD_ACTION_PREFIX}${key}`
  }));
  return {
    inline_keyboard: [...grid(items), [{ text: "🔙 返回群规面板", callback_data: ADMIN_CALLBACK.GUARD_HOME }]]
  };
}

/** 默认禁言时长选择键盘 */
function mutePickerKeyboard(current) {
  const items = MUTE_CHOICES.map((min) => ({
    text: `${min === Number(current) ? "✅ " : ""}${formatDuration(min)}`,
    callback_data: `${ADMIN_CALLBACK.GUARD_MUTE_PREFIX}${min}`
  }));
  return {
    inline_keyboard: [...grid(items), [{ text: "🔙 返回群规面板", callback_data: ADMIN_CALLBACK.GUARD_HOME }]]
  };
}

/** 处置记录键盘（纯函数，便于排版测试） */
export function getGuardHistoryKeyboard(rows, safePage, totalPages) {
  const inline_keyboard = [];
  const navRow = pagerRow({ page: safePage, totalPages, prefix: ADMIN_CALLBACK.GUARD_HISTORY_PREFIX });
  if (navRow) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回群规面板", callback_data: ADMIN_CALLBACK.GUARD_HOME }]);
  return { inline_keyboard };
}

/** 状态 → 文案 */
const STATUS_TEXT = {
  pending: "⏳ 待确认",
  done: "✅ 已执行",
  cancelled: "🚫 已取消",
  rejected: "❌ 理由不成立",
  failed: "⚠️ 执行失败",
  expired: "⌛ 已到期"
};

/** 渲染处置记录（分页） */
export async function renderGuardHistory(token, env, chatId, messageId, page = 1) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库。");

  const countRes = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM group_punishments WHERE chat_id = ?"
  ).bind(String(chatId)).first();
  const total = Number(countRes?.n) || 0;
  const totalPages = totalPagesOf(total, HISTORY_PER_PAGE);
  const safePage = clampPage(page, totalPages);

  const { results } = await env.DB.prepare(
    `SELECT * FROM group_punishments WHERE chat_id = ?
     ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(String(chatId), HISTORY_PER_PAGE, pageOffset(safePage, HISTORY_PER_PAGE)).all();

  let text = `📜 <b>群规处置记录</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 条）\n`;
  text += `${LAYOUT.DIVIDER}\n\n`;

  const rows = results || [];
  if (rows.length === 0) {
    text += `<i>还没有处置记录。</i>`;
  } else {
    for (const row of rows) {
      const action = ACTIONS[row.action]?.short || row.action;
      text += `${STATUS_TEXT[row.status] || row.status} · <b>${action}</b>`;
      if (row.action === "mute" && Number(row.duration_min) > 0) text += `（${formatDuration(row.duration_min)}）`;
      text += `\n`;
      text += `👤 ${escapeHtml(row.user_label || row.user_id)} · 📌 ${escapeHtml(row.reason || "（无理由）")}\n`;
      text += `🕒 ${escapeHtml(row.created_at || "")} · 👑 <code>${escapeHtml(row.operator_id || "")}</code>\n\n`;
    }
  }

  const keyboard = getGuardHistoryKeyboard(rows, safePage, totalPages);
  return messageId
    ? editMessageText(token, chatId, messageId, text, keyboard, "HTML")
    : sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 面板内的回调分发（admin_guard_*） */
export async function handleGuardPanelCallback({ env, token, callback, chatId, msgId, data, uctx, adminId = null }) {
  if (!env.DB) return;

  // ---------- 回到面板 ----------
  if (data === ADMIN_CALLBACK.GUARD_HOME) {
    await answerCallback(token, callback.id, "群规执法");
    await renderGuardPanel(token, env, chatId, msgId, uctx);
    return;
  }

  // ---------- 编辑 / 追加群规 ----------
  if (data === ADMIN_CALLBACK.GUARD_EDIT_RULES || data === ADMIN_CALLBACK.GUARD_APPEND_RULES) {
    const append = data === ADMIN_CALLBACK.GUARD_APPEND_RULES;
    await setSession(env, chatId, append ? "rules:append" : "rules:replace");
    await answerCallback(token, callback.id, append ? "请发送要追加的内容" : "请发送新的群规正文");
    await sendMessage(
      token, chatId,
      append
        ? `➕ <b>追加群规</b>\n${LAYOUT.DIVIDER}\n请发送要追加的一条群规（会加在现有群规后面）：\n\n（回复 <code>/cancel</code> 放弃）`
        : `📝 <b>编辑群规</b>\n${LAYOUT.DIVIDER}\n请把<b>完整的群规正文</b>发过来（会覆盖现有内容）：\n\n（回复 <code>/cancel</code> 放弃）`,
      "HTML"
    );
    return;
  }

  // ---------- 清空群规 ----------
  if (data === ADMIN_CALLBACK.GUARD_CLEAR_RULES) {
    await setGroupGuard(env, chatId, { rules: "" });
    await logAdminAction(env, { adminId, chatId, action: "guard_set_rules", detail: "清空群规" });
    await answerCallback(token, callback.id, "已清空群规");
    await renderGuardPanel(token, env, chatId, msgId, uctx);
    return;
  }

  // ---------- 开关执法 ----------
  if (data === ADMIN_CALLBACK.GUARD_TOGGLE) {
    const settings = await getGroupGuard(env, chatId);
    const next = Number(settings.enabled) !== 1;
    await setGroupGuard(env, chatId, { enabled: next });
    await logAdminAction(env, {
      adminId, chatId, action: "guard_toggle", detail: next ? "开启执法" : "关闭执法"
    });
    await answerCallback(token, callback.id, next ? "✅ 已开启执法" : "🚫 已关闭执法");
    await renderGuardPanel(token, env, chatId, msgId, uctx);
    return;
  }

  // ---------- 默认处置 ----------
  if (data.startsWith(ADMIN_CALLBACK.GUARD_ACTION_PREFIX)) {
    const value = data.replace(ADMIN_CALLBACK.GUARD_ACTION_PREFIX, "");
    const settings = await getGroupGuard(env, chatId);

    if (value === "menu") {
      await answerCallback(token, callback.id, "选择默认处置方式");
      await editMessageText(
        token, chatId, msgId,
        `⚖️ <b>默认处置方式</b>\n${LAYOUT.DIVIDER}\n` +
        `管理员下指令但没指明处置方式时，默认用哪一种：\n\n` +
        Object.entries(ACTIONS)
          .filter(([key]) => ["bot_ban", "kick", "group_ban", "mute"].includes(key))
          .map(([key, v]) => `• <b>${v.short}</b>：${key === "bot_ban" ? "机器人停止服务该用户（不需要群权限）" : key === "kick" ? "移出群，可重新加入" : key === "group_ban" ? "移出且不能重新加入" : "限制发言"}`)
          .join("\n"),
        actionPickerKeyboard(settings.default_action), "HTML"
      );
      return;
    }

    if (ACTIONS[value]) {
      await setGroupGuard(env, chatId, { defaultAction: value });
      await logAdminAction(env, { adminId, chatId, action: "guard_default_action", detail: value });
      await answerCallback(token, callback.id, `默认处置：${ACTIONS[value].short}`);
      await renderGuardPanel(token, env, chatId, msgId, uctx);
      return;
    }
  }

  // ---------- 默认禁言时长 ----------
  if (data.startsWith(ADMIN_CALLBACK.GUARD_MUTE_PREFIX)) {
    const value = data.replace(ADMIN_CALLBACK.GUARD_MUTE_PREFIX, "");
    const settings = await getGroupGuard(env, chatId);

    if (value === "menu") {
      await answerCallback(token, callback.id, "选择默认禁言时长");
      await editMessageText(
        token, chatId, msgId,
        `⏱️ <b>默认禁言时长</b>\n${LAYOUT.DIVIDER}\n` +
        `下指令时没写时长就用这个（当前：<b>${formatDuration(settings.default_mute_minutes)}</b>）。`,
        mutePickerKeyboard(settings.default_mute_minutes), "HTML"
      );
      return;
    }

    const minutes = Number.parseInt(value, 10);
    if (Number.isInteger(minutes) && minutes >= 0) {
      await setGroupGuard(env, chatId, { defaultMuteMinutes: minutes });
      await logAdminAction(env, {
        adminId, chatId, action: "guard_default_mute", detail: formatDuration(minutes)
      });
      await answerCallback(token, callback.id, `默认禁言：${formatDuration(minutes)}`);
      await renderGuardPanel(token, env, chatId, msgId, uctx);
      return;
    }
  }

  // ---------- 处置记录 ----------
  if (data.startsWith(ADMIN_CALLBACK.GUARD_HISTORY_PREFIX)) {
    const page = Number.parseInt(data.replace(ADMIN_CALLBACK.GUARD_HISTORY_PREFIX, ""), 10) || 1;
    await answerCallback(token, callback.id, `处置记录第 ${page} 页`);
    await renderGuardHistory(token, env, chatId, msgId, page);
    return;
  }

  await answerCallback(token, callback.id, "⚠️ 未知操作", true);
}

/**
 * 引导式文本输入：编辑群规 / 追加群规。
 * @returns {Promise<boolean>} 是否已消费这条消息
 */
export async function handleGuardGuideInput({ env, token, chatId, userText, uctx, adminId = null }) {
  if (!env.DB) return false;

  const session = await getSession(env, chatId);
  if (!session) return false;

  const text = String(userText || "").trim();
  if (!text) return true;

  const step = String(session.step || "");
  if (step !== "rules:replace" && step !== "rules:append") {
    await clearSession(env, chatId);
    return false;
  }

  const settings = await getGroupGuard(env, chatId);
  const body = text.slice(0, 2000);

  let rules;
  if (step === "rules:append") {
    rules = settings.rules ? `${settings.rules}\n${body}` : body;
  } else {
    rules = body;
  }

  await setGroupGuard(env, chatId, { rules });
  await clearSession(env, chatId);
  await logAdminAction(env, {
    adminId, chatId, action: "guard_set_rules",
    detail: `${step === "rules:append" ? "追加" : "覆盖"} ${body.length} 字`
  });

  await sendMessage(
    token, chatId,
    `✅ <b>群规已更新</b>\n${LAYOUT.DIVIDER}\n` +
    `📝 当前共 ${rules.length} 字\n\n` +
    `执法时会把理由与群规逐句比对。`,
    "HTML"
  );
  await renderGuardPanel(token, env, chatId, null, uctx);
  return true;
}
