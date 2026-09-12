// ==========================================
// ⏰ 定时任务：清理与概况
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { cleanupStaleData, collectDailySummary } from "../src/services/daily.js";
import { getDateKey, shiftDateKey } from "../src/services/time.js";

test("cleanupStaleData 清理过期会话/草稿并停用过期兑换码", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const nowSec = Math.floor(Date.now() / 1000);
  const today = getDateKey(env);

  db.exec(`
    INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('1', ${nowSec - 10});
    INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('2', ${nowSec + 999});
    INSERT INTO broadcast_drafts (chat_id, content, updated_at) VALUES ('1', 'x', datetime('now','-8 days'));
    INSERT INTO broadcast_drafts (chat_id, content, updated_at) VALUES ('2', 'y', datetime('now'));
    INSERT INTO shop_order_drafts (chat_id, item_id, note, updated_at) VALUES ('1', 1, 'old', datetime('now','-2 days'));
    INSERT INTO shop_add_sessions (chat_id, updated_at) VALUES ('1', datetime('now','-2 days'));
    INSERT INTO shop_edit_sessions (chat_id, item_id, field, updated_at) VALUES ('1', 1, 'price', datetime('now','-2 days'));
    INSERT INTO redeem_codes (code, points, expires_at) VALUES ('TGEXPIRED0', 10, '${shiftDateKey(today, -1)}');
    INSERT INTO redeem_codes (code, points, expires_at) VALUES ('TGFUTURE00', 10, '${shiftDateKey(today, 3)}');
  `);

  const result = await cleanupStaleData(env);
  assert.equal(result.adminSessions, 1, "只删过期的管理员会话");
  assert.equal(result.broadcastDrafts, 1);
  assert.equal(result.orderDrafts, 1);
  assert.equal(result.addSessions, 1);
  assert.equal(result.editSessions, 1);
  assert.equal(result.expiredCodes, 1, "只停用已过期的兑换码");

  assert.equal(db.count("admin_sessions"), 1, "未过期的会话要保留");
  assert.equal(db.get("SELECT enabled FROM redeem_codes WHERE code = 'TGEXPIRED0'").enabled, 0);
  assert.equal(db.get("SELECT enabled FROM redeem_codes WHERE code = 'TGFUTURE00'").enabled, 1);
  db.close();
});

test("collectDailySummary 统计昨日数据与待处理订单", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const today = getDateKey(env);
  const yesterday = shiftDateKey(today, -1);
  const beforeYesterday = shiftDateKey(today, -2);

  db.exec(`
    INSERT INTO daily_stats (scene_key, date_str, count) VALUES ('private:1', '${yesterday}', 3);
    INSERT INTO daily_stats (scene_key, date_str, count) VALUES ('private:2', '${yesterday}', 2);
    INSERT INTO daily_stats (scene_key, date_str, count) VALUES ('private:3', '${beforeYesterday}', 99);
    INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:1', '${yesterday}');
    INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:2', '${yesterday}');
    INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:3', '${today}');
  `);
  seedUser(db, "user:1", 10);
  db.exec(`UPDATE users SET blocked = 1 WHERE user_key = 'user:1'`);
  const itemId = 1;
  db.exec(`
    INSERT INTO shop_items (name, price) VALUES ('测试', 10);
    INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, price, status)
      VALUES ('SA1', 'user:1', '1', '1', ${itemId}, '测试', 10, 'pending');
    INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, price, status)
      VALUES ('SA2', 'user:1', '1', '1', ${itemId}, '测试', 10, 'done');
    INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, price, status)
      VALUES ('SA3', 'user:1', '1', '1', ${itemId}, '测试', 10, 'pending');
  `);
  db.exec(`INSERT INTO redeem_logs (code_id, code, user_key, points, created_at)
           VALUES (1, 'TGX', 'user:1', 5, datetime('now','-2 hours'))`);

  const summary = await collectDailySummary(env);
  assert.equal(summary.today, today);
  assert.equal(summary.yesterday, yesterday);
  assert.equal(summary.messages, 5, "只统计昨天的消息量");
  assert.equal(summary.activeScenes, 2, "只统计昨天活跃的场景");
  assert.equal(summary.checkins, 2, "只统计昨天签到人数");
  assert.equal(summary.pendingOrders, 2);
  assert.equal(summary.pendingList.length, 2, "待处理订单列表最多 5 条");
  assert.equal(summary.pendingList[0].order_no, "SA1", "按最早的排前面");
  assert.equal(summary.blocked, 1);
  assert.equal(summary.redeems24h, 1);
  db.close();
});

test("没有数据库时定时任务不报错", async () => {
  assert.equal(await cleanupStaleData({}), null);
  const summary = await collectDailySummary({});
  assert.equal(summary.pendingOrders, 0);
  assert.deepEqual(summary.pendingList, []);
});
