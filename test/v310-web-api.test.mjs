// ==========================================
// v3.10.2 守卫测试 · Web 后台数据接口
//
// 这些接口全部经过 handleWebAdmin（真实路由 + 真实 cookie），
// 不是直接调内部函数 —— 权限、路径、请求体解析都一起测到。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { handleWebAdmin, createLoginToken } from "../src/web/admin.js";
import { buildGroupScopeKey } from "../src/core/context.js";

globalThis.fetch = async () => ({
  ok: true, status: 200, headers: { get: () => null },
  json: async () => ({ ok: true, result: { message_id: 1 } })
});

function makeEnv(db) {
  return {
    DB: db,
    AI: { run: async () => ({ response: "ok" }) },
    MY_TELEGRAM_ID: "999",
    WEBHOOK_SECRET: "test-secret"
  };
}

/** 走真实登录流程拿 cookie */
async function loginAs(env, userId = "999") {
  const token = await createLoginToken(env, userId);
  const res = await handleWebAdmin(new Request(`https://x.test/admin?t=${token}`), env);
  return String(res.headers.get("set-cookie") || "").split(";")[0];
}

/** 带 cookie 调接口 */
function call(env, cookie, path, body) {
  return handleWebAdmin(new Request(`https://x.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  }), env);
}

// ==========================================
// 👥 用户
// ==========================================

test("Web 用户：能改每日额度与冷却，非法值会被拦下", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:1", 100);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name, max_daily, rate_limit_sec)
           VALUES ('private:1', 'user:1', '1', 'private', '1', '小明', 50, 5)`);
  const cookie = await loginAs(env);

  const ok = await (await call(env, cookie, "/admin/api/users/scene", {
    sceneKey: "private:1", maxDaily: -1, rateLimitSec: 30
  })).json();
  assert.equal(ok.ok, true);
  const row = db.get("SELECT max_daily, rate_limit_sec FROM user_scenes WHERE scene_key = 'private:1'");
  assert.equal(row.max_daily, -1, "-1 表示不限额度");
  assert.equal(row.rate_limit_sec, 30);

  // 越界值必须被拒绝，而且**不能改动数据**
  const bad = await (await call(env, cookie, "/admin/api/users/scene", {
    sceneKey: "private:1", maxDaily: -99
  })).json();
  assert.equal(bad.error, "bad-request");
  assert.equal(db.get("SELECT max_daily FROM user_scenes WHERE scene_key = 'private:1'").max_daily, -1);
  db.close();
});

test("Web 用户：清空记忆会连长期画像一起清掉", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:1", 100);
  db.exec("INSERT INTO chat_history (scene_key, messages) VALUES ('private:1', '[]')");
  db.exec("INSERT INTO user_memory (scene_key, summary) VALUES ('private:1', '旧画像')");
  const cookie = await loginAs(env);

  const res = await (await call(env, cookie, "/admin/api/users/clear-memory", { sceneKey: "private:1" })).json();
  assert.equal(res.ok, true);
  assert.equal(db.count("chat_history", "scene_key = 'private:1'"), 0);
  assert.equal(db.count("user_memory", "scene_key = 'private:1'"), 0, "画像不清掉等于没清干净");
  db.close();
});

test("Web 用户：封禁仍然拒绝机器人管理员", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:999", 100);
  db.exec("INSERT INTO bot_admins (user_id, role) VALUES ('7', 'moderator')");
  const cookie = await loginAs(env);

  const res = await (await call(env, cookie, "/admin/api/users/block", { userId: "7", blocked: true })).json();
  assert.equal(res.error, "failed", "复用指令侧的兜底：管理员封不了");
  // 被拒绝时连记录都不该建（banUserById 在写库之前就拦下了）
  assert.equal(db.count("users", "user_key = 'user:7'"), 0);
  db.close();
});

// ==========================================
// 👥 群组
// ==========================================

