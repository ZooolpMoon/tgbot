// ==========================================
// 📈 系统统计
// ==========================================

import { editMessageText, sendMessage } from "../telegram/api.js";
import { getDateKey, getAppTimeZone } from "../services/time.js";

export async function renderAdminStats(token, env, chatId, messageId) {
  if (!env.DB) return editMessageText(token, chatId, messageId, "❌ 未绑定 D1 数据库。", null, null);
  const todayStr = getDateKey(env);

  const [totalRes, activeRes, dailyRes, pointsRes, groupRes, checkinRes] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM users").first(),
    env.DB.prepare("SELECT COUNT(DISTINCT scene_key) AS total FROM daily_stats WHERE date_str = ? AND count > 0").bind(todayStr).first(),
    env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS total FROM daily_stats WHERE date_str = ?").bind(todayStr).first(),
    env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN points > 0 THEN points ELSE 0 END), 0) AS total FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM user_scenes WHERE chat_type IN ('group','supergroup')").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM daily_checkin WHERE date_str = ?").bind(todayStr).first()
  ]);

  const totalUsers = Number(totalRes?.total) || 0;
  const groupScenes = Number(groupRes?.total) || 0;
  const checkins = Number(checkinRes?.total) || 0;

  const text =
    `📈 <b>系统使用统计</b>\n` +
    `-------------------------\n` +
    `📅 <b>统计日期:</b> ${todayStr}\n` +
    `👥 <b>全局用户总数:</b> ${totalUsers}\n` +
    `👥 <b>群聊场景数:</b> ${groupScenes}\n` +
    `📅 <b>今日签到人数:</b> ${checkins}\n` +
    `🟢 <b>今日活跃场景:</b> ${Number(activeRes?.total) || 0}\n` +
    `💬 <b>今日成功请求:</b> ${Number(dailyRes?.total) || 0}\n` +
    `🪙 <b>用户积分总量:</b> ${Number(pointsRes?.total) || 0}\n\n` +
    `🌐 <b>额度时区:</b> ${getAppTimeZone(env)}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 刷新统计", callback_data: "admin_stats" }],
      [{ text: "🔙 返回主菜单", callback_data: "admin_main_menu" }]
    ]
  };
  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}

export async function sendAdminStatsMessage(token, env, chatId) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定 D1 数据库。");
  const todayStr = getDateKey(env);

  const [totalRes, groupRes, checkinRes] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM users").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM user_scenes WHERE chat_type IN ('group','supergroup')").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM daily_checkin WHERE date_str = ?").bind(todayStr).first()
  ]);

  const text =
    `📈 系统使用统计\n` +
    `-------------------------\n` +
    `📅 统计日期：${todayStr}\n` +
    `👥 全局用户总数：${Number(totalRes?.total) || 0}\n` +
    `👥 群聊场景数：${Number(groupRes?.total) || 0}\n` +
    `📅 今日签到人数：${Number(checkinRes?.total) || 0}\n` +
    `🌐 额度时区：${getAppTimeZone(env)}`;

  return sendMessage(token, chatId, text);
}