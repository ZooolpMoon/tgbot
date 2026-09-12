// ==========================================
// 🎟️ 兑换码
// 管理员生成 → 用户 /redeem 领取积分
// 约束：每个码每人只能兑一次；可选「总次数上限」与「过期日期」
// ==========================================

import { randomInt } from "../utils/random.js";
import { adjustPoints, logPointChange } from "./points.js";
import { getDateKey, shiftDateKey } from "./time.js";
import { logError } from "../core/logger.js";

// 去掉容易看混的 I / O / 0 / 1
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_BODY_LENGTH = 8;
const CODE_PREFIX = "TG";

/** 统一大小写并去掉空格、连字符，方便用户手打 */
export function normalizeCode(input) {
  return String(input || "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}

/** 生成形如 TG7KQ2M4XZ 的随机码 */
export function generateCode() {
  let body = "";
  for (let i = 0; i < CODE_BODY_LENGTH; i++) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

/**
 * 创建兑换码。
 * @param {object} opts
 * @param {number} opts.points   面额（积分）
 * @param {number} opts.maxUses  总次数上限，0 = 不限
 * @param {number} opts.validDays 有效天数，0 = 永久
 * @param {string} opts.createdBy 创建者
 */
export async function createRedeemCode(env, { points, maxUses = 1, validDays = 0, createdBy = "" } = {}) {
  if (!env.DB) return { ok: false, error: "未绑定数据库" };

  const amount = Math.floor(Number(points));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "积分面额必须是大于 0 的整数" };
  if (amount > 1000000) return { ok: false, error: "面额过大（上限 1000000）" };

  const usesRaw = Math.floor(Number(maxUses));
  const uses = Number.isFinite(usesRaw) && usesRaw >= 0 ? usesRaw : 1;

  const daysRaw = Math.floor(Number(validDays));
  const expiresAt = Number.isFinite(daysRaw) && daysRaw > 0
    ? shiftDateKey(getDateKey(env), daysRaw)
    : null;

  // 极小概率撞码，重试几次
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await env.DB.prepare(
        "INSERT INTO redeem_codes (code, points, max_uses, expires_at, created_by) VALUES (?, ?, ?, ?, ?)"
      ).bind(code, amount, uses, expiresAt, String(createdBy || "")).run();
      return { ok: true, code, points: amount, maxUses: uses, expiresAt };
    } catch (e) {
      if (!/UNIQUE|constraint/i.test(String(e?.message || e))) throw e;
    }
  }
  return { ok: false, error: "生成失败，请重试" };
}

/**
 * 用户兑换。返回 { ok, error } 或 { ok: true, points, balance }
 */
export async function redeemCode(env, userKey, rawCode) {
  if (!env.DB) return { ok: false, error: "未绑定数据库" };

  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: "请把兑换码一起发过来，例如 /redeem TG7KQ2M4XZ" };

  const row = await env.DB.prepare("SELECT * FROM redeem_codes WHERE code = ?").bind(code).first();
  if (!row) return { ok: false, error: "兑换码不存在，请检查是否输错" };
  if (Number(row.enabled) !== 1) return { ok: false, error: "该兑换码已被停用" };

  const today = getDateKey(env);
  if (row.expires_at && String(row.expires_at) < today) {
    return { ok: false, error: `该兑换码已于 ${row.expires_at} 过期` };
  }
  if (Number(row.max_uses) > 0 && Number(row.used_count) >= Number(row.max_uses)) {
    return { ok: false, error: "该兑换码已被领完" };
  }

  // 1) 先占「每人一次」名额（靠 UNIQUE 约束兜底）
  try {
    await env.DB.prepare(
      "INSERT INTO redeem_logs (code_id, code, user_key, points) VALUES (?, ?, ?, ?)"
    ).bind(row.id, row.code, userKey, row.points).run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
      return { ok: false, error: "你已经兑换过这个兑换码啦" };
    }
    logError("兑换码写入记录失败：", e);
    return { ok: false, error: "兑换失败，请稍后重试" };
  }

  // 2) 占全局次数：条件更新，拿到才算抢到
  const upd = await env.DB.prepare(
    "UPDATE redeem_codes SET used_count = used_count + 1 WHERE id = ? AND (max_uses = 0 OR used_count < max_uses)"
  ).bind(row.id).run();
  if (upd.meta.changes === 0) {
    await env.DB.prepare("DELETE FROM redeem_logs WHERE code_id = ? AND user_key = ?")
      .bind(row.id, userKey).run();
    return { ok: false, error: "该兑换码已被领完" };
  }

  // 3) 发积分，失败就回滚前两步
  const balance = await adjustPoints(env, userKey, row.points);
  if (balance === null) {
    await env.DB.prepare(
      "UPDATE redeem_codes SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE id = ?"
    ).bind(row.id).run();
    await env.DB.prepare("DELETE FROM redeem_logs WHERE code_id = ? AND user_key = ?")
      .bind(row.id, userKey).run();
    return { ok: false, error: "发放失败，请稍后重试" };
  }

  await logPointChange(env, userKey, row.points, balance, `兑换码 ${row.code}`);
  return { ok: true, code: row.code, points: Number(row.points), balance };
}

/** 管理端：分页列出兑换码 */
export async function listRedeemCodes(env, page = 1, pageSize = 8) {
  if (!env.DB) return { rows: [], total: 0, totalPages: 1, page: 1 };

  let safePage = Math.max(1, Math.floor(Number(page) || 1));
  const countRes = await env.DB.prepare("SELECT COUNT(*) AS total FROM redeem_codes").first();
  const total = Number(countRes?.total) || 0;
  const totalPages = Math.ceil(total / pageSize) || 1;
  if (safePage > totalPages) safePage = totalPages;

  const { results } = await env.DB.prepare(
    "SELECT id, code, points, max_uses, used_count, expires_at, enabled, created_at FROM redeem_codes ORDER BY id DESC LIMIT ? OFFSET ?"
  ).bind(pageSize, (safePage - 1) * pageSize).all();

  return { rows: results || [], total, totalPages, page: safePage };
}

/** 管理端：停用/启用兑换码 */
export async function setRedeemCodeEnabled(env, codeId, enabled) {
  if (!env.DB) return false;
  const res = await env.DB.prepare("UPDATE redeem_codes SET enabled = ? WHERE id = ?")
    .bind(enabled ? 1 : 0, codeId).run();
  return res.meta.changes > 0;
}