test("Web 群组：切开关写的是群级键，与 Telegram 面板同一个键", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
           VALUES ('group:-100:user:1', 'user:1', '-100', 'supergroup', '1', '小明')`);
  const cookie = await loginAs(env);

  const list = await (await call(env, cookie, "/admin/api/groups")).json();
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].chatId, "-100");
  assert.deepEqual(list.rows[0].overrides, {}, "没设置过就是空，跟随全局");

  const toggle = await (await call(env, cookie, "/admin/api/groups/feature", {
    chatId: "-100", feature: "automod", enabled: true
  })).json();
  assert.equal(toggle.ok, true);

  const row = db.get("SELECT scene_key, value FROM scene_settings WHERE name = 'feature.automod'");
  assert.equal(row.scene_key, buildGroupScopeKey("-100"), "必须是群级键，不能写成成员级");
  assert.equal(row.value, "on");

  // 再查列表时应该看得到这条覆盖
  const list2 = await (await call(env, cookie, "/admin/api/groups")).json();
  assert.equal(list2.rows[0].overrides.automod, true);
  db.close();
});

// ==========================================
// 🛒 商城
// ==========================================

test("Web 商城：改价不能低于「换积分」的兑换值（套利守卫）", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const itemId = seedItem(db, { name: "积分包", price: 100, useType: "points", useValue: 100 });
  const cookie = await loginAs(env);

  const bad = await (await call(env, cookie, "/admin/api/shop/item", { itemId, price: 1 })).json();
  assert.equal(bad.error, "bad-request", "售价低于兑换值必须被拦下");
  assert.match(bad.detail, /套利/);
  assert.equal(db.get("SELECT price FROM shop_items WHERE id = ?", itemId).price, 100, "价格没被改动");

  const ok = await (await call(env, cookie, "/admin/api/shop/item", { itemId, price: 200, stock: 3 })).json();
  assert.equal(ok.ok, true);
  const row = db.get("SELECT price, stock FROM shop_items WHERE id = ?", itemId);
  assert.equal(row.price, 200);
  assert.equal(row.stock, 3);
  db.close();
});

test("Web 商城：订单标记完成与取消退款", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:1", 100);
  const itemId = seedItem(db, { name: "手工服务", price: 40, stock: 5 });
  db.exec(`INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, item_icon, price, status)
           VALUES ('NO1', 'user:1', '1', '1', ${itemId}, '手工服务', '🎁', 40, 'pending')`);
  // 真实流程是「下单就扣分」，这里补上这一步，否则退款断言没有意义
  db.exec("UPDATE users SET points = 60 WHERE user_key = 'user:1'");
  // 下单同时也会扣库存（5 → 4），退款要能回滚回 5
  db.exec(`UPDATE shop_items SET stock = 4 WHERE id = ${itemId}`);
  const orderId = Number(db.get("SELECT id FROM shop_orders WHERE order_no = 'NO1'").id);
  const cookie = await loginAs(env);

  const done = await (await call(env, cookie, "/admin/api/shop/order", { orderId, action: "done" })).json();
  assert.equal(done.ok, true);
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "done");

  // 已完成的订单可以退款：退积分 + 回滚库存
  const refund = await (await call(env, cookie, "/admin/api/shop/order", { orderId, action: "refund" })).json();
  assert.equal(refund.ok, true);
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "refunded");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 100, "40 分退回");
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id = ?", itemId).stock, 5, "库存回滚");
  db.close();
});

test("Web 商城：取消退款只对「待处理」订单生效", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:1", 100);
  db.exec(`INSERT INTO shop_orders (order_no, user_key, user_id, chat_id, item_id, item_name, price, status)
           VALUES ('NO2', 'user:1', '1', '1', 1, '东西', 10, 'done')`);
  const orderId = Number(db.get("SELECT id FROM shop_orders WHERE order_no = 'NO2'").id);
  const cookie = await loginAs(env);

  const res = await (await call(env, cookie, "/admin/api/shop/order", { orderId, action: "cancel" })).json();
  assert.equal(res.error, "bad-request");
  assert.equal(db.get("SELECT status FROM shop_orders WHERE id = ?", orderId).status, "done");
  db.close();
});

// ==========================================
// 🎟️ 兑换码
// ==========================================

test("Web 兑换码：批量生成、列表、启停", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const cookie = await loginAs(env);

  const created = await (await call(env, cookie, "/admin/api/codes", {
    points: 50, count: 3, maxUses: 2, validDays: 7
  })).json();
  assert.equal(created.ok, true);
  assert.equal(created.codes.length, 3);
  assert.equal(db.count("redeem_codes"), 3);

  const list = await (await call(env, cookie, "/admin/api/codes")).json();
  assert.equal(list.total, 3);
  assert.equal(list.rows[0].points, 50);
  assert.equal(list.rows[0].maxUses, 2);
  assert.equal(list.rows[0].enabled, true);

  const toggle = await (await call(env, cookie, "/admin/api/codes/toggle", {
    codeId: list.rows[0].id, enabled: false
  })).json();
  assert.equal(toggle.ok, true);
  assert.equal(db.get("SELECT enabled FROM redeem_codes WHERE id = ?", list.rows[0].id).enabled, 0);

  // 非法积分要被拦下
  const bad = await (await call(env, cookie, "/admin/api/codes", { points: 0, count: 1 })).json();
  assert.equal(bad.error, "bad-request");
  assert.equal(db.count("redeem_codes"), 3, "不该多出记录");
  db.close();
});

// ==========================================
// 🔒 权限
// ==========================================

test("Web 权限：执法员能看列表，但改不了商城与兑换码", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  db.exec("INSERT INTO bot_admins (user_id, role) VALUES ('7', 'moderator')");
  seedItem(db, { name: "东西", price: 10 });
  const itemId = Number(db.get("SELECT id FROM shop_items ORDER BY id DESC LIMIT 1").id);
  const cookie = await loginAs(env, "7");

  // 只读接口放行（执法员本来就能看统计）
  const overview = await call(env, cookie, "/admin/api/overview");
  assert.equal(overview.status, 200);

  const shop = await (await call(env, cookie, "/admin/api/shop/item", { itemId, price: 999 })).json();
  assert.equal(shop.error, "forbidden");
  assert.equal(db.get("SELECT price FROM shop_items WHERE id = ?", itemId).price, 10, "价格没被改动");

  const codes = await (await call(env, cookie, "/admin/api/codes", { points: 100, count: 1 })).json();
  assert.equal(codes.error, "forbidden");
  assert.equal(db.count("redeem_codes"), 0);
  db.close();
});

test("Web 权限：登录后仍要带 cookie，匿名访问写接口一律 401", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  for (const path of [
    "/admin/api/users/block", "/admin/api/shop/item",
    "/admin/api/codes", "/admin/api/groups/feature"
  ]) {
    const res = await call(env, "tgbot_admin=999.9999999999.deadbeef", path, { any: 1 });
    assert.equal(res.status, 401, `${path} 不该放行伪造 cookie`);
  }
  db.close();
});

test("Web 后台：页面包含全部标签页，且内嵌脚本语法正确", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const cookie = await loginAs(env);

  const res = await call(env, cookie, "/admin");
  assert.equal(res.status, 200);
  const html = await res.text();

  for (const tab of ["overview", "users", "groups", "shop", "codes", "logs"]) {
    assert.ok(html.includes(`id="tab-${tab}"`), `页面缺少「${tab}」标签页`);
  }
  // 页面 JS 是拼在模板字符串里的，写坏了不会在构建期报错 —— 这里做一次语法体检
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script, "页面应内嵌一段脚本");
  assert.doesNotThrow(() => new vm.Script(script[1]), "内嵌脚本必须是合法 JS");
  db.close();
});
