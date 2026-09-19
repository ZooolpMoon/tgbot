// ==========================================
// 🎒 商城 · 我的背包 + 已完成订单退款
//
// 覆盖：Schema 迁移与背包表、购买「进背包」商品即入库、使用（换积分 / 仅核销）、
//       重复使用不重复发奖、自助退款（回收未使用物品）、已使用不能退、
//       管理员退款、退款后不再占限购名额、菜单排版。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { validateKeyboard } from "../src/utils/layout.js";

let apiCalls = [];

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  const ok = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result })
  });
  return ok({ message_id: 99 });
};

const resetCalls = () => { apiCalls = []; };
const textsTo = (chatId) => apiCalls
  .filter((c) => String(c.body?.chat_id) === String(chatId) && c.body?.text)
  .map((c) => String(c.body.text));
// Telegram 的接口名是 answerCallbackQuery，这里按真实方法名过滤
const answers = () => apiCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.body?.text || ""));
const lastEdit = () => apiCalls.filter((c) => c.method === "editMessageText").at(-1)?.body || null;

const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "TEST_TOKEN", BOT_USERNAME: "TestBot",
  MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai", ...extra
});

const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

const userUctx = (userId = "1") => ({
  chatId: userId, userId, chatType: "private",
  userKey: `user:${userId}`, sceneKey: `private:${userId}`,
  username: `u${userId}`, firstName: `用户${userId}`
});

const { handleCallback } = await import("../src/handlers/callback.js");

const click = (env, ctx, data, userId = "1") => {
  const uctx = userUctx(userId);
  return handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx,
    payload: {
      callback_query: {
        id: `cb_${data}`, from: { id: Number(userId) }, data,
        message: { message_id: 10, chat: { id: Number(userId), type: "private" } }
      }
    }
  });
};

/** 买一件「进背包」商品，返回 { itemId, orderId, bagId } */
async function buyBagItem(env, ctx, db, { price = 100, useType = "points", useValue = 50, stock = 5 } = {}) {
  const itemId = seedItem(db, { name: "背包物品", price, stock, delivery: "bag", useType, useValue });
  await click(env, ctx, `shop_buy_${itemId}`);
  const order = db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
  const bag = db.get("SELECT * FROM user_bag_items ORDER BY id DESC LIMIT 1");
  return { itemId, orderId: Number(order?.id), bagId: Number(bag?.id) };
}

// ==========================================
// 1. Schema
// ==========================================

test("Schema：shop_items 有背包字段，user_bag_items 表结构完整", { skip: !hasSqlite && "需要 node:sqlite" }, () => {
  const db = createTestDB();

  const itemCols = db.all("SELECT name FROM pragma_table_info('shop_items')").map((r) => r.name);
  for (const col of ["delivery", "use_type", "use_value"]) {
    assert.ok(itemCols.includes(col), `shop_items 缺少 ${col}`);
  }

  const bagCols = db.all("SELECT name FROM pragma_table_info('user_bag_items')").map((r) => r.name);
  for (const col of ["user_key", "item_id", "order_id", "status", "use_type", "use_value", "obtained_at", "used_at"]) {
    assert.ok(bagCols.includes(col), `user_bag_items 缺少 ${col}`);
  }

  const addCols = db.all("SELECT name FROM pragma_table_info('shop_add_sessions')").map((r) => r.name);
  for (const col of ["delivery", "use_type", "use_value"]) {
    assert.ok(addCols.includes(col), `shop_add_sessions 缺少 ${col}`);
  }
  db.close();
});

test("Schema 迁移：老库补上背包字段并建出 user_bag_items", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB({ withSchema: false });
  // 模拟 v3.2 的老库：shop_items / shop_add_sessions 都没有背包相关字段
  db.exec(`
    CREATE TABLE shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT DEFAULT '', icon TEXT DEFAULT '🎁',
      price INTEGER NOT NULL, stock INTEGER DEFAULT -1, category TEXT DEFAULT 'virtual',
      per_user_limit INTEGER DEFAULT 0, delivery TEXT DEFAULT 'manual',
      enabled INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE shop_add_sessions (
      chat_id TEXT PRIMARY KEY, step INTEGER NOT NULL DEFAULT 1, name TEXT DEFAULT '',
      price INTEGER DEFAULT 0, stock INTEGER DEFAULT -1, category TEXT DEFAULT 'virtual',
      icon TEXT DEFAULT '', description TEXT DEFAULT '', updated_at TEXT
    );
    INSERT INTO shop_items (name, price, stock) VALUES ('老商品', 10, 5);
  `);

  const { ensureSchema } = await import(`../src/core/db.js?bag=${Date.now()}`);
  await ensureSchema({ DB: db });

  const itemCols = db.all("SELECT name FROM pragma_table_info('shop_items')").map((r) => r.name);
  assert.ok(itemCols.includes("use_type"), "迁移后应补上 shop_items.use_type");
  assert.ok(itemCols.includes("use_value"), "迁移后应补上 shop_items.use_value");
  assert.equal(db.get("SELECT name FROM shop_items WHERE id = 1").name, "老商品", "迁移不应破坏已有数据");

  const tables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  assert.ok(tables.has("user_bag_items"), "迁移应建出 user_bag_items");
  db.close();
});

// ==========================================
// 2. 购买即入库
// ==========================================

test("购买「进背包」商品：下单即完成、物品入包、不通知管理员", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const itemId = seedItem(db, { price: 100, stock: 5, delivery: "bag", useType: "points", useValue: 50 });
  await click(env, ctx, `shop_buy_${itemId}`);

  const order = db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
  assert.equal(order.status, "done", "自动发放的订单下单即完成");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 900, "应扣 100 积分");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 4, "库存应 -1");

  const bag = db.get("SELECT * FROM user_bag_items ORDER BY id DESC LIMIT 1");
  assert.equal(bag.status, "unused");
  assert.equal(bag.use_type, "points", "用法按下单时的快照保存");
  assert.equal(bag.use_value, 50);
  assert.equal(Number(bag.order_id), Number(order.id));

  assert.ok(
    !textsTo("999").some((t) => /新订单|待处理/.test(t)),
    "进背包的商品不该通知管理员发货"
  );
  const panel = lastEdit();
  assert.ok(panel, "应刷新成兑换成功卡片");
  assert.match(String(panel.text), /我的背包/);
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 3. 使用
// ==========================================

test("使用「换积分」物品：积分到账、物品标记已用、重复点不重复发", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const { bagId } = await buyBagItem(env, ctx, db, { price: 100, useType: "points", useValue: 50 });
  assert.equal(bagId > 0, true, "应有一件背包物品");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 900);

  await click(env, ctx, `shop_bag_use_${bagId}_1`);
  assert.equal(db.get("SELECT status FROM user_bag_items WHERE id = ?", bagId).status, "used");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 950, "使用后应 +50 积分");

  const flow = db.get("SELECT change_amount, reason FROM points_log ORDER BY id DESC LIMIT 1");
  assert.equal(flow.change_amount, 50);
  assert.match(flow.reason, /背包物品/);

  // 连点第二次：不能再发一次
  resetCalls();
  await click(env, ctx, `shop_bag_use_${bagId}_1`);
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 950, "不能重复发奖");
  assert.ok(answers().some((t) => /已经用过/.test(t)), "应提示物品已经用过");
  await Promise.all(ctx.pending);
  db.close();
});

test("使用「仅核销」物品：标记已用并通知管理员", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const { bagId } = await buyBagItem(env, ctx, db, { price: 30, useType: "none", useValue: 0 });
  resetCalls();

  await click(env, ctx, `shop_bag_use_${bagId}_1`);
  assert.equal(db.get("SELECT status FROM user_bag_items WHERE id = ?", bagId).status, "used");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 970, "仅核销不该改积分");
  assert.ok(
    textsTo("999").some((t) => /背包物品待核销/.test(t)),
    "应通知管理员核销"
  );
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 4. 退款
// ==========================================

