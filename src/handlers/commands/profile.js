// ==========================================
// /profile
// 个人信息卡片：身份、积分、签到、今日任务与场景额度。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { getDateKey } from "../../services/time.js";
import { computeCheckinStreak, calcCheckinReward } from "../../services/checkin.js";
import { getTodayTasks } from "../../services/tasks.js";
import { escapeHtml } from "../../utils/html.js";

/** 汇总当前用户在当前场景下的全部状态并渲染成卡片 */
export async function cmdProfile({ env, ctx, token, chatId, uctx, userConfig, isGroupCtx, isMaster, sceneKey, userKey }) {
  let dailyCount = 0;
  let totalCheckins = 0;
  let streakDays = 0;
  let taskLine = "";
  const todayStr = getDateKey(env);

  if (env.DB) {
    const row = await env.DB.prepare(
      "SELECT count FROM daily_stats WHERE scene_key = ? AND date_str = ?"
    ).bind(sceneKey, todayStr).first();
    dailyCount = row ? Number(row.count) || 0 : 0;

    const ck = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM daily_checkin WHERE user_key = ?"
    ).bind(userKey).first();
    totalCheckins = Number(ck?.total) || 0;

    streakDays = await computeCheckinStreak(env, userKey, todayStr);

    const tasks = await getTodayTasks(env, userKey);
    taskLine = `${tasks.done}/${tasks.total}${tasks.allDone ? "（已全勤 🎉）" : ""}`;
  }

  const limitStr = userConfig.maxDaily === -1 ? "无限制" : `${dailyCount}/${userConfig.maxDaily} 条`;
  const sourceText = isGroupCtx ? `👥 群聊 (${uctx.chatId})` : `💬 私聊`;

  const profileText =
    `👤 <b>个人信息卡片</b>\n` +
    `-------------------------\n` +
    `👤 <b>名字:</b> ${escapeHtml(uctx.firstName || "未命名")}\n` +
    `🏷️ <b>用户名:</b> ${escapeHtml(uctx.username ? "@" + uctx.username : "无用户名")}\n` +
    `👑 <b>身份:</b> ${isMaster ? "最高管理员" : "普通用户"}\n` +
    `🪙 <b>全局积分:</b> <b>${userConfig.points}</b>\n` +
    `📅 <b>累计签到:</b> ${totalCheckins} 天\n` +
    `🔥 <b>连续签到:</b> ${streakDays} 天（明日可得 +${calcCheckinReward(streakDays + 1).total}）\n` +
    (taskLine ? `✅ <b>今日任务:</b> ${taskLine}\n` : ``) +
    `📅 <b>本场景今日额度:</b> ${limitStr}\n` +
    `⏱️ <b>本场景冷却:</b> ${userConfig.rateLimitSec} 秒\n` +
    `🌐 <b>偏好语言:</b> ${escapeHtml(userConfig.lang)}\n` +
    `📝 <b>自定义设定:</b> ${escapeHtml(userConfig.customPrompt) || "未设置"}` +
    (isMaster
      ? `\n\n🔍 <b>管理员技术信息</b>\n` +
        `🆔 <b>用户 ID:</b> <code>${escapeHtml(String(uctx.userId))}</code>\n` +
        `🧩 <b>积分键:</b> <code>${escapeHtml(userKey)}</code>\n` +
        `📍 <b>场景键:</b> <code>${escapeHtml(sceneKey)}</code>\n` +
        `🗂️ <b>来源:</b> ${escapeHtml(sourceText)}`
      : ``);

  await sendAutoDelete(token, chatId, profileText, "HTML", isGroupCtx, ctx);
}
