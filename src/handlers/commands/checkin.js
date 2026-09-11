// ==========================================
// /checkin 每日签到
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { getDateKey } from "../../services/time.js";
import { logPointChange } from "../../services/points.js";
import { POINTS } from "../../config/constants.js";

export async function cmdCheckin({ env, ctx, token, chatId, userKey, isGroupCtx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库，签到功能不可用。", null, isGroupCtx, ctx);
    return;
  }

  const todayStr = getDateKey(env);

  const insertRes = await env.DB.prepare(`
    INSERT INTO daily_checkin (user_key, date_str, created_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_key, date_str) DO NOTHING
  `).bind(userKey, todayStr).run();

  if (insertRes.meta.changes === 0) {
    const totalRes = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM daily_checkin WHERE user_key = ?"
    ).bind(userKey).first();
    const totalDays = Number(totalRes?.total) || 0;
    await sendAutoDelete(
      token, chatId,
      `📅 你今天（${todayStr}）已经签到过啦！\n累计签到：<b>${totalDays}</b> 天\n明天再来吧～`,
      "HTML", isGroupCtx, ctx
    );
    return;
  }

  const updateRes = await env.DB.prepare(
    "UPDATE users SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(POINTS.CHECKIN_REWARD, userKey).first();

  const newBalance = Number(updateRes?.points);
  await logPointChange(env, userKey, POINTS.CHECKIN_REWARD, Number.isFinite(newBalance) ? newBalance : 0, `每日签到奖励 (${todayStr})`);

  const totalRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM daily_checkin WHERE user_key = ?"
  ).bind(userKey).first();
  const totalDays = Number(totalRes?.total) || 0;

  const msg =
    `✅ <b>签到成功！</b>\n` +
    `-------------------------\n` +
    `📅 <b>日期：</b> ${todayStr}（北京时间）\n` +
    `🎁 <b>奖励：</b> +${POINTS.CHECKIN_REWARD} 积分\n` +
    `🪙 <b>当前积分：</b> <b>${Number.isFinite(newBalance) ? newBalance : "?"}</b>\n` +
    `📊 <b>累计签到：</b> ${totalDays} 天\n\n` +
    `明天记得再来哦～`;

  await sendAutoDelete(token, chatId, msg, "HTML", isGroupCtx, ctx);
}