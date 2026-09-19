// ==========================================
// 🛒 商城加固（v3.8.0）
//
// 三件事（都来自代码审查）：
//   1. **限购原子化**：原先「先 SELECT 计数、再 INSERT」，并发双击会都读到未超限 →
//      两份订单 + 两次扣分 + 两次扣库存，只能靠事后重新计数取消多出来的那一单。
//      现在把限购条件写进 INSERT 本体。
//   2. **部分使用不退全款**：一个订单买 2 件、只用掉 1 件时，原先会把**全款**退回去、
//      却只回收剩下那 1 件 —— 等于白送用掉的那件。现在「只要有一件被用过就整单不可退」。
//   3. **兑换积分必须 ≤ 售价**：否则「买 1 分兑 100 分」是稳定套利，会把积分经济冲垮。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { handleCallback } from "../src/handlers/callback.js";
import { getUserPoints } from "../src/services/users.js";
import { handleAddItemInput } from "../src/shop/add.js";
import { handleEditItemInput } from "../src/shop/edit.js";
import { refundDoneOrder } from "../src/shop/actions.js";

let apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  apiCalls.push({ method, body: opts.body ? JSON.parse(opts.body) : {} });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 7 } })
  };
};
const resetCalls = () => { apiCalls.length = 0; };
const textsSent = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));

const USER = "user:1";
const CHAT = "1";
const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai" });
const makeCtx = () => ({ pending: [], waitUntil(p) { this.pending.push(p); } });
const userUctx = (userId = "1") => ({
  chatId: userId, userId, chatType: "private",
  userKey: `user:${userId}`, sceneKey: `private:${userId}`,
  username: `u${userId}`, firstName: `用户${userId}`
});

const click = (env, ctx, data, userId = "1", token = "T") => handleCallback({
  env, ctx, token, myId: "999", uctx: userUctx(userId),
  payload: {
    callback_query: {
      id: `cb_${data}`, from: { id: Number(userId) }, data,
      message: { message_id: 10, chat: { id: Number(userId), type: "private" } }
    }
  }
});

/** 造一个已完成订单 + 若干背包物品（用过的/没用的各按 counts 指定） */
function seedDoneOrder(db, { price = 100, unused = 1, used = 0 } = {}) {
  const itemId = seedItem(db, { name: "背包物品", price, stock: -1, delivery: "bag", useType: "points", useValue: 50 });
  db.exec(
    `INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, price, status)
     VALUES ('S${Date.now()}${Math.floor(Math.random() * 1000)}', '${USER}', '1', '${CHAT}', ${itemId}, '背包物品', ${price}, 'done')`
  );
  const order = db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
  const addBag = (status) => db.exec(
    `INSERT INTO user_bag_items (user_key, user_id, item_id, item_name, order_id, status, use_type, use_value)
     VALUES ('${USER}', '1', ${itemId}, '背包物品', ${order.id}, '${status}', 'points', 50)`
  );
  for (let i = 0; i < unused; i++) addBag("unused");
  for (let i = 0; i < used; i++) addBag("used");
  return { order, itemId };
}

// ==========================================
// 1) 限购原子化
// ==========================================

test("限购：连点两次「确认兑换」只会成一单，也只扣一次积分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const itemId = seedItem(db, { name: "限购商品", price: 100, stock: 3, delivery: "bag", useType: "none" });
  db.exec(`UPDATE shop_items SET per_user_limit = 1 WHERE id = ${itemId}`);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  const afterFirst = await getUserPoints(env, USER);
  resetCalls();
  await click(env, ctx, `shop_buy_${itemId}`);   // 连点

  assert.equal(afterFirst, 900, "第一次应正常扣款");
  assert.equal(await getUserPoints(env, USER), 900, "第二次绝不能再扣一次");
  assert.equal(
    db.count("shop_orders", "user_key = ? AND item_id = ? AND status NOT IN ('cancelled','refunded')", USER, itemId),
    1,
    "有效订单只能有 1 单"
  );
  assert.equal(db.count("shop_orders", "user_key = ? AND item_id = ?", USER, itemId), 1, "不该留下多余的取消单（原子插入应该直接挡住）");
  const stock = Number(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock);
  assert.equal(stock, 2, "库存只该扣一次");
  assert.ok(textsSent().some((t) => /限购/.test(t)), "要告诉用户达到限购");
  db.close();
});

test("限购：取消订单后名额释放，可以再买", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const itemId = seedItem(db, { name: "限购商品", price: 100, stock: 3, delivery: "manual" });
  db.exec(`UPDATE shop_items SET per_user_limit = 1 WHERE id = ${itemId}`);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  // 人为把订单标成 cancelled（模拟用户自己取消）
  db.exec("UPDATE shop_orders SET status = 'cancelled'");
  const before = await getUserPoints(env, USER);
  resetCalls();
  await click(env, ctx, `shop_buy_${itemId}`);

  assert.equal(await getUserPoints(env, USER), before - 100, "取消后应能再买一次");
  assert.equal(db.count("shop_orders", "user_key = ? AND status = 'pending'", USER), 1);
  db.close();
});

// ==========================================
// 2) 部分使用不退全款
// ==========================================

test("退款：订单里只要有一件被用过，整单不可退", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const { order } = seedDoneOrder(db, { price: 100, unused: 1, used: 1 });
  const env = makeEnv(db);
  const before = await getUserPoints(env, USER);

  const res = await refundDoneOrder(env, order, "user_refund", { requireReclaimable: true });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "used");
  assert.equal(await getUserPoints(env, USER), before, "不能退全款（否则白送用掉的那件）");
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", order.id).status, "done", "订单状态不能变");
  assert.equal(
    db.count("user_bag_items", "order_id = ? AND status = 'unused'", order.id),
    1,
    "没用掉的那件还留在背包里"
  );
  db.close();
});

test("退款：全部未使用才允许整单退（对照）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const { order } = seedDoneOrder(db, { price: 100, unused: 2, used: 0 });
  const env = makeEnv(db);
  const before = await getUserPoints(env, USER);

  const res = await refundDoneOrder(env, order, "user_refund", { requireReclaimable: true });

  assert.equal(res.ok, true);
  assert.equal(await getUserPoints(env, USER), before + 100, "全款退回");
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", order.id).status, "refunded");
  assert.equal(db.count("user_bag_items", "order_id = ? AND status = 'unused'", order.id), 0, "物品都被收回");
  assert.equal(db.count("user_bag_items", "order_id = ? AND status = 'refunded'", order.id), 2);
  db.close();
});

// ==========================================
// 3) 兑换积分 ≤ 售价
// ==========================================

test("添加商品：兑换积分数超过售价会被拒，且不落库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  // 造一个「已到第 9 步、售价 10」的添加会话
  db.exec(
    `INSERT INTO shop_add_sessions (chat_id, step, name, price, stock, category, icon, description, delivery, use_type, use_value)
     VALUES ('999', 9, '测试商品', 10, -1, 'virtual', '🎁', '', 'bag', 'points', 0)`
  );
  resetCalls();

  await handleAddItemInput({ env, token: "T", chatId: "999", userText: "100", adminId: "999" });

  const sess = db.get("SELECT use_value FROM shop_add_sessions WHERE chat_id = '999'");
  assert.equal(Number(sess.use_value), 0, "超出售价的兑换值不能被写进会话");
  assert.ok(textsSent().some((t) => /售价/.test(t)), `要说明超了售价：${textsSent().join(" | ").slice(0, 100)}`);
  assert.equal(db.count("shop_items", "name = '测试商品'"), 0, "不能落库");
  db.close();
});

test("添加商品：兑换积分数等于售价是允许的（边界）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  db.exec(
    `INSERT INTO shop_add_sessions (chat_id, step, name, price, stock, category, icon, description, delivery, use_type, use_value)
     VALUES ('999', 9, '边界商品', 50, -1, 'virtual', '🎁', '', 'bag', 'points', 0)`
  );
  resetCalls();

  await handleAddItemInput({ env, token: "T", chatId: "999", userText: "50", adminId: "999" });

  assert.equal(db.count("shop_items", "name = '边界商品'"), 1, "等于售价应该放行并落库");
  const item = db.get("SELECT use_type, use_value, price FROM shop_items WHERE name = '边界商品'");
  assert.equal(Number(item.use_value), 50);
  assert.equal(Number(item.price), 50);
  db.close();
});

test("添加商品：免费商品不能设置「使用后兑换积分」", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  db.exec(
    `INSERT INTO shop_add_sessions (chat_id, step, name, price, stock, category, icon, description, delivery, use_type, use_value)
     VALUES ('999', 9, '免费商品', 0, -1, 'virtual', '🎁', '', 'bag', 'points', 0)`
  );
  resetCalls();

  await handleAddItemInput({ env, token: "T", chatId: "999", userText: "10", adminId: "999" });

  assert.equal(db.count("shop_items", "name = '免费商品'"), 0, "免费 + 换积分 = 无限刷分，必须拦住");
  assert.ok(textsSent().some((t) => /免费商品/.test(t)));
  db.close();
});

// ==========================================
// 4) 改价不能绕过「兑换积分 ≤ 售价」（v3.9.0）
//
// 添加 / 编辑「用法」时都会拦超售价的兑换值，但**改价分支原先只看整数**：
// 先配「售价 100、兑换 100」（合法），再把售价改成 1 —— 就成了买 1 分兑 100 分。
// ==========================================

/** 造一个「售价 = 兑换值」的商品，并开好改价会话 */
function seedPriceEditSession(db, { price = 100, useValue = 100 } = {}) {
  const itemId = seedItem(db, {
    name: "套利商品", price, stock: -1, delivery: "bag", useType: "points", useValue
  });
  db.exec(`INSERT INTO shop_edit_sessions (chat_id, item_id, field) VALUES ('999', ${itemId}, 'price')`);
  return itemId;
}

test("改价：不能把售价压到低于已配置的兑换积分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const itemId = seedPriceEditSession(db, { price: 100, useValue: 100 });
  resetCalls();

  await handleEditItemInput({ env, token: "T", chatId: "999", userText: "1", adminId: "999" });

  const item = db.get("SELECT price, use_value FROM shop_items WHERE id = ?", itemId);
  assert.equal(Number(item.price), 100, "价格不能被压到兑换值以下（否则 1 分买、100 分兑）");
  assert.equal(Number(item.use_value), 100, "兑换值不该被悄悄改掉");
  assert.ok(
    textsSent().some((t) => /白送分/.test(t)),
    `要说明为什么拒绝：${textsSent().join(" | ").slice(0, 120)}`
  );
  db.close();
});

test("改价：不低于兑换积分时正常生效（边界）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);

  // 等于兑换值：允许
  const a = seedPriceEditSession(db, { price: 100, useValue: 100 });
  resetCalls();
  await handleEditItemInput({ env, token: "T", chatId: "999", userText: "100", adminId: "999" });
  assert.equal(Number(db.get("SELECT price FROM shop_items WHERE id = ?", a).price), 100);

  // 高于兑换值：允许
  const b = seedPriceEditSession(db, { price: 100, useValue: 100 });
  resetCalls();
  await handleEditItemInput({ env, token: "T", chatId: "999", userText: "150", adminId: "999" });
  assert.equal(Number(db.get("SELECT price FROM shop_items WHERE id = ?", b).price), 150);
  db.close();
});

test("改价：与背包用法无关的商品不受限制", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const itemId = seedItem(db, { name: "普通商品", price: 100, stock: -1, delivery: "manual", useType: "none" });
  db.exec(`INSERT INTO shop_edit_sessions (chat_id, item_id, field) VALUES ('999', ${itemId}, 'price')`);
  resetCalls();

  await handleEditItemInput({ env, token: "T", chatId: "999", userText: "1", adminId: "999" });

  assert.equal(Number(db.get("SELECT price FROM shop_items WHERE id = ?", itemId).price), 1, "没有兑换用法的商品可以自由改价");
  db.close();
});
