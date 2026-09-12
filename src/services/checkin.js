// ==========================================
// 📅 签到服务：连续天数与递增奖励
// ==========================================

import { POINTS } from "../config/constants.js";
import { shiftDateKey } from "./time.js";

// 连续签到最多回溯的天数，防止极端数据量下的长循环
const MAX_STREAK_LOOKBACK = 400;

/**
 * 计算截止到 todayStr（含当天）的连续签到天数。
 * 需要保证当天已签到，否则返回 0。
 */
export async function computeCheckinStreak(env, userKey, todayStr) {
  if (!env.DB || !userKey) return 0;

  const { results } = await env.DB.prepare(
    "SELECT date_str FROM daily_checkin WHERE user_key = ? ORDER BY date_str DESC LIMIT ?"
  ).bind(userKey, MAX_STREAK_LOOKBACK).all();

  const dates = new Set((results || []).map((r) => String(r.date_str)));

  let streak = 0;
  let cursor = todayStr;
  while (streak < MAX_STREAK_LOOKBACK && dates.has(cursor)) {
    streak++;
    cursor = shiftDateKey(cursor, -1);
  }
  return streak;
}

/**
 * 连续签到第 streak 天的奖励：
 * 基础 5 分，每多连续一天 +1，上限 20 分；
 * 每满 7 天额外奖励 20 分。
 */
export function calcCheckinReward(streak) {
  const days = Math.max(1, Math.floor(Number(streak) || 1));
  const base = Math.min(
    POINTS.CHECKIN_BASE + (days - 1) * POINTS.CHECKIN_STEP,
    POINTS.CHECKIN_MAX
  );
  const milestone = days % POINTS.CHECKIN_MILESTONE_DAYS === 0
    ? POINTS.CHECKIN_MILESTONE_BONUS
    : 0;
  return { total: base + milestone, base, milestone };
}
