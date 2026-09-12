// ==========================================
// /checkin 每日签到
//
// 流程：写入签到记录（主键保证一天一次）→ 算连续天数 → 发奖励 → 记流水。
// 同一天重复签到只提示、不重复发奖。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { getDateKey } from "../../services/time.js";
import { adjustPoints, logPointChange } from "../../services/points.js";
import { computeCheckinStreak, calcCheckinReward } from "../../services/checkin.js";
import { completeTask } from "../../services/tasks.js";

/** /checkin 指令实现 */
export async function cmdCheckin({ env, ctx, token, chatId, userKey, isGroupCtx, uctx }) {
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
    const [totalRes, streak] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS total FROM daily_checkin WHERE user_key = ?").bind(userKey).first(),
      computeCheckinStreak(env, userKey, todayStr)
    ]);
    const totalDays = Number(totalRes?.total) || 0;
    const nextReward = calcCheckinReward(streak + 1);
    await sendAutoDelete(
      token, chatId,
      `📅 你今天（${todayStr}）已经签到过啦！\n` +
      `🔥 连续签到：<b>${streak}</b> 天\n` +
      `📊 累计签到：<b>${totalDays}</b> 天\n` +
      `🎁 明天签到可得 <b>+${nextReward.total}</b> 积分，别断了哦～`,
      "HTML", isGroupCtx, ctx
    );
    return;
  }

  const streak = await computeCheckinStreak(env, userKey, todayStr);
  const reward = calcCheckinReward(streak);
  const nextReward = calcCheckinReward(streak + 1);

  // 加分失败（用户记录缺失等极端情况）时回滚签到记录，
  // 避免出现「显示已签到但没拿到积分」的不一致状态。
  const newBalance = await adjustPoints(env, userKey, reward.total);
  if (newBalance === null) {
    await env.DB.prepare(
      "DELETE FROM daily_checkin WHERE user_key = ? AND date_str = ?"
    ).bind(userKey, todayStr).run();
    await sendAutoDelete(token, chatId, "❌ 签到失败：用户数据异常，请稍后重试。", null, isGroupCtx, ctx);
    return;
  }

  await logPointChange(env, userKey, reward.total, newBalance, `签到奖励 连续${streak}天 (${todayStr})`);

  const totalRes = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM daily_checkin WHERE user_key = ?"
  ).bind(userKey).first();
  const totalDays = Number(totalRes?.total) || 0;

  const milestoneLine = reward.milestone > 0
    ? `🎉 <b>连续满 ${streak} 天里程碑：</b> +${reward.milestone} 积分\n`
    : ``;

  const msg =
    `✅ <b>签到成功！</b>\n` +
    `-------------------------\n` +
    `📅 <b>日期：</b> ${todayStr}（北京时间）\n` +
    `🔥 <b>连续签到：</b> <b>${streak}</b> 天\n` +
    `🎁 <b>本次奖励：</b> +${reward.total} 积分\n` +
    milestoneLine +
    `🪙 <b>当前积分：</b> <b>${newBalance}</b>\n` +
    `📊 <b>累计签到：</b> ${totalDays} 天\n\n` +
    `⏭️ 明天签到可得 <b>+${nextReward.total}</b> 积分，连续签到奖励会越来越高～`;

  await sendAutoDelete(token, chatId, msg, "HTML", isGroupCtx, ctx);

  await completeTask(env, userKey, "checkin", { sceneKey: uctx?.sceneKey || null, chatId, token });
}
