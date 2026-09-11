// ==========================================
// 🪙 积分服务
// ==========================================

import { logError } from "../core/logger.js";

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

export async function tryDeductPoints(env, userKey, amount) {
  if (!env.DB) return null;
  const res = await env.DB.prepare(
    "UPDATE users SET points = points - ? WHERE user_key = ? AND points >= ? RETURNING points"
  ).bind(amount, userKey, amount).first();
  return res && Number.isFinite(Number(res.points)) ? Number(res.points) : null;
}

export async function refundPoint(env, userKey, amount, reason) {
  if (!env.DB || !userKey) return;
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (safeAmount <= 0) return;

  const result = await env.DB.prepare(
    "UPDATE users SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(safeAmount, userKey).first();

  if (result && Number.isFinite(Number(result.points))) {
    await logPointChange(env, userKey, safeAmount, Number(result.points), reason);
  }
}

export async function adjustPoints(env, userKey, delta) {
  if (!env.DB) return null;
  const res = await env.DB.prepare(
    "UPDATE users SET points = points + ?, updated_at = CURRENT_TIMESTAMP WHERE user_key = ? RETURNING points"
  ).bind(delta, userKey).first();
  return res && Number.isFinite(Number(res.points)) ? Number(res.points) : null;
}
