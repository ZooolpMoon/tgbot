// ==========================================
// ✅ 每日任务
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { completeTask, getTodayTasks, TASK_KEYS } from "../src/services/tasks.js";
import { DAILY_TASKS, DAILY_TASK_ALL_BONUS, TASK_ALL_KEY } from "../src/config/tasks.js";
import { getUserPoints } from "../src/services/users.js";
import { setFeature, GLOBAL_SCOPE } from "../src/services/features.js";

test("任务定义完整（key 唯一、奖励为正）", () => {
  const keys = DAILY_TASKS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length, "任务 key 不能重复");
  for (const t of DAILY_TASKS) {
    assert.ok(t.points > 0, `${t.key} 的奖励应为正数`);
    assert.ok(t.label && t.hint, `${t.key} 应有说明文案`);
  }
  assert.ok(DAILY_TASK_ALL_BONUS > 0);
});

test("getTodayTasks 初始状态与完成后状态", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);

  const before = await getTodayTasks(env, "user:1");
  assert.equal(before.done, 0);
  assert.equal(before.total, DAILY_TASKS.length);
  assert.equal(before.earned, 0);
  assert.equal(before.allDone, false);

  await completeTask(env, "user:1", "checkin");
  const after = await getTodayTasks(env, "user:1");
  assert.equal(after.done, 1);
  assert.equal(after.earned, 5);
  assert.equal(after.tasks.find((t) => t.key === "checkin").done, true);
  db.close();
});

test("同一任务每天只发一次奖励", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);

  const first = await completeTask(env, "user:1", "chat");
  assert.equal(first.completed, true);
  assert.equal(first.points, 3);
  assert.equal(await getUserPoints(env, "user:1"), 3);

  const second = await completeTask(env, "user:1", "chat");
  assert.equal(second.completed, false);
  assert.equal(second.alreadyDone, true);
  assert.equal(await getUserPoints(env, "user:1"), 3, "重复调用不应再次加分");
  assert.equal(db.count("daily_tasks", "task = 'chat'"), 1);

  const log = db.get("SELECT reason, change_amount FROM points_log ORDER BY id DESC LIMIT 1");
  assert.match(log.reason, /每日任务/);
  assert.equal(log.change_amount, 3);
  db.close();
});

test("四个任务全部完成时发放全勤奖（每天一次）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);

  let last = null;
  for (const key of TASK_KEYS) last = await completeTask(env, "user:1", key);

  assert.equal(last.allDone, true, "最后一个任务应触发全勤");
  assert.equal(last.bonus, DAILY_TASK_ALL_BONUS);

  const taskPoints = DAILY_TASKS.reduce((n, t) => n + t.points, 0);
  assert.equal(await getUserPoints(env, "user:1"), taskPoints + DAILY_TASK_ALL_BONUS);
  assert.equal(db.count("daily_tasks", `task = '${TASK_ALL_KEY}'`), 1);

  // 再完成一次已做过的任务，不应重复发全勤
  const again = await completeTask(env, "user:1", "chat");
  assert.equal(again.completed, false);
  assert.equal(await getUserPoints(env, "user:1"), taskPoints + DAILY_TASK_ALL_BONUS);
  db.close();
});

test("场景关闭每日任务时不累计、不发奖", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);
  await setFeature(env, GLOBAL_SCOPE, "tasks", false);

  const res = await completeTask(env, "user:1", "checkin", { sceneKey: "private:1" });
  assert.equal(res.completed, false);
  assert.equal(res.disabled, true);
  assert.equal(await getUserPoints(env, "user:1"), 0);
  assert.equal(db.count("daily_tasks"), 0);
  db.close();
});

test("不存在的任务与没有数据库时都安全返回", async () => {
  assert.deepEqual(await completeTask({}, "user:1", "chat"), { completed: false });

  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 0);
  assert.deepEqual(await completeTask(env, "user:1", "not-a-task"), { completed: false });
  assert.equal(await getUserPoints(env, "user:1"), 0);
  db.close();
});
