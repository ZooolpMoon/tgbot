// ==========================================
// 🪙 积分服务
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { tryDeductPoints, refundPoint, adjustPoints, logPointChange } from "../src/services/points.js";
import { getUserPoints } from "../src/services/users.js";
import { buildUserKey, buildSceneKey } from "../src/core/context.js";

test("用户键 / 场景键的生成规则", () => {
  assert.equal(buildUserKey("123"), "user:123");
  assert.equal(buildSceneKey("-100", "123", "group"), "group:-100:user:123");
  assert.equal(buildSceneKey("123", "123", "private"), "private:123");
});

test("扣分：余额不足时不扣、不返回负数", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 5);

  assert.equal(await tryDeductPoints(env, "user:1", 3), 2, "扣 3 分后余额 2");
  assert.equal(await tryDeductPoints(env, "user:1", 10), null, "余额不足应返回 null");
  assert.equal(await getUserPoints(env, "user:1"), 2, "失败不应改变余额");
  assert.equal(await tryDeductPoints(env, "user:nobody", 1), null, "不存在的用户返回 null");
  db.close();
});

test("退款会写流水，且流水记录变化后的余额", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 10);

  await refundPoint(env, "user:1", 5, "测试退款");
  assert.equal(await getUserPoints(env, "user:1"), 15);

  const log = db.get("SELECT change_amount, balance_after, reason FROM points_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.change_amount, 5);
  assert.equal(log.balance_after, 15);
  assert.equal(log.reason, "测试退款");

  // 非法金额直接忽略
  await refundPoint(env, "user:1", 0, "零退款");
  assert.equal(db.count("points_log"), 1);
  db.close();
});

test("adjustPoints 支持负数（用于扣减）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 20);

  assert.equal(await adjustPoints(env, "user:1", -5), 15);
  assert.equal(await adjustPoints(env, "user:1", 50), 65);
  assert.equal(await adjustPoints(env, "user:nobody", 1), null);
  db.close();
});

test("logPointChange 不做参数校验之外的副作用", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 10);

  await logPointChange(env, "user:1", 7, 17, "手动记录");
  const row = db.get("SELECT user_key, change_amount, balance_after, reason FROM points_log");
  assert.equal(row.user_key, "user:1");
  assert.equal(row.change_amount, 7);
  assert.equal(row.balance_after, 17);
  db.close();
});
