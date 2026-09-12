// ==========================================
// 🛒 商城：取消退款与下单备注
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { cancelOrderWithRefund, getOrderById } from "../src/shop/actions.js";
import {
  beginOrderNote, saveOrderNote, getOrderNote, consumeOrderNote,
  getPendingNoteRequest, cancelOrderNote
} from "../src/shop/notes.js";
import { getUserPoints } from "../src/services/users.js";

function seedOrder(db, { userKey = "user:1", itemId = 1, price = 10, status = "pending", remark = "" } = {}) {
  db.exec(
    `INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status, remark)
     VALUES ('STEST${Math.random().toString(36).slice(2, 8).toUpperCase()}', '${userKey}', '1', '1', ${itemId}, '测试商品', '🎁', ${price}, '${status}', '${remark}')`
  );
  return db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
}

test("取消待处理订单：退积分 + 回滚库存 + 写日志", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 90);
  const itemId = seedItem(db, { price: 10, stock: 1 });
  const order = seedOrder(db, { itemId, price: 10 });

  const ok = await cancelOrderWithRefund(env, order, "test_cancel");
  assert.equal(ok, true);
  assert.equal(await getUserPoints(env, "user:1"), 100, "应退还 10 积分");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 2, "库存应 +1");

  const after = await getOrderById(env, order.id);
  assert.equal(after.status, "cancelled");
  const log = db.get("SELECT action, note FROM shop_order_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.action, "cancelled");
  assert.equal(log.note, "test_cancel");
  db.close();
});

test("重复取消不会重复退款（原子状态流转）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 90);
  const itemId = seedItem(db, { price: 10, stock: 3 });
  const order = seedOrder(db, { itemId, price: 10 });

  assert.equal(await cancelOrderWithRefund(env, order, "first"), true);
  assert.equal(await cancelOrderWithRefund(env, order, "second"), false, "第二次应返回 false");

  assert.equal(await getUserPoints(env, "user:1"), 100, "只应退一次");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 4, "库存只回滚一次");
  assert.equal(db.count("shop_order_log"), 1);
  db.close();
});

test("已完成订单不能被取消退款", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 90);
  const itemId = seedItem(db, { price: 10, stock: 1 });
  const order = seedOrder(db, { itemId, price: 10, status: "done" });

  assert.equal(await cancelOrderWithRefund(env, order, "should_fail"), false);
  assert.equal(await getUserPoints(env, "user:1"), 90, "不应退款");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 1, "不应回滚库存");
  db.close();
});

test("无限库存（-1）取消时不回滚", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedUser(db, "user:1", 90);
  const itemId = seedItem(db, { price: 10, stock: -1 });
  const order = seedOrder(db, { itemId, price: 10 });

  assert.equal(await cancelOrderWithRefund(env, order, "unlimited"), true);
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, -1);
  db.close();
});

test("下单备注：进入输入态 → 保存 → 下单时取走", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const itemId = seedItem(db);

  await beginOrderNote(env, "1", itemId);
  const pending = await getPendingNoteRequest(env, "1");
  assert.deepEqual(pending, { itemId }, "应进入等待输入状态");

  await saveOrderNote(env, "1", "  北京市朝阳区 xx 路 1 号，电话 138xxxx  ");
  assert.equal(await getPendingNoteRequest(env, "1"), null, "保存后应退出等待状态");
  assert.equal(await getOrderNote(env, "1", itemId), "北京市朝阳区 xx 路 1 号，电话 138xxxx");

  const consumed = await consumeOrderNote(env, "1", itemId);
  assert.equal(consumed, "北京市朝阳区 xx 路 1 号，电话 138xxxx");
  assert.equal(await getOrderNote(env, "1", itemId), "", "取走后应清空");
  assert.equal(db.count("shop_order_drafts"), 0);
  db.close();
});

test("备注：回复 - 清空、超长截断、换商品不串号、可取消", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const itemA = seedItem(db, { name: "商品A" });
  const itemB = seedItem(db, { name: "商品B" });

  await beginOrderNote(env, "1", itemA);
  await saveOrderNote(env, "1", "x".repeat(500));
  assert.equal((await getOrderNote(env, "1", itemA)).length, 300, "备注最长 300 字");

  await beginOrderNote(env, "1", itemA);
  await saveOrderNote(env, "1", "-");
  assert.equal(await getOrderNote(env, "1", itemA), "", "回复 - 应清空");

  // 给 B 备注后，A 不应读到 B 的备注
  await beginOrderNote(env, "1", itemB);
  await saveOrderNote(env, "1", "B 的地址");
  assert.equal(await getOrderNote(env, "1", itemA), "", "商品不一致时视为无备注");
  assert.equal(await getOrderNote(env, "1", itemB), "B 的地址");

  await cancelOrderNote(env, "1");
  assert.equal(db.count("shop_order_drafts"), 0, "取消后草稿应删除");
  db.close();
});

test("备注输入态超过 30 分钟自动失效，不再拦截普通消息", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const itemId = seedItem(db);

  await beginOrderNote(env, "1", itemId);
  assert.ok(await getPendingNoteRequest(env, "1"), "刚点开时应在等待输入");

  // 把状态改成 2 小时前
  db.exec("UPDATE shop_order_drafts SET updated_at = datetime('now','-2 hours') WHERE chat_id = '1'");
  assert.equal(await getPendingNoteRequest(env, "1"), null, "过期状态应视为失效");

  // 已保存的备注（pending=0）不受 TTL 影响，仍能读到
  await beginOrderNote(env, "1", itemId);
  await saveOrderNote(env, "1", "下单地址");
  db.exec("UPDATE shop_order_drafts SET updated_at = datetime('now','-2 hours') WHERE chat_id = '1'");
  assert.equal(await getOrderNote(env, "1", itemId), "下单地址");
  db.close();
});
