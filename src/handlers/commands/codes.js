// ==========================================
// 🎟️ 兑换码管理（管理员）
//   /code_new <积分> [次数] [有效天数]
//   /code_list            —— 也可从管理控制台进入
// ==========================================

import { sendMessage, sendMessageWithKeyboard, editMessageText, answerCallback } from "../../telegram/api.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { createRedeemCode, listRedeemCodes, setRedeemCodeEnabled } from "../../services/redeem.js";
import { logAdminAction } from "../../services/admin-log.js";
import { escapeHtml } from "../../utils/html.js";
import { ADMIN_CALLBACK } from "../../config/constants.js";

const USAGE =
  "🎟️ <b>生成兑换码</b>\n-------------------------\n" +
  "用法：<code>/code_new &lt;积分&gt; [次数] [有效天数]</code>\n\n" +
  "• 次数省略=1（每人限兑一次）；填 <code>0</code> 表示不限次数\n" +
  "• 有效天数省略=永久生效\n\n" +
  "示例：\n" +
  "<code>/code_new 100</code> —— 100 积分，限 1 人，永久\n" +
  "<code>/code_new 50 20 7</code> —— 50 积分，限 20 次，7 天有效";

export async function cmdCodeNew({ env, ctx, token, chatId, isGroupCtx, rawText, myId }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const args = String(rawText || "")
    .replace(/^\/code_new(@\w+)?/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    await sendAutoDelete(token, chatId, USAGE, "HTML", isGroupCtx, ctx);
    return;
  }

  const points = Number.parseInt(args[0], 10);
  const maxUses = args[1] === undefined ? 1 : Number.parseInt(args[1], 10);
  const validDays = args[2] === undefined ? 0 : Number.parseInt(args[2], 10);

  if (!Number.isInteger(points) || !Number.isInteger(maxUses) || !Number.isInteger(validDays) ||
      points <= 0 || maxUses < 0 || validDays < 0) {
    await sendAutoDelete(token, chatId, `⚠️ 参数不合法。\n\n${USAGE}`, "HTML", isGroupCtx, ctx);
    return;
  }

  const res = await createRedeemCode(env, { points, maxUses, validDays, createdBy: myId });
  if (!res.ok) {
    await sendAutoDelete(token, chatId, `❌ ${res.error}`, null, isGroupCtx, ctx);
    return;
  }

  const scope = res.maxUses === 0 ? "不限次数" : `限 ${res.maxUses} 次`;
  const expiry = res.expiresAt ? `有效期至 ${res.expiresAt}` : "永久有效";

  await sendMessage(
    token, chatId,
    `✅ <b>兑换码已生成</b>\n` +
    `-------------------------\n` +
    `🎟️ <code>${res.code}</code>\n` +
    `🎁 面额：<b>${res.points}</b> 积分\n` +
    `🔢 使用：${scope}（每人限兑一次）\n` +
    `📅 ${expiry}\n\n` +
    `用户私聊发送 <code>/redeem ${res.code}</code> 即可领取。`,
    "HTML"
  );

  await logAdminAction(env, {
    adminId: myId, chatId, action: "redeem_code_create",
    detail: `${res.code} ${res.points} 分 ${scope} ${expiry}`
  });
}

// ---------- 列表 ----------
export async function renderCodeList(token, env, chatId, messageId = null, page = 1) {
  if (!env.DB) {
    const text = "❌ 未绑定数据库。";
    return messageId ? editMessageText(token, chatId, messageId, text) : sendMessage(token, chatId, text);
  }

  const { rows, total, totalPages, page: safePage } = await listRedeemCodes(env, page);
  const today = new Date().toISOString().slice(0, 10);

  let text = `🎟️ <b>兑换码</b>\n`;
  text += `页码：<b>${safePage} / ${totalPages}</b>（共 ${total} 个）\n`;
  text += `-------------------------\n\n`;

  const inline_keyboard = [];
  const pendingToggles = [];

  if (rows.length === 0) {
    text += `<i>还没有兑换码。用 /code_new &lt;积分&gt; [次数] [有效天数] 生成一个。</i>\n`;
  } else {
    for (const row of rows) {
      const expired = row.expires_at && String(row.expires_at) < today;
      const state = Number(row.enabled) === 1 ? (expired ? "⌛️ 已过期" : "✅ 生效中") : "🚫 已停用";
      const quota = Number(row.max_uses) === 0 ? `${row.used_count}/∞` : `${row.used_count}/${row.max_uses}`;
      text += `🎟️ <code>${escapeHtml(row.code)}</code>\n`;
      text += `    🎁 ${row.points} 分 · 🔢 ${quota} · ${state}${row.expires_at ? ` · 📅 ${row.expires_at}` : ""}\n\n`;

      pendingToggles.push({
        text: `${Number(row.enabled) === 1 ? "🚫" : "✅"} …${String(row.code).slice(-6)}`,
        callback_data: `${ADMIN_CALLBACK.CODE_TOGGLE_PREFIX}${row.id}`
      });
    }
  }

  // 两列网格：一排两个开关按钮
  for (let i = 0; i < pendingToggles.length; i += 2) {
    inline_keyboard.push(pendingToggles.slice(i, i + 2));
  }

  const navRow = [];
  if (safePage > 1) navRow.push({ text: "⬅️ 上一页", callback_data: `${ADMIN_CALLBACK.CODES_PREFIX}${safePage - 1}` });
  if (safePage < totalPages) navRow.push({ text: "下一页 ➡️", callback_data: `${ADMIN_CALLBACK.CODES_PREFIX}${safePage + 1}` });
  if (navRow.length > 0) inline_keyboard.push(navRow);
  inline_keyboard.push([{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]);

  const keyboard = { inline_keyboard };
  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

export async function cmdCodeList({ env, ctx, token, chatId, isGroupCtx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }
  await renderCodeList(token, env, chatId, null, 1);
}

// ---------- 启用 / 停用 ----------
export async function handleCodeToggle({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const codeId = Number.parseInt(String(data).replace(ADMIN_CALLBACK.CODE_TOGGLE_PREFIX, ""), 10);
  if (!env.DB || !Number.isInteger(codeId)) return;

  const row = await env.DB.prepare("SELECT code, enabled FROM redeem_codes WHERE id = ?").bind(codeId).first();
  if (!row) {
    await answerCallback(token, callback.id, "❌ 兑换码不存在", true);
    return;
  }

  const next = Number(row.enabled) === 1 ? false : true;
  await setRedeemCodeEnabled(env, codeId, next);

  await logAdminAction(env, {
    adminId, chatId,
    action: next ? "redeem_code_enable" : "redeem_code_disable",
    detail: row.code
  });

  await answerCallback(token, callback.id, next ? "✅ 已启用" : "🚫 已停用");
  await renderCodeList(token, env, chatId, msgId, 1);
}
