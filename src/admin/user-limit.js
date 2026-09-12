// ==========================================
// 📅 每日限额
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { escapeHtml } from "../utils/html.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { getDateKey } from "../services/time.js";
import { parseMaxDaily } from "../services/users.js";
import { logAdminAction } from "../services/admin-log.js";

/**
 * 限额调整键盘（两列网格）。
 * -1 表示不限制，"重置今日使用计数" 只清空当天已用额度。
 */
export function getUserLimitKeyboard(rowId) {
  return {
    inline_keyboard: [
      ...grid([
        { text: "+10 上限", callback_data: `admin_modlimit_${rowId}_10` },
        { text: "-10 上限", callback_data: `admin_modlimit_${rowId}_-10` },
        { text: "不限制", callback_data: `admin_modlimit_${rowId}_unlimited` },
        { text: "🔄 重置今日已用", callback_data: `admin_modlimit_${rowId}_reset_used` }
      ]),
      [{ text: "🔙 返回场景编辑", callback_data: `admin_manage_user_${rowId}` }]
    ]
  };
}

/** 渲染某个场景的每日限额面板 */
export async function renderUserLimitMenu(token, env, chatId, messageId, rowId) {
  if (!env.DB) return;
  const scene = await env.DB.prepare("SELECT scene_key, max_daily FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) return;

  const todayStr = getDateKey(env);
  const dailyRow = await env.DB.prepare(
    "SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?"
  ).bind(scene.scene_key, todayStr).first();
  const todayCount = Number.isFinite(Number(dailyRow?.count)) ? Math.max(0, Math.floor(Number(dailyRow.count))) : 0;

  const maxDaily = parseMaxDaily(scene.max_daily);

  const text =
    `📅 <b>场景每日限额设置</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `🔢 <b>场景行 ID:</b> <code>${rowId}</code>\n` +
    `🧩 <b>场景键:</b> <code>${escapeHtml(scene.scene_key)}</code>\n` +
    `📊 <b>今日已发送:</b> ${todayCount} 条\n` +
    `🎯 <b>当前上限:</b> ${maxDaily === -1 ? "不限制" : maxDaily + " 条/天"}\n\n` +
    `只影响该场景（私聊或某个群），不影响其他场景：`;

  return editMessageText(token, chatId, messageId, text, getUserLimitKeyboard(rowId), "HTML");
}

/**
 * 处理限额调整回调。
 * action 支持：+N / -N / unlimited / reset_used。
 */
export async function handleModLimit({ env, token, callback, chatId, msgId, data, adminId = null }) {
  const raw = data.replace("admin_modlimit_", "");
  const sepIndex = raw.indexOf("_");
  const rowId = parseInt(sepIndex === -1 ? raw : raw.substring(0, sepIndex), 10);
  const action = sepIndex === -1 ? "" : raw.substring(sepIndex + 1);

  if (!env.DB || !Number.isInteger(rowId)) return;

  const scene = await env.DB.prepare("SELECT scene_key, max_daily FROM user_scenes WHERE id = ?").bind(rowId).first();
  if (!scene) {
    await answerCallback(token, callback.id, "❌ 场景不存在", true);
    return;
  }

  const currentLimit = parseMaxDaily(scene.max_daily);

  if (action === "reset_used") {
    const todayStr = getDateKey(env);
    await env.DB.prepare("UPDATE daily_stats SET count = 0 WHERE scene_key = ? AND date_str = ?")
      .bind(scene.scene_key, todayStr).run();
    await answerCallback(token, callback.id, "✅ 今日已用额度已清零");
  } else {
    let newLimit = currentLimit;
    if (action === "unlimited") {
      newLimit = -1;
    } else {
      const delta = Number.parseInt(action, 10);
      if (!Number.isInteger(delta)) {
        await answerCallback(token, callback.id, "❌ 无效的限额调整参数", true);
        await renderUserLimitMenu(token, env, chatId, msgId, rowId);
        return;
      }
      const currentBase = currentLimit === -1 ? 0 : currentLimit;
      newLimit = Math.max(0, currentBase + delta);
    }
    await env.DB.prepare("UPDATE user_scenes SET max_daily = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(newLimit, rowId).run();
    await answerCallback(
      token, callback.id,
      action === "unlimited" ? "✅ 已设置为无限制" : `✅ 最大限额调整为: ${newLimit}`
    );
    await logAdminAction(env, {
      adminId, chatId, action: "scene_limit_mod",
      detail: `${scene.scene_key} 限额 → ${newLimit === -1 ? "不限" : newLimit}`
    });
  }
  await renderUserLimitMenu(token, env, chatId, msgId, rowId);
}
