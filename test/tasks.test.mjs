// ==========================================
// ✅ 每日任务（v2.1.0：任务定义存数据库，可增删改）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import {
  completeTask, getTodayTasks, listTaskDefs, getEnabledTaskDefs, getTaskDef,
  createTaskDef, updateTaskDef, deleteTaskDef, getTaskBonus, setTaskBonus
} from "../src/services/tasks.js";
import { TASK_TRIGGERS, TRIGGER_KEYS, DEFAULT_TASK_BONUS } from "../src/config/tasks.js";
import { getUserPoints } from "../src/services/users.js";

/** 造两个默认任务：签到 5 分、聊天 3 分 */
function seedDefs(db) {
  db.exec(`
    INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order) VALUES
      ('checkin', '签到任务', '发 /checkin', 5, 1, 1),
      ('chat', '聊天任务', '发消息给我', 3, 1, 2);
  `);
}

test("触发条件定义完整（key 唯一、奖励为正、有文案）", () => {
  const keys = TASK_TRIGGERS.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const t of TASK_TRIGGERS) {
    assert.ok(t.points > 0, `${t.key} 奖励应为正`);
    assert.ok(t.label && t.hint, `${t.key} 缺少文案`);
  }
  assert.ok(TRIGGER_KEYS.includes("redeem"));
  assert.ok(DEFAULT_TASK_BONUS > 0);
});

test("任务 CRUD：创建校验、修改、删除", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  // 校验
  assert.equal((await createTaskDef(env, { trigger: "nope", label: "x", points: 1 })).ok, false);
  assert.equal((await createTaskDef(env, { trigger: "chat", label: "  ", points: 1 })).ok, false);
  assert.equal((await createTaskDef(env, { trigger: "chat", label: "x", points: 0 })).ok, false);
  assert.equal((await createTaskDef(env, { trigger: "chat", label: "x", points: 99999 })).ok, false);

  const created = await createTaskDef(env, { trigger: "game", label: "玩一局", hint: "发 /game", points: 4 });
  assert.equal(created.ok, true);
  assert.equal(await listTaskDefs(env).then((d) => d.length), 1);

  // 修改
  assert.equal((await updateTaskDef(env, created.id, { points: -1 })).ok, false);
  assert.equal((await updateTaskDef(env, created.id, { label: "" })).ok, false);
  assert.equal((await updateTaskDef(env, 9999, { label: "x" })).ok, false);
  assert.equal((await updateTaskDef(env, created.id, { label: "玩一局游戏", points: 6 })).ok, true);

  const after = await getTaskDef(env, created.id);
  assert.equal(after.label, "玩一局游戏");
  assert.equal(after.points, 6);
  assert.equal(after.hint, "发 /game", "未传的字段保持不变");

  // 停用后不再出现在启用列表
  await updateTaskDef(env, created.id, { enabled: false });
  assert.equal((await getEnabledTaskDefs(env)).length, 0);

  // 删除
  assert.equal(await deleteTaskDef(env, created.id), true);
  assert.equal(await deleteTaskDef(env, created.id), false);
  assert.equal((await listTaskDefs(env)).length, 0);
  db.close();
});

test("completeTask 结算该触发条件下的所有任务", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedDefs(db);
  // 再加一个同样由 chat 触发的任务
  await createTaskDef(env, { trigger: "chat", label: "多聊一句", points: 2 });
  seedUser(db, "user:1", 0);

  const res = await completeTask(env, "user:1", "chat");
  assert.equal(res.completed, true);
  assert.equal(res.points, 5, "3 + 2 两个任务都要发");
  assert.equal(await getUserPoints(env, "user:1"), 5);

  // 重复触发不再发奖
  const again = await completeTask(env, "user:1", "chat");
  assert.equal(again.completed, false);
  assert.equal(again.alreadyDone, true);
  assert.equal(await getUserPoints(env, "user:1"), 5);

  // 未绑定该触发条件的任务不受影响
  assert.equal(db.count("daily_tasks", "task = 't1'"), 0, "签到任务还没完成");
  db.close();
});

test("停用的任务不结算；删除的任务不影响已有进度", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedDefs(db);
  seedUser(db, "user:1", 0);

  await updateTaskDef(env, 1, { enabled: false }); // 停用签到任务
  assert.equal((await completeTask(env, "user:1", "checkin")).completed, false);
  assert.equal(await getUserPoints(env, "user:1"), 0);

  // 完成任务后再删除定义，进度记录仍在
  await completeTask(env, "user:1", "chat");
  await deleteTaskDef(env, 2);
  assert.equal(db.count("daily_tasks", "task = 't2'"), 1, "历史进度保留");
  const progress = await getTodayTasks(env, "user:1");
  assert.equal(progress.total, 0, "任务被删除后列表为空");
  db.close();
});

test("全勤奖：全部完成才发，可配置，配 0 则不发", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedDefs(db);
  seedUser(db, "user:1", 0);

  assert.equal(await getTaskBonus(env), DEFAULT_TASK_BONUS);
  assert.equal(await setTaskBonus(env, 25), true);
  assert.equal(await getTaskBonus(env), 25);
  assert.equal(await setTaskBonus(env, -1), false);

  const first = await completeTask(env, "user:1", "checkin");
  assert.equal(first.allDone, false, "还有任务没完成");

  const second = await completeTask(env, "user:1", "chat");
  assert.equal(second.allDone, true);
  assert.equal(second.bonus, 25);
  assert.equal(await getUserPoints(env, "user:1"), 5 + 3 + 25);

  // 换个用户，把全勤奖设为 0 → 不发
  seedUser(db, "user:2", 0);
  await setTaskBonus(env, 0);
  await completeTask(env, "user:2", "checkin");
  const u2 = await completeTask(env, "user:2", "chat");
  assert.equal(u2.allDone, false);
  assert.equal(await getUserPoints(env, "user:2"), 8);
  db.close();
});

test("进度查询：完成情况、今日收益与全勤状态", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedDefs(db);
  seedUser(db, "user:1", 0);

  const before = await getTodayTasks(env, "user:1");
  assert.equal(before.total, 2);
  assert.equal(before.done, 0);
  assert.equal(before.allDone, false);

  await completeTask(env, "user:1", "checkin");
  const after = await getTodayTasks(env, "user:1");
  assert.equal(after.done, 1);
  assert.equal(after.earned, 5);
  assert.equal(after.tasks.find((t) => t.trigger === "checkin").done, true);
  assert.equal(after.tasks.find((t) => t.trigger === "chat").done, false);
  db.close();
});

test("没有数据库时安全返回", async () => {
  assert.deepEqual(await completeTask({}, "user:1", "chat"), { completed: false });
  assert.equal(await getTaskBonus({}), DEFAULT_TASK_BONUS);
  const defs = await listTaskDefs({});
  assert.ok(defs.length > 0, "无数据库时返回内置兜底定义供展示");
});
