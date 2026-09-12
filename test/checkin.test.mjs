// ==========================================
// 📅 签到：连续天数与递增奖励
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import { calcCheckinReward, computeCheckinStreak } from "../src/services/checkin.js";
import { shiftDateKey, isPreviousDay, getDateKey } from "../src/services/time.js";

test("shiftDateKey 跨月/跨年/闰年正确", () => {
  assert.equal(shiftDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDateKey("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDateKey("bad-input", 1), "");
});

test("isPreviousDay 判断相邻两天", () => {
  assert.equal(isPreviousDay("2026-09-11", "2026-09-12"), true);
  assert.equal(isPreviousDay("2026-09-10", "2026-09-12"), false);
});

test("连续签到奖励：递增 + 每 7 天里程碑 + 上限", () => {
  assert.equal(calcCheckinReward(1).total, 5);
  assert.equal(calcCheckinReward(2).total, 6);
  assert.equal(calcCheckinReward(6).total, 10);
  assert.equal(calcCheckinReward(7).total, 31, "第 7 天应有 +20 里程碑");
  assert.equal(calcCheckinReward(8).total, 12);
  assert.equal(calcCheckinReward(16).total, 20, "递增到 20 分封顶");
  assert.equal(calcCheckinReward(100).total, 20);
  assert.equal(calcCheckinReward(14).milestone, 20);
});

test("computeCheckinStreak 按连续日期计算，断签即断开", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const today = getDateKey(env);

  // 连续 3 天：今天、昨天、前天
  for (const offset of [0, -1, -2]) {
    db.exec(`INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:1', '${shiftDateKey(today, offset)}')`);
  }
  assert.equal(await computeCheckinStreak(env, "user:1", today), 3);

  // 中间断一天：4 天前有记录，但 -3 缺失，所以连续天数仍是 3
  db.exec(`INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:1', '${shiftDateKey(today, -4)}')`);
  assert.equal(await computeCheckinStreak(env, "user:1", today), 3);

  // 没签到的人返回 0
  assert.equal(await computeCheckinStreak(env, "user:nobody", today), 0);
  db.close();
});
