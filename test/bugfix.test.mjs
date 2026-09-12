// ==========================================
// 🐛 缺陷回归测试
//
// 覆盖历次排查修掉的问题：
//   1. 管理员可以封禁自己（面板 + 服务层 + 处置执行三层拦截）
//   2. 引导会话互相抢消息（残留会话吞掉输入）
//   3. HTML 转义补漏（处置公告里的用户可控文本）
//   4. 负数额度会「凭空加分」
//   5. 删除场景没有二次确认
//   6. 出站 HTML 体检：所有发给用户的消息都必须能被 Telegram 解析
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";

let apiCalls = [];
let messageId = 0;
let chatMembers = {};
/** 所有出站 HTML 消息里「Telegram 会当成标签」的片段（应为空） */
const htmlErrors = [];

/** Telegram 允许的 HTML 标签 */
const ALLOWED_HTML = /<\/?(b|strong|i|em|u|ins|s|strike|del|code|pre|a)(\s+[^<>]*)?>/g;

/** 模拟 Telegram 的实体解析：去掉合法标签后不该再剩下尖括号 */
function checkHtmlText(text) {
  const rest = String(text || "").replace(ALLOWED_HTML, "");
  const bad = /<[^>]*>/.exec(rest);
  if (bad) htmlErrors.push(bad[0]);
}

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  if (body.parse_mode === "HTML") checkHtmlText(body.text);

  const ok = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result })
  });
  const fail = (description) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: false, error_code: 400, description })
  });

  if (method === "getMe") return ok({ id: 42, username: "TestBot", is_bot: true });
  if (method === "getChatMember") {
    const member = chatMembers[`${body.chat_id}:${body.user_id}`];
    return member ? ok(member) : fail("not found");
  }
  if (method === "sendMessage") return ok({ message_id: ++messageId });
  return ok(true);
};

const textsOf = (method) => apiCalls.filter((c) => c.method === method).map((c) => String(c.body.text || ""));
const resetCalls = () => { apiCalls.length = 0; };

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: { run: async () => ({ response: "ok" }) },
  BOT_TOKEN: "T", BOT_USERNAME: "TestBot", MY_TELEGRAM_ID: "999",
  APP_TIMEZONE: "Asia/Shanghai",
  ...extra
});

const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

const privateUctx = {
  chatId: "999", userId: "999", chatType: "private",
  userKey: "user:999", sceneKey: "private:999", username: "admin", firstName: "管理员"
};
const groupUctx = {
  chatId: "-100", userId: "999", chatType: "supergroup",
  userKey: "user:999", sceneKey: "group:-100:user:999", username: "admin", firstName: "管理员"
};

const { handleMessage } = await import("../src/handlers/message.js");
const { handleCallback } = await import("../src/handlers/callback.js");

const click = (env, ctx, uctx, data, chatType = "private") => handleCallback({
  env, ctx, token: "T", myId: "999", uctx,
  payload: {
    callback_query: {
      id: `cb_${data}`, from: { id: 999 }, data,
      message: { message_id: 10, chat: { id: uctx.chatId, type: chatType } }
    }
  }
});

const say = (env, ctx, uctx, text, isGroupCtx = false) => handleMessage({
  env, ctx, token: "T", myId: "999", uctx, isGroupCtx,
  payload: { message: { text, entities: [] } }
});

// ==========================================
// 1. 管理员不能被封禁
// ==========================================

test("用户管理：不能封禁机器人管理员自己", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 50);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name)
           VALUES ('private:999', 'user:999', '999', 'private', '999', 'admin', '管理员')`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const rowId = db.get("SELECT id FROM user_scenes WHERE user_key = 'user:999'").id;
  await click(env, ctx, privateUctx, `admin_block_${rowId}`);

  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:999'").blocked, 0, "不该被写进封禁名单");
  assert.ok(
    apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("不能封禁")),
    "应提示不能封禁管理员"
  );
  await Promise.all(ctx.pending);
  db.close();
});

test("服务层：setUserBlocked / banUserById 都拦得住机器人管理员", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 50);
  const env = makeEnv(db);
  const { setUserBlocked, banUserById } = await import("../src/services/users.js");

  await setUserBlocked(env, "user:999", true);
  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:999'").blocked, 0);

  const res = await banUserById(env, "999");
  assert.equal(res.ok, false);
  db.close();
});

test("群规执法：处置指令与执行环节都拒绝机器人管理员", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('-100', ${Math.floor(Date.now() / 1000) + 600})`);
  // 把「执法回执」设成不删除，测试就不用等 5 秒的自动删除任务
  db.exec(`INSERT INTO scene_settings (scene_key, name, value) VALUES ('group:-100', 'autodelete.guard', '0')`);

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: groupUctx, isGroupCtx: true,
    payload: {
      message: { text: "/ban 发广告", reply_to_message: { from: { id: 999, first_name: "管理员" } } }
    }
  });
  assert.equal(db.count("group_punishments"), 0, "不该生成处置记录");
  assert.ok(
    textsOf("sendMessage").some((t) => t.includes("不能处置")),
    "应提示不能处置机器人管理员：" + textsOf("sendMessage").join(" | ").slice(0, 120)
  );

  // 底层兜底：即使有人翻出旧记录执行，也必须失败
  const { executePunishment } = await import("../src/services/guard.js");
  const result = await executePunishment({
    env, token: "T", record: { chat_id: "-100", user_id: "999", action: "bot_ban" }, action: "bot_ban"
  });
  assert.equal(result.ok, false);
  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:999'").blocked, 0);
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 2. 引导会话互斥
// ==========================================

