// ==========================================
// ⏱️ 发送频率
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { parseRateLimit } from "../services/users.js";
import { logAdminAction } from "../services/admin-log.js";

/** 冷却时间快捷设置键盘（两列网格，0 秒 = 不限制） */
export function getUserRateKeyboard(rowId) {
  return {
    inline_keyboard: [
      ...grid([
        { text: "无限制 (0秒)", callback_data: `admin_setrate_${rowId}_0` },
        { text: "3 秒", callback_data: `admin_setrate_${rowId}_3` },
        { text: "5 秒", callback_data: `admin_setrate_${rowId}_5` },
        { text: "10 秒", callback_data: `admin_setrate_${rowId}_10` },
        { text: "30 秒", callback_data: `admin_setrate_${rowId}_30` },
        { text: "60 秒", callback_data: `admin_setrate_${rowId}_60` }
      ]),
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]
    ]
  };
}

/** 渲染某个场景的发送频率面板 */
export async function renderUserRateMenu(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT scene_key, rate_limit_sec FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return;
  const currentRate = parseRateLimit(scene.rate_limit_sec);

  const text =
    `⏱️ <b>场景发送频率设置</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `🔢 <b>场景行 ID:</b> <code>${rowId}</code>\n` +
    `🧩 <b>场景键:</b> <code>${escapeHtml(scene.scene_key)}</code>\n` +
    `⏳ <b>当前冷却间隔:</b> ${currentRate} 秒/条\n\n` +
    `只影响该场景：`;

  return editMessageText(token, chatId, messageId, text, getUserRateKeyboard(rowId), "HTML");
}

/** 处理冷却时间设置回调（sec 必须是非负整数） */
export async function handleSetRate({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const raw = data.replace("admin_setrate_", "");
  const sepIndex = raw.indexOf("_");
  const rowId = parseInt(sepIndex === -1 ? raw : raw.substring(0, sepIndex), 10);
  const rateValue = sepIndex === -1 ? "" : raw.substring(sepIndex + 1);
  const sec = Number.parseInt(rateValue, 10);

  if (!env.DB || !Number.isInteger(rowId)) return;
  if (!Number.isInteger(sec) || sec < 0) {
    await answerCallback(token, callback.id, "❌ 无效的冷却时间参数", true);
    await renderUserRateMenu(token, env, chatId, msgId, rowId);
    return;
  }

  await env.DB.prepare("UPDATE user_scenes SET rate_limit_sec = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(sec, rowId).run();
  await logAdminAction(env, {
    adminId, chatId, action: "scene_rate_mod",
    detail: `场景 #${rowId} 冷却 → ${sec} 秒`
  });
  await answerCallback(token, callback.id, `✅ 冷却时间设置为: ${sec} 秒`);
  await renderUserRateMenu(token, env, chatId, msgId, rowId);
}
