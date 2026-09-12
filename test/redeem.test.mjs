// ==========================================
// 🎟️ 兑换码
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { createRedeemCode, redeemCode, normalizeCode, generateCode, listRedeemCodes, setRedeemCodeEnabled } from "../src/services/redeem.js";
import { getDateKey, shiftDateKey } from "../src/services/time.js";
import { getUserPoints } from "../src/services/users.js";

test("normalizeCode 容忍大小写、空格与连字符", () => {
  assert.equal(normalizeCode(" tg-7kq2 m4xz "), "TG7KQ2M4XZ");
  assert.equal(normalizeCode(""), "");
  assert.equal(normalizeCode(null), "");
});

test("generateCode 形如 TG + 8 位，且不含易混淆字符", () => {
  for (let i = 0; i < 50; i++) {
    const code = generateCode();
    assert.match(code, /^TG[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    assert.ok(!/[IO01]/.test(code), `不应出现易混淆字符：${code}`);
  }
});

test("创建兑换码会校验面额", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal((await createRedeemCode(env, { points: 0 })).ok, false);
  assert.equal((await createRedeemCode(env, { points: -5 })).ok, false);
  assert.equal((await createRedeemCode(env, { points: 99999999 })).ok, false);

  const res = await createRedeemCode(env, { points: 100, maxUses: 3, validDays: 7, createdBy: "999" });
  assert.equal(res.ok, true);
  assert.equal(res.points, 100);
  assert.equal(res.maxUses, 3);
  assert.equal(res.expiresAt, shiftDateKey(getDateKey(env), 7));
  assert.ok(db.get("SELECT id FROM redeem_codes WHERE code = ?", res.code));
  db.close();
});

test("正常兑换：加积分 + 写流水 + 计数 +1", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 10);
  const { code } = await createRedeemCode(env, { points: 50 });

  const res = await redeemCode(env, "user:1", ` ${code.toLowerCase()} `);
  assert.equal(res.ok, true);
  assert.equal(res.points, 50);
  assert.equal(res.balance, 60);
  assert.equal(await getUserPoints(env, "user:1"), 60);

  const row = db.get("SELECT used_count FROM redeem_codes WHERE code = ?", code);
  assert.equal(row.used_count, 1);
  const log = db.get("SELECT change_amount, reason FROM points_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.change_amount, 50);
  assert.match(log.reason, /兑换码/);
  db.close();
});

test("同一个用户不能重复兑换同一个码", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);
  const { code } = await createRedeemCode(env, { points: 30, maxUses: 5 });

  assert.equal((await redeemCode(env, "user:1", code)).ok, true);
  const second = await redeemCode(env, "user:1", code);
  assert.equal(second.ok, false);
  assert.match(second.error, /已经兑换过/);
  assert.equal(await getUserPoints(env, "user:1"), 30, "积分不应重复发放");
  assert.equal(db.count("redeem_logs"), 1);
  db.close();
});

test("次数用完后其他人也领不到（且不会多发积分）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);
  seedUser(db, "user:2", 0);
  seedUser(db, "user:3", 0);
  const { code } = await createRedeemCode(env, { points: 20, maxUses: 2 });

  assert.equal((await redeemCode(env, "user:1", code)).ok, true);
  assert.equal((await redeemCode(env, "user:2", code)).ok, true);

  const third = await redeemCode(env, "user:3", code);
  assert.equal(third.ok, false);
  assert.match(third.error, /领完/);
  assert.equal(await getUserPoints(env, "user:3"), 0);
  assert.equal(db.get("SELECT used_count FROM redeem_codes WHERE code = ?", code).used_count, 2);
  assert.equal(db.count("redeem_logs"), 2, "失败的那次不应留下记录");
  db.close();
});

test("max_uses = 0 表示不限次数（但每人仍限一次）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);
  seedUser(db, "user:2", 0);
  const { code } = await createRedeemCode(env, { points: 5, maxUses: 0 });

  assert.equal((await redeemCode(env, "user:1", code)).ok, true);
  assert.equal((await redeemCode(env, "user:2", code)).ok, true);
  assert.equal((await redeemCode(env, "user:1", code)).ok, false);
  assert.equal(db.get("SELECT used_count FROM redeem_codes WHERE code = ?", code).used_count, 2);
  db.close();
});

test("过期与停用的兑换码不能兑换", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);

  const expired = await createRedeemCode(env, { points: 5, validDays: 1 });
  db.exec(`UPDATE redeem_codes SET expires_at = '${shiftDateKey(getDateKey(env), -1)}' WHERE code = '${expired.code}'`);
  const expiredResult = await redeemCode(env, "user:1", expired.code);
  assert.equal(expiredResult.ok, false);
  assert.match(expiredResult.error, /过期/);

  const disabled = await createRedeemCode(env, { points: 5 });
  await setRedeemCodeEnabled(env, db.get("SELECT id FROM redeem_codes WHERE code = ?", disabled.code).id, false);
  const disabledResult = await redeemCode(env, "user:1", disabled.code);
  assert.equal(disabledResult.ok, false);
  assert.match(disabledResult.error, /停用/);

  const missing = await redeemCode(env, "user:1", "TGNOTEXIST");
  assert.equal(missing.ok, false);
  assert.match(missing.error, /不存在/);
  assert.equal(await getUserPoints(env, "user:1"), 0);
  db.close();
});

test("listRedeemCodes 分页", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  for (let i = 0; i < 12; i++) await createRedeemCode(env, { points: 10 + i });

  const first = await listRedeemCodes(env, 1, 8);
  assert.equal(first.total, 12);
  assert.equal(first.totalPages, 2);
  assert.equal(first.rows.length, 8);

  const second = await listRedeemCodes(env, 2, 8);
  assert.equal(second.rows.length, 4);
  db.close();
});
