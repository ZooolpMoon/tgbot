// ==========================================
// ⚖️ 群规处置「确认执行」的原子占用
//
// 背景（v3.7.0 修）：确认流程是「先 SELECT 判断 pending、再调 Telegram 执行」。
// 双击确认卡片（或 Telegram 重推回调）时，两个请求都会读到 pending、**各自执行
// 一次** —— 目标被重复封禁，处置公告 / 私聊通知 / 审计日志各发两遍。
//
// 这里覆盖修复后的两道防线：`claimPunishment` 的原子性，以及「占用失败就不再执行」。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import {
  claimPunishment,
  getPunishment,
  updatePunishmentStatus,
  createPendingPunishment,
  executePunishment
} from "../src/services/guard.js";
import { isUserBlocked } from "../src/services/users.js";
import { buildUserKey } from "../src/core/context.js";
import { cleanupStaleData } from "../src/services/daily.js";

const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai" });
const TARGET = "555";

function seedPending(db, { userId = TARGET, action = "bot_ban" } = {}) {
  db.exec(
    `INSERT INTO group_punishments (chat_id, user_id, user_label, action, duration_min, reason, status, operator_id)
     VALUES ('-100123', '${userId}', '测试用户', '${action}', 0, '广告', 'pending', '999')`
  );
  return Number(db.get("SELECT id FROM group_punishments ORDER BY id DESC LIMIT 1").id);
}

test("claimPunishment：同一条处置只能被占用一次（双击的第二下必然失败）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${TARGET}`, 100);
  const env = makeEnv(db);
  const id = seedPending(db);

  assert.equal(await claimPunishment(env, id), true, "第一次占用应成功");
  assert.equal(await claimPunishment(env, id), false, "第二次占用必须失败（这就是防重复执法的那一层）");
  assert.equal((await getPunishment(env, id)).status, "executing");
  db.close();
});

test("claimPunishment：已结束的处置不能再被占用", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${TARGET}`, 100);
  const env = makeEnv(db);
  const id = seedPending(db);

  await updatePunishmentStatus(env, id, "done", "已执行");
  assert.equal(await claimPunishment(env, id), false);
  await updatePunishmentStatus(env, id, "failed", "执行失败");
  assert.equal(await claimPunishment(env, id), false, "失败态也不该被重新占用");
  db.close();
});

test("双击确认：只会真的执行一次（占用挡住第二次）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${TARGET}`, 100);
  const env = makeEnv(db);
  const id = seedPending(db);
  const record = await getPunishment(env, id);

  // 模拟 handleGuardCallback 里的确认分支：占用 → 执行 → 写回
  const confirmOnce = async () => {
    if (!(await claimPunishment(env, id))) return { skipped: true };
    const result = await executePunishment({ env, token: "T", record, action: record.action, durationMin: 0 });
    await updatePunishmentStatus(env, id, result.ok ? "done" : "failed", result.detail || result.error || "");
    return { skipped: false, result };
  };

  const first = await confirmOnce();
  const second = await confirmOnce();

  assert.equal(first.skipped, false, "第一次应真的执行");
  assert.equal(first.result.ok, true);
  assert.equal(second.skipped, true, "第二次必须被挡下，不能再执行一次");
  assert.equal(await isUserBlocked(env, buildUserKey(TARGET)), true);
  assert.equal((await getPunishment(env, id)).status, "done");

  // 只该有一条审计痕迹：流水/状态没被写两遍
  assert.equal(db.count("group_punishments", "status = 'executing'"), 0);
  db.close();
});

test("执行中断的处置：30 分钟后被标记为 failed，不会永久卡在 executing", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${TARGET}`, 100);
  const env = makeEnv(db);
  const id = seedPending(db);

  await claimPunishment(env, id);
  assert.equal((await getPunishment(env, id)).status, "executing");

  // 还没到 30 分钟：不该被动
  let res = await cleanupStaleData(env);
  assert.equal(res.stuckPunishments, 0);
  assert.equal((await getPunishment(env, id)).status, "executing");

  // 超过 30 分钟：标记为 failed（保持「失败不可重试」的语义，宁可重发起也不重复执法）
  db.exec("UPDATE group_punishments SET updated_at = datetime('now','-31 minutes') WHERE id = " + id);
  res = await cleanupStaleData(env);
  assert.equal(res.stuckPunishments, 1);
  const after = await getPunishment(env, id);
  assert.equal(after.status, "failed");
  assert.match(String(after.detail), /执行中断/);
  db.close();
});

test("createPendingPunishment：新开的处置默认是 pending，可以被占用", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${TARGET}`, 100);
  const env = makeEnv(db);

  const created = await createPendingPunishment(env, {
    chatId: "-100123", userId: TARGET, userLabel: "测试用户",
    action: "bot_ban", durationMin: 0, reason: "广告", operatorId: "999", detail: ""
  });
  assert.ok(created?.id, "应返回新记录 id");
  assert.equal((await getPunishment(env, created.id)).status, "pending");
  assert.equal(await claimPunishment(env, created.id), true);
  db.close();
});