test("引导会话互斥：开新流程会清掉其它残留会话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();

  // 假装之前点了「添加知识库文档」并填了一半
  db.exec(`INSERT INTO kb_sessions (chat_id, step, draft) VALUES ('999', 'add:content', '{"title":"半截文档"}')`);
  // 再假装有个「编辑商品」的会话
  db.exec(`INSERT INTO shop_edit_sessions (chat_id, item_id, field) VALUES ('999', 1, 'name')`);

  await click(env, ctx, privateUctx, "shop_admin_add");

  assert.equal(db.count("kb_sessions"), 0, "知识库会话应被清掉，避免抢走输入");
  assert.equal(db.count("shop_edit_sessions"), 0, "商品编辑会话也应被清掉");
  assert.equal(db.get("SELECT step FROM shop_add_sessions WHERE chat_id = '999'").step, 1);
  await Promise.all(ctx.pending);
  db.close();
});

test("引导会话互斥：填写下单备注时会清掉其它引导会话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const itemId = seedItem(db, { name: "测试商品", price: 10 });
  const env = makeEnv(db);
  db.exec(`INSERT INTO kb_sessions (chat_id, step, draft) VALUES ('999', 'add:title', '{}')`);

  const { beginOrderNote } = await import("../src/shop/notes.js");
  await beginOrderNote(env, "999", itemId);

  assert.equal(db.count("kb_sessions"), 0);
  assert.equal(db.get("SELECT pending FROM shop_order_drafts WHERE chat_id = '999'").pending, 1);
  db.close();
});

// ==========================================
// 3. HTML 转义
// ==========================================

test("处置公告里的对象名 / 理由 / 依据都会转义", async () => {
  const { buildPunishmentNotice } = await import("../src/services/guard.js");
  const text = buildPunishmentNotice({
    record: {
      user_id: "555",
      user_label: "<b>坏孩子</b>",
      reason: "发了 <script> 广告",
      matched_rule: "群规 <第 1 条>"
    },
    action: "mute", durationMin: 30, untilAt: 0, byWhom: "管理员"
  });
  assert.ok(!text.includes("<b>坏孩子</b>"), "对象名应转义");
  assert.ok(text.includes("&lt;b&gt;坏孩子&lt;/b&gt;"));
  assert.ok(!text.includes("<script>"));
  assert.ok(text.includes("&lt;第 1 条&gt;"));
});

// ==========================================
// 4. 扣分不接受负数
// ==========================================

test("tryDeductPoints：负数会被拒绝（避免凭空加分）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const env = { DB: db };
  const { tryDeductPoints } = await import("../src/services/points.js");

  assert.equal(await tryDeductPoints(env, "user:1", -50), null);
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 100);

  // 0 表示免费商品，仍然允许
  assert.equal(await tryDeductPoints(env, "user:1", 0), 100);
  db.close();
});

// ==========================================
// 5. 删除场景要二次确认
// ==========================================

test("删除场景：先确认再删除", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name)
           VALUES ('private:555', 'user:555', '555', 'private', '555', 'u', '小五')`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const rowId = db.get("SELECT id FROM user_scenes WHERE user_key = 'user:555'").id;

  // 第一次点击只弹确认
  await click(env, ctx, privateUctx, `admin_deluser_confirm_${rowId}`);
  assert.equal(db.count("user_scenes", `id = ${rowId}`), 1, "第一次点击不应删除");
  assert.ok(textsOf("editMessageText").some((t) => t.includes("确认删除这个场景")));

  // 确认后才真的删除
  resetCalls();
  await click(env, ctx, privateUctx, `admin_deluser_do_${rowId}`);
  assert.equal(db.count("user_scenes", `id = ${rowId}`), 0, "确认后应删除");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 6. 出站 HTML 体检（放在最后，覆盖本文件跑过的所有流程）
// ==========================================

test("所有出站 HTML 消息都能被 Telegram 解析（无未转义尖括号）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 500);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  // 跑几条最常见的用户指令，让它们的文案都过一遍解析体检
  for (const cmd of ["/help", "/start", "/profile", "/points", "/rank", "/checkin"]) {
    await say(env, ctx, privateUctx, cmd);
  }
  // 商城列表（含商品名/说明）
  seedItem(db, { name: "带 <尖括号> 的商品", price: 10 });
  await say(env, ctx, privateUctx, "/shop");

  assert.deepEqual(
    htmlErrors, [],
    `发现会被 Telegram 当成标签的片段：${JSON.stringify(htmlErrors.slice(0, 5))}`
  );
  await Promise.all(ctx.pending);
  db.close();
});