test("自助退款：回收未使用的背包物品 + 退积分 + 回滚库存", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const { itemId, orderId } = await buyBagItem(env, ctx, db, { price: 100, stock: 5 });
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 4);

  resetCalls();
  await click(env, ctx, `shop_urefund_${orderId}_1`);

  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "refunded");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 1000, "应退回 100 积分");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 5, "库存应回滚");
  assert.equal(
    db.get("SELECT status FROM user_bag_items WHERE order_id = ?", orderId).status, "refunded",
    "未使用的物品应被收回"
  );
  const log = db.get("SELECT action, note FROM shop_order_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.action, "refunded");
  assert.equal(log.note, "user_refund");
  assert.ok(textsTo("999").some((t) => /用户自助退款/.test(t)), "应同步通知管理员");
  await Promise.all(ctx.pending);
  db.close();
});

test("重复退款只退一次（原子状态流转）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const { itemId, orderId } = await buyBagItem(env, ctx, db, { price: 100, stock: 5 });
  await click(env, ctx, `shop_urefund_${orderId}_1`);
  await click(env, ctx, `shop_urefund_${orderId}_1`);

  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 1000, "只应退一次");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 5, "库存只回滚一次");
  assert.equal(db.count("shop_order_log", "action = 'refunded'"), 1);
  await Promise.all(ctx.pending);
  db.close();
});

test("物品已经用过：不能再退款（用户与管理员都不行）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const { itemId, orderId, bagId } = await buyBagItem(env, ctx, db, { price: 100, stock: 5 });
  await click(env, ctx, `shop_bag_use_${bagId}_1`);
  resetCalls();

  await click(env, ctx, `shop_urefund_${orderId}_1`);
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "done", "已使用的订单不该被退款");
  assert.ok(answers().some((t) => /不能退款/.test(t)));

  // 管理员也不能退：东西已经交付了
  resetCalls();
  await click(env, ctx, `shop_admin_refund_${orderId}_1`, "999");
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "done");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 4, "库存不该回滚");
  assert.ok(answers().some((t) => /不能退款/.test(t)));
  await Promise.all(ctx.pending);
  db.close();
});

test("管理员可退款已完成的人工发放订单（没有背包物品）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedItem(db, { price: 20, stock: 3 });
  db.exec(
    `INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status)
     VALUES ('SADMIN1', 'user:1', '1', '1', ${itemId}, '测试商品', '🎁', 20, 'done')`
  );
  db.exec("UPDATE users SET points = 980 WHERE user_key = 'user:1'");
  const orderId = Number(db.get("SELECT id FROM shop_orders WHERE order_no = 'SADMIN1'").id);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, `shop_admin_refund_${orderId}_1`, "999");

  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "refunded");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 1000);
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 4);
  await Promise.all(ctx.pending);
  db.close();
});

