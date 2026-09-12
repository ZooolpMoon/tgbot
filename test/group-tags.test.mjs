// ==========================================
// 🏷️ 商城 · 自定义群组标签
//
// 覆盖：标签文本校验、Schema 迁移与内置商品、购买即完成（不通知管理员）、
//       选群 → 填标签 → setChatMemberTag、权限不足/内容不合规的兜底、
//       放弃流程、「我的订单」重新进入、定时清理。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";

let apiCalls = [];
let chatMembers = {};
let chatTitles = {};
let tagCalls = [];
let tagResult = { ok: true };

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  const ok = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result })
  });
  const fail = (description, errorCode = 400) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: false, error_code: errorCode, description })
  });

  if (method === "getMe") return ok({ id: 42, username: "TestBot", is_bot: true });
  if (method === "getChatMember") {
    const member = chatMembers[`${body.chat_id}:${body.user_id}`];
    return member ? ok(member) : fail("Bad Request: participant not found");
  }
  if (method === "getChat") {
    const title = chatTitles[String(body.chat_id)];
    return title ? ok({ id: body.chat_id, title, type: "supergroup" }) : fail("Bad Request: chat not found");
  }
  if (method === "setChatMemberTag") {
    tagCalls.push({ chatId: String(body.chat_id), userId: String(body.user_id), tag: String(body.tag ?? "") });
    return tagResult.ok ? ok(true) : fail(tagResult.description || "Bad Request: not enough rights", tagResult.error_code || 400);
  }
  return ok({ message_id: 99 });
};

const resetCalls = () => { apiCalls = []; tagCalls = []; };
const callsOf = (method) => apiCalls.filter((c) => c.method === method);
const textsTo = (chatId) => apiCalls
  .filter((c) => String(c.body?.chat_id) === String(chatId) && c.body?.text)
  .map((c) => String(c.body.text));
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

const send = (env, ctx, text, userId = "1") => {
  const uctx = userUctx(userId);
  return handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", isGroupCtx: false, uctx,
    payload: { message: { text, entities: [] } }
  });
};

/** 造一个「群标签」商品 + 一个机器人待过的群，返回 itemId */
function seedTagItem(db, { price = 500 } = {}) {
  db.exec(`INSERT INTO shop_items (name, description, icon, price, stock, category, enabled, delivery)
           VALUES ('自定义群组标签', '给你的群成员标签加一个专属自称号。', '🏷️', ${price}, -1, 'virtual', 1, 'group_tag')`);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id)
           VALUES ('group:-100:user:1', 'user:1', '-100', 'supergroup', '1')`);
  chatTitles["-100"] = "测试群";
  // 机器人在群里是管理员，且有「管理标签」权限
  chatMembers["-100:42"] = {
    status: "administrator", can_restrict_members: true, can_manage_tags: true, user: { id: 42 }
  };
  return Number(db.get("SELECT id FROM shop_items WHERE delivery = 'group_tag'").id);
}

const { handleCallback } = await import("../src/handlers/callback.js");
const { handleMessage } = await import("../src/handlers/message.js");
const { validateTagText, applyMemberTag, getAppliedTag, listTagGroups } = await import("../src/services/group-tags.js");
const { cleanupStaleData } = await import("../src/services/daily.js");

// ==========================================
// 1. 标签文本校验
// ==========================================

test("validateTagText：长度、emoji、空值、清空符合 Telegram 限制", () => {
  assert.deepEqual(validateTagText("夜猫子"), { ok: true, tag: "夜猫子" });
  assert.deepEqual(validateTagText("  常驻  "), { ok: true, tag: "常驻" });
  // "-" = 清除标签（与其它引导流程的约定一致）
  assert.deepEqual(validateTagText("-"), { ok: true, tag: "" });

  assert.equal(validateTagText("").ok, false, "空标签应被拒绝");
  assert.equal(validateTagText("   ").ok, false);
  assert.equal(validateTagText("一二三四五六七八九十一二三四五六七").ok, false, "超过 16 字应被拒绝");
  assert.equal(validateTagText("一二三四五六七八九十一二三四五六").ok, true, "刚好 16 字可以");
  assert.equal(validateTagText("夜猫子🎉").ok, false, "emoji 应被拒绝");
  assert.equal(validateTagText("多行\n标签").ok, false, "换行应被拒绝");
});

// ==========================================
// 2. Schema 迁移与内置商品
// ==========================================

test("Schema 迁移：补上 shop_items.delivery 并内置「自定义群组标签」", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB({ withSchema: false });
  const { ensureSchema } = await import(`../src/core/db.js?fresh=${Date.now()}`);
  await ensureSchema({ DB: db });

  const cols = db.all("SELECT name FROM pragma_table_info('shop_items')").map((r) => r.name);
  assert.ok(cols.includes("delivery"), "应补上 delivery 字段");

  const item = db.get("SELECT * FROM shop_items WHERE delivery = 'group_tag'");
  assert.ok(item, "应内置群标签商品");
  assert.equal(item.name, "自定义群组标签");
  assert.equal(item.price, 500);
  assert.equal(Number(item.enabled), 1);
  assert.equal(Number(item.stock), -1, "不限库存");

  // 版本标记被清掉后迁移会再跑一遍：不能重复插一条
  db.exec("DELETE FROM scene_settings WHERE name = 'schema.version'");
  const { ensureSchema: ensureAgain } = await import(`../src/core/db.js?fresh=${Date.now() + 1}`);
  await ensureAgain({ DB: db });
  assert.equal(
    Number(db.get("SELECT COUNT(*) AS n FROM shop_items WHERE delivery = 'group_tag'").n), 1,
    "重复迁移不应灌回第二条"
  );
  db.close();
});

// ==========================================
// 3. 购买：无需发货、直接完成
// ==========================================

test("购买群标签商品：下单即完成、不通知管理员、直接进选群流程", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, `shop_buy_${itemId}`);

  const order = db.get("SELECT * FROM shop_orders ORDER BY id DESC LIMIT 1");
  assert.equal(order.status, "done", "自动发放的商品下单即完成");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 500, "应扣 500 积分");

  // 不该给管理员发「新订单」通知（管理员私聊是 999）
  assert.ok(
    !textsTo("999").some((t) => /新订单|待处理/.test(t)),
    "自动发放商品不该通知管理员发货"
  );

  // 会话进入「选群」步骤，并渲染出群按钮
  assert.equal(db.get("SELECT step FROM group_tag_sessions").step, "group");
  const picker = lastEdit();
  assert.ok(picker, "应渲染选群面板");
  assert.match(String(picker.text), /自定义群组标签/);
  assert.match(String(picker.text), /订单/);
  const buttons = picker.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes("shop_tag_grp_-100"), "应出现群按钮");
  assert.ok(buttons.includes("shop_tag_cancel"), "应有放弃按钮");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 4. 选群 → 填标签
// ==========================================

test("选群 → 发送标签：调用 setChatMemberTag 并记录，流程结束", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  resetCalls();
  await click(env, ctx, "shop_tag_grp_-100");

  assert.equal(db.get("SELECT step, target_chat FROM group_tag_sessions").step, "tag");
  assert.equal(db.get("SELECT target_chat FROM group_tag_sessions").target_chat, "-100");
  const prompt = lastEdit();
  assert.match(String(prompt.text), /测试群/);
  assert.match(String(prompt.text), /当前标签/);

  resetCalls();
  await send(env, ctx, "夜猫子");

  assert.deepEqual(tagCalls, [{ chatId: "-100", userId: "1", tag: "夜猫子" }]);
  assert.equal(
    db.get("SELECT tag FROM user_group_tags WHERE chat_id = '-100' AND user_id = '1'").tag,
    "夜猫子"
  );
  assert.equal(db.count("group_tag_sessions"), 0, "设置完成后会话要清掉");
  const log = db.get("SELECT action, note FROM shop_order_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.action, "tag_set");
  assert.match(String(log.note), /-100:夜猫子/);
  assert.ok(textsTo("1").some((t) => t.includes("标签已设置")), "应回复成功卡片");
  assert.ok(
    !textsTo("999").some((t) => t.includes("标签")),
    "用户自助设置不该打扰管理员"
  );
  await Promise.all(ctx.pending);
  db.close();
});

test("标签不合规：不调接口、保留会话、提示重发", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  await click(env, ctx, "shop_tag_grp_-100");
  resetCalls();

  await send(env, ctx, "夜猫子🎉");
  assert.equal(tagCalls.length, 0, "emoji 不该发请求");
  assert.equal(db.count("group_tag_sessions"), 1, "会话要保留，让用户重发");
  assert.ok(textsTo("1").some((t) => t.includes("emoji")));

  await send(env, ctx, "一二三四五六七八九十一二三四五六七");
  assert.equal(tagCalls.length, 0);
  assert.ok(textsTo("1").some((t) => t.includes("16")));
  await Promise.all(ctx.pending);
  db.close();
});

test("机器人没有「管理标签」权限：说清楚原因，不扣结果", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  // 机器人只是普通成员
  chatMembers["-100:42"] = { status: "member", user: { id: 42 } };
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  resetCalls();
  await click(env, ctx, "shop_tag_grp_-100");

  assert.equal(db.get("SELECT step FROM group_tag_sessions").step, "group", "应停留在选群步骤");
  const picker = lastEdit();
  assert.match(String(picker.text), /管理标签/, "要提示缺哪项权限");
  assert.equal(tagCalls.length, 0);
  await Promise.all(ctx.pending);
  db.close();
});

test("Telegram 拒绝时（例如自己不在群里）给出可操作提示并保留会话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  await click(env, ctx, "shop_tag_grp_-100");
  resetCalls();
  tagResult = { ok: false, description: "Bad Request: participant not found" };

  await send(env, ctx, "夜猫子");
  assert.equal(tagCalls.length, 1, "应当尝试过设置");
  assert.ok(textsTo("1").some((t) => t.includes("你不在这个群里")));
  assert.equal(db.count("group_tag_sessions"), 1, "失败时保留会话让用户重试");
  assert.equal(db.count("user_group_tags"), 0, "失败不该记录标签");
  tagResult = { ok: true };
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 5. 放弃与重新进入
// ==========================================

test("放弃设置：清掉会话但订单仍有效", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  resetCalls();
  await click(env, ctx, "shop_tag_cancel");

  assert.equal(db.count("group_tag_sessions"), 0, "放弃后不该残留会话");
  assert.ok(textsTo("1").some((t) => t.includes("已放弃设置")));
  assert.equal(db.get("SELECT status FROM shop_orders ORDER BY id DESC LIMIT 1").status, "done", "订单仍然有效");
  await Promise.all(ctx.pending);
  db.close();
});

test("我的订单：未设置标签的订单给出重新进入的入口", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  const orderId = Number(db.get("SELECT id FROM shop_orders ORDER BY id DESC LIMIT 1").id);
  // 模拟会话过期
  db.exec("DELETE FROM group_tag_sessions");

  resetCalls();
  await click(env, ctx, "shop_orders_1");
  const view = lastEdit();
  const buttons = view.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes(`shop_tag_order_${orderId}`), "应能重新进入设置");

  resetCalls();
  await click(env, ctx, `shop_tag_order_${orderId}`);
  assert.equal(db.get("SELECT step FROM group_tag_sessions").step, "group", "重新进入应回到选群");

  // 设好标签之后就不该再显示入口
  await click(env, ctx, "shop_tag_grp_-100");
  await send(env, ctx, "夜猫子");
  resetCalls();
  await click(env, ctx, "shop_orders_1");
  const after = lastEdit().reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(!after.includes(`shop_tag_order_${orderId}`), "设置完成后不再提示");
  await Promise.all(ctx.pending);
  db.close();
});

test("选群步骤里发文字：提示点按钮，不会漏成 AI 对话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 1000);
  const itemId = seedTagItem(db);
  const env = makeEnv(db);
  const ctx = makeCtx();

  await click(env, ctx, `shop_buy_${itemId}`);
  resetCalls();
  await send(env, ctx, "我要设置");
  assert.ok(textsTo("1").some((t) => t.includes("群组按钮")));
  assert.equal(callsOf("sendChatAction").length, 0, "不该走 AI 对话");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 6. 清理与工具函数
// ==========================================

test("定时清理：过期一天的群标签会话会被删掉", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  db.exec(`INSERT INTO group_tag_sessions (chat_id, user_id, order_id, item_id, step, updated_at)
           VALUES ('1', '1', 1, 1, 'tag', datetime('now', '-2 days'))`);
  db.exec(`INSERT INTO group_tag_sessions (chat_id, user_id, order_id, item_id, step)
           VALUES ('2', '2', 2, 1, 'tag')`);

  const cleanup = await cleanupStaleData({ DB: db });
  assert.equal(cleanup.tagSessions, 1, "只清过期的那条");
  assert.equal(db.count("group_tag_sessions"), 1);
  db.close();
});

test("listTagGroups：只列机器人待过的群，买家所在的群排前面", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  db.exec(`
    INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id)
      VALUES ('group:-200:user:9', 'user:9', '-200', 'supergroup', '9');
    INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id)
      VALUES ('group:-100:user:1', 'user:1', '-100', 'supergroup', '1');
    INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id)
      VALUES ('private:1', 'user:1', '1', 'private', '1');
  `);
  const groups = await listTagGroups({ DB: db }, "1");
  assert.deepEqual(groups.map((g) => g.chatId), ["-100", "-200"], "自己所在的群排前面，私聊不算群");
  db.close();
});

test("applyMemberTag：Telegram 报错时返回可读原因，成功时落库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  tagResult = { ok: false, description: "Bad Request: not enough rights to set the tag" };
  const bad = await applyMemberTag({ env, token: "T", chatId: "-100", userId: "1", tag: "夜猫子" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /管理标签/);
  assert.equal(db.count("user_group_tags"), 0);

  tagResult = { ok: true };
  const good = await applyMemberTag({ env, token: "T", chatId: "-100", userId: "1", tag: "夜猫子", orderId: 7 });
  assert.equal(good.ok, true);
  const row = await getAppliedTag(env, "-100", "1");
  assert.equal(row.tag, "夜猫子");
  assert.equal(Number(row.order_id), 7);

  // 再设一次是覆盖（同一个群同一个用户只有一条）
  await applyMemberTag({ env, token: "T", chatId: "-100", userId: "1", tag: "常驻", orderId: 8 });
  assert.equal(db.count("user_group_tags"), 1);
  assert.equal((await getAppliedTag(env, "-100", "1")).tag, "常驻");
  db.close();
});
