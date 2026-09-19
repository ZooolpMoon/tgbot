// ==========================================
// 🪙 积分服务
//
// 约定：涉及积分的操作必须「原子更新 + 写流水」。
//   • 扣分走 tryDeductPoints（WHERE points >= ?，余额不足直接返回 null）
//   • 加分走 adjustPoints / refundPoint
//   • 任何一次变动都要用 logPointChange 记一条流水
// ==========================================

import { logError } from "../core/logger.js";

/** 老库兜底建表（新库由 ensureSchema 统一建） */
export async function ensurePointsLogTable(env) {
  if (!env.DB) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS points_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      change_amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

/** 写一条积分流水；失败只记日志，不影响主流程 */
export async function logPointChange(env, userKey, changeAmount, balanceAfter, reason) {
  if (!env.DB || !userKey) return;
  try {
    await env.DB.prepare(
      "INSERT INTO points_log (user_key, change_amount, balance_after, reason) VALUES (?, ?, ?, ?)"
    ).bind(userKey, Math.trunc(changeAmount), Math.trunc(balanceAfter), String(reason || "未说明")).run();
  } catch (e) {
    logError("积分流水记录失败：", e);
  }
}

/**
 * 原子扣分（余额不足返回 null，不会出现负数余额）。
 * @returns {Promise<number|null>} 扣分后的余额
 */
export async function tryDeductPoints(env, userKey, amount) {
  if (!env.DB) return null;
  // 负数扣分等于凭空加分：任何调用方都不该传负数，这里直接拒绝（0 允许，用于免费商品）
  const cost = Math.floor(Number(amount));
  if (!Number.isFinite(cost) || cost < 0) return null;
  const res = await env.DB.prepare(
    "UPDATE users SET points = points - ? WHERE user_key = ? AND points >= ? RETURNING points"
  ).bind(cost, userKey, cost).first();
  return res && Number.isFinite(Number(res.points)) ? Number(res.points) : null;
}

/**
 * 退款 / 补分（会写流水，reason 用于对账）。
 * @returns {Promise<number|null>} 退款后的余额；没退（未绑定 DB / 用户不存在 / 金额 ≤ 0）返回 null
 */
export async function refundPoint(env, userKey, amount, reason) {
  if (!env.DB || !userKey) return null;
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (safeAmount <= 0) return null;

  const result = await env.DB.prepare(
    "UPDATE users SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(safeAmount, userKey).first();

  if (result && Number.isFinite(Number(result.points))) {
    await logPointChange(env, userKey, safeAmount, Number(result.points), reason);
    return Number(result.points);
  }
  return null;
}

/**
 * 任意增减积分（可传负数）。调用方需自行保证结果不会变成负数。
 * @returns {Promise<number|null>} 变动后的余额，用户不存在时返回 null
 */
export async function adjustPoints(env, userKey, delta) {
  if (!env.DB) return null;
  const res = await env.DB.prepare(
    "UPDATE users SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(delta, userKey).first();
  return res && Number.isFinite(Number(res.points)) ? Number(res.points) : null;
}
