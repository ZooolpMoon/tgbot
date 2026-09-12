// ==========================================
// 🎁 抽奖服务（v3.0.0）
//
// 两种抽法：
//   free —— 每天 1 次，靠「部分唯一索引」保证不重复（插得进去才算抽到）
//   paid —— 花 LOTTERY.PAID_COST 积分抽，先扣分再发奖，发奖失败自动退款
//
// 奖池与权重在 config/constants.js 的 LOTTERY 里；期望值刻意低于单次成本，
// 否则付费抽奖会被当成无限刷分入口。
// ==========================================

import { LOTTERY } from "../config/constants.js";
import { randomInt } from "../utils/random.js";
import { adjustPoints, logPointChange, tryDeductPoints, refundPoint } from "./points.js";
import { getDateKey } from "./time.js";
import { logError } from "../core/logger.js";

/** 按权重抽一个奖品（加密随机，不用 Math.random） */
export function pickPrize(prizes = LOTTERY.PRIZES) {
  const list = (prizes || []).filter((p) => Number(p.points) > 0 && Number(p.weight) > 0);
  if (list.length === 0) return 0;
  const total = list.reduce((sum, p) => sum + Number(p.weight), 0);
  let roll = randomInt(total);
  for (const p of list) {
    roll -= Number(p.weight);
    if (roll < 0) return Number(p.points);
  }
  return Number(list[list.length - 1].points);
}

/** 奖池期望值（测试与文档里会用来校验「付费不亏分」） */
export function expectedPrize(prizes = LOTTERY.PRIZES) {
  const list = prizes || [];
  const total = list.reduce((sum, p) => sum + Number(p.weight), 0);
  if (total <= 0) return 0;
  return list.reduce((sum, p) => sum + Number(p.points) * Number(p.weight), 0) / total;
}

/** 今天是否已经抽过免费那次 */
export async function hasFreeDrawToday(env, userKey) {
  if (!env?.DB || !userKey) return false;
  const today = getDateKey(env);
  const row = await env.DB.prepare(
    "SELECT id FROM lottery_draws WHERE user_key = ? AND date_str = ? AND source = 'free'"
  ).bind(userKey, today).first();
  return Boolean(row);
}

/** 今日抽奖统计（面板展示用） */
export async function getTodayDrawStats(env, userKey) {
  const today = getDateKey(env);
  if (!env?.DB || !userKey) return { free: false, paidCount: 0, gained: 0 };
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN source = 'free' THEN 1 ELSE 0 END) AS free_count,
       SUM(CASE WHEN source = 'paid' THEN 1 ELSE 0 END) AS paid_count,
       COALESCE(SUM(prize), 0) AS gained
     FROM lottery_draws WHERE user_key = ? AND date_str = ?`
  ).bind(userKey, today).first();
  return {
    free: (Number(row?.free_count) || 0) > 0,
    paidCount: Number(row?.paid_count) || 0,
    gained: Number(row?.gained) || 0
  };
}

/**
 * 抽一次。
 * @param {"free"|"paid"} source
 * @returns {Promise<{ok:boolean, prize?:number, balance?:number, error?:string, already?:boolean, cost?:number}>}
 */
export async function draw(env, userKey, source = "free") {
  if (!env?.DB) return { ok: false, error: "未绑定数据库" };
  if (!userKey) return { ok: false, error: "缺少用户" };
  if (source !== "free" && source !== "paid") return { ok: false, error: "未知的抽奖方式" };

  const today = getDateKey(env);
  const cost = source === "paid" ? Number(LOTTERY.PAID_COST) || 0 : 0;
  const prize = pickPrize();

  // ---------- 付费：先扣分 ----------
  let afterDeduct = null;
  if (source === "paid") {
    afterDeduct = await tryDeductPoints(env, userKey, cost);
    if (afterDeduct === null) {
      return { ok: false, error: `积分不足，抽一次需要 ${cost} 积分` };
    }
  }

  // ---------- 记录这次抽奖 ----------
  // 免费那次靠部分唯一索引去重：插不进去说明今天已经抽过
  try {
    await env.DB.prepare(
      "INSERT INTO lottery_draws (user_key, date_str, source, prize, cost) VALUES (?, ?, ?, ?, ?)"
    ).bind(userKey, today, source, prize, cost).run();
  } catch (e) {
    if (source === "paid") {
      await refundPoint(env, userKey, cost, "抽奖记录失败自动退款");
    }
    const msg = String(e?.message || e);
    if (/UNIQUE|constraint/i.test(msg)) {
      return { ok: false, already: true, error: "今天的免费抽奖已经用过啦，明天再来～" };
    }
    logError("写入抽奖记录失败：", e);
    return { ok: false, error: "抽奖失败，请稍后重试" };
  }

  // ---------- 发奖 ----------
  const balance = await adjustPoints(env, userKey, prize);
  if (balance === null) {
    // 用户记录异常：回滚记录与消耗
    await env.DB.prepare(
      "DELETE FROM lottery_draws WHERE user_key = ? AND date_str = ? AND source = ? AND prize = ?"
    ).bind(userKey, today, source, prize).run();
    if (source === "paid") await refundPoint(env, userKey, cost, "抽奖发奖失败自动退款");
    return { ok: false, error: "发奖失败，请稍后重试" };
  }

  await logPointChange(env, userKey, prize, balance, `抽奖奖励（${source === "free" ? "每日免费" : `花费 ${cost} 积分`}）`);
  return { ok: true, prize, balance, cost, already: false };
}