test("已退款 / 已取消的订单不再占用限购名额", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const itemId = seedItem(db, { price: 10, stock: -1, delivery: "bag", useType: "points", useValue: 5 });
  db.exec(`UPDATE shop_items SET per_user_limit = 1 WHERE id = ${itemId}`);

  await click(env, ctx, `shop_buy_${itemId}`);
  const first = db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
  await click(env, ctx, `shop_buy_${itemId}`);
  assert.equal(db.count("shop_orders"), 1, "达到限购后不应再生成订单");

  await click(env, ctx, `shop_urefund_${first.id}_1`);
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", first.id).status, "refunded");

  await click(env, ctx, `shop_buy_${itemId}`);
  assert.equal(db.count("shop_orders"), 2, "退款后应能再次购买");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 5. 菜单排版
// ==========================================

test("背包与商城首页菜单：不超过 8 行、按钮文案不超长", async () => {
  const { getBagKeyboard } = await import("../src/shop/bag.js");
  const { getShopHomeKeyboard, getMyOrdersKeyboard } = await import("../src/shop/index.js");

  const bagItems = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, item_name: `一件名字特别长的背包物品${i}`, item_icon: "🎁", status: "unused"
  }));
  assert.deepEqual(validateKeyboard(getBagKeyboard(bagItems, 1, 2)), []);

  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `超长商品名称${i}`, icon: "🎁", price: 100
  }));
  const home = getShopHomeKeyboard(items, 1, 1);
  assert.deepEqual(validateKeyboard(home), []);
  assert.ok(
    home.inline_keyboard.flat().some((b) => b.callback_data === "shop_bag_1"),
    "商城首页应有背包入口"
  );

  const orders = [
    { id: 1, order_no: "S1ABCDEF230", status: "done", delivery: "bag", bag_unused: 1 },
    { id: 2, order_no: "S1ABCDEF231", status: "done", delivery: "bag", bag_unused: 0 }
  ];
  const orderKb = getMyOrdersKeyboard(orders, 1, 1);
  assert.deepEqual(validateKeyboard(orderKb), []);
  const datas = orderKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(datas.includes("shop_urefund_1_1"), "未使用的背包订单应有退款按钮");
  assert.ok(!datas.includes("shop_urefund_2_1"), "物品已用掉的订单不该给退款按钮");
});

// ==========================================
// 6. 管理员引导流程（发放方式 / 背包用法）
// ==========================================

test("引导式添加商品：发放方式选「进背包」+ 用法选「换积分」，落库带上用法快照", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const { startAddItem, handleAddItemInput } = await import("../src/shop/add.js");
  resetCalls();

  await startAddItem("TEST_TOKEN", env, "999");
  const say = (text) => handleAddItemInput({ env, token: "TEST_TOKEN", chatId: "999", userText: text, adminId: "999" });

  await say("幸运红包");
  await say("200");
  await say("-1");
  await say("1");     // 虚拟物品
  await say("-");     // 不填说明
  await say("🧧");    // 图标
  await say("3");     // 发放方式：进背包
  await say("2");     // 用法：使用后换积分
  await say("150");   // 兑换积分数（必须 ≤ 售价 200，否则等于白送分）

  const item = db.get("SELECT * FROM shop_items ORDER BY id DESC LIMIT 1");
  assert.equal(item.name, "幸运红包");
  assert.equal(item.delivery, "bag");
  assert.equal(item.use_type, "points");
  assert.equal(item.use_value, 150);
  assert.equal(db.count("shop_add_sessions"), 0, "会话应结束");
  db.close();
});

test("引导式编辑：改发放方式与背包用法，改回人工发放时清掉背包用法", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const itemId = seedItem(db, { price: 10 });
  const { startEditField, handleEditItemInput } = await import("../src/shop/edit.js");
  resetCalls();

  const edit = async (field, text) => {
    await startEditField({ env, token: "TEST_TOKEN", chatId: "999", itemId, field });
    await handleEditItemInput({ env, token: "TEST_TOKEN", chatId: "999", userText: text, adminId: "999" });
  };

  await edit("delivery", "3");
  await edit("use", "2 5");   // 兑换 5 分（售价 10，必须 ≤ 售价）
  let item = db.get("SELECT * FROM shop_items WHERE id = ?", itemId);
  assert.equal(item.delivery, "bag");
  assert.equal(item.use_type, "points");
  assert.equal(item.use_value, 5);

  // 改回人工发放：背包用法应被清掉，避免留下无意义的配置
  await edit("delivery", "1");
  item = db.get("SELECT * FROM shop_items WHERE id = ?", itemId);
  assert.equal(item.delivery, "manual");
  assert.equal(item.use_type, "none");
  assert.equal(item.use_value, 0);

  // 非法输入不应改库
  await edit("use", "9");
  item = db.get("SELECT * FROM shop_items WHERE id = ?", itemId);
  assert.equal(item.use_type, "none");
  db.close();
});
