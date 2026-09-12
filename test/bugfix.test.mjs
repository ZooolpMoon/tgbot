// ==========================================
// 🐛 缺陷回归测试
//
// 覆盖这一轮排查修掉的问题：
//   1. 每日任务引导在群里走不通（输入被丢弃）
//   2. 编辑任务后详情卡片用 null message_id 刷新，Telegram 直接报错
//   3. 管理员可以封禁自己（用户管理面板）
//   4. 引导会话互相抢消息（残留会话吞掉输入）
//   5. 任务名称 / 处置公告里的用户可控文本未转义
//   6. 负数额度可能变成「凭空加分」
//   7. 删除场景没有二次确认
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";

let apiCalls = [];
let messageId = 0;
let chatMembers = {};
/** 设为 true 时，下一次「带按钮的 sendMessage」会被 Telegram 拒绝（模拟 400/429） */
let failKeyboardOnce = false;
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
  if (method === "sendMessage") {
    if (failKeyboardOnce && body.reply_markup) {
      failKeyboardOnce = false;
      return fail("Bad Request: not enough rights to send text messages to the chat");
    }
    return ok({ message_id: ++messageId });
  }
  return ok(true);
};

/** 记录 editMessageText 的 message_id，方便断言「没有传 null」 */
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

const say = (env, ctx, uctx, text, isGroupCtx = false, mention = false) => handleMessage({
  env, ctx, token: "T", myId: "999", uctx, isGroupCtx,
  payload: {
    message: {
      text: mention ? `@TestBot ${text}` : text,
      entities: mention ? [{ type: "mention", offset: 0, length: 9 }] : []
    }
  }
});

// ==========================================
// 1. 每日任务引导：群里也要能新增
// ==========================================

test("每日任务：在群里走完引导也能新增任务", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, groupUctx, "admin_task_add", "supergroup");
  await click(env, ctx, groupUctx, "admin_task_pick_chat", "supergroup");
  // 群里不 @ 机器人也应该被引导流程消费
  await say(env, ctx, groupUctx, "群里的新任务", true);
  await say(env, ctx, groupUctx, "发一句话就行", true);
  await say(env, ctx, groupUctx, "7", true);

  const row = db.get("SELECT * FROM daily_task_defs ORDER BY id DESC LIMIT 1");
  assert.ok(row, "群里应能创建任务");
  assert.equal(row.label, "群里的新任务");
  assert.equal(row.hint, "发一句话就行");
  assert.equal(row.points, 7);
  assert.equal(db.count("task_edit_sessions"), 0, "完成后应清掉引导会话");
  await Promise.all(ctx.pending);
  db.close();
});

test("每日任务：群里 @机器人 发内容不会被当成 AI 对话（引导优先）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, groupUctx, "admin_task_add", "supergroup");
  await click(env, ctx, groupUctx, "admin_task_pick_game", "supergroup");
  resetCalls();
  await say(env, ctx, groupUctx, "带 @ 的任务名", true, true);

  const session = db.get("SELECT step, draft FROM task_edit_sessions WHERE chat_id = '-100'");
  assert.equal(session.step, "add:hint", "应继续任务引导");
  assert.match(String(session.draft), /带 @ 的任务名/);
  assert.ok(!textsOf("sendMessage").some((t) => t === "ok"), "不应走 AI 回复");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 2. 编辑任务后要能刷新详情卡片
// ==========================================

test("每日任务：改完字段后刷新详情卡片（不能拿 null 当 message_id）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  db.exec(`INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
           VALUES ('chat', '旧名称', '旧提示', 3, 1, 1)`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const taskId = db.get("SELECT id FROM daily_task_defs LIMIT 1").id;
  await click(env, ctx, privateUctx, `admin_task_f_${taskId}_label`);
  await say(env, ctx, privateUctx, "新名称");

  assert.equal(db.get("SELECT label FROM daily_task_defs WHERE id = ?", taskId).label, "新名称");
  for (const call of apiCalls) {
    if (call.method === "editMessageText") {
      assert.notEqual(call.body.message_id, null, "editMessageText 不能用 null message_id");
    }
  }
  assert.ok(textsOf("sendMessage").some((t) => t.includes("任务 #")), "应重新发一张详情卡片");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 3. 管理员不能被封禁
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

  // 回复机器人管理员的消息再下指令（用户 ID 短号不会走「直接写数字 ID」分支）
  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: groupUctx, isGroupCtx: true,
    payload: {
      message: {
        text: "/ban 发广告",
        reply_to_message: { from: { id: 999, first_name: "管理员" } }
      }
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
// 4. 引导会话互斥
// ==========================================

test("引导会话互斥：开新流程会清掉其它残留会话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { setSession } = { setSession: null };

  // 假装之前点了「添加知识库文档」并填了一半
  db.exec(`INSERT INTO kb_sessions (chat_id, step, draft) VALUES ('999', 'add:content', '{"title":"半截文档"}')`);

  await click(env, ctx, privateUctx, "admin_task_add");

  assert.equal(db.count("kb_sessions"), 0, "知识库会话应被清掉，避免抢走输入");
  assert.equal(db.get("SELECT step FROM task_edit_sessions WHERE chat_id = '999'").step, "add:trigger");
  await Promise.all(ctx.pending);
  db.close();
});

test("引导会话互斥：填写下单备注时会清掉其它引导会话", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const { seedItem } = await import("../test-helpers/d1.mjs");
  const itemId = seedItem(db, { name: "测试商品", price: 10 });
  const env = makeEnv(db);
  db.exec(`INSERT INTO task_edit_sessions (chat_id, step, draft) VALUES ('999', 'add:points', '{}')`);

  const { beginOrderNote } = await import("../src/shop/notes.js");
  await beginOrderNote(env, "999", itemId);

  assert.equal(db.count("task_edit_sessions"), 0);
  assert.equal(db.get("SELECT pending FROM shop_order_drafts WHERE chat_id = '999'").pending, 1);
  db.close();
});

// ==========================================
// 5. HTML 转义
// ==========================================

test("任务名称 / 提示里的尖括号不会打破 /tasks 消息", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  db.exec(`INSERT INTO daily_task_defs (trigger, label, hint, points, enabled, sort_order)
           VALUES ('chat', '发 <3 句话', '用 <b> 标签试试', 1, 1, 1)`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await say(env, ctx, privateUctx, "/tasks");
  const text = textsOf("sendMessage").at(-1) || "";
  assert.ok(text.includes("&lt;3"), "标签应被转义： " + text.slice(0, 80));
  assert.ok(text.includes("&lt;b&gt;"), "提示里的标签也应被转义");
  await Promise.all(ctx.pending);
  db.close();
});

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
// 6. 扣分不接受负数
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
// 7. 删除场景要二次确认
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
// 8. 任务详情兜底分支不再吞掉其它 admin_task_* 回调
// ==========================================

test("未知的 admin_task_* 回调不会被当成任务详情", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, privateUctx, "admin_task_nonsense");
  assert.ok(
    apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("未知操作")),
    "应走未知操作兜底"
  );
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 9. 添加任务：按钮点不了 / 发不出去时也要能继续
// ==========================================

test("添加任务：在「选触发条件」那步直接打字也能继续（回复编号）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { TASK_TRIGGERS } = await import("../src/config/tasks.js");
  resetCalls();

  await click(env, ctx, groupUctx, "admin_task_add", "supergroup");
  assert.equal(db.get("SELECT step FROM task_edit_sessions WHERE chat_id = '-100'").step, "add:trigger");

  // 乱写：应重新提示并保留会话（以前会被当成未知步骤清掉，然后掉进 AI 对话）
  await say(env, ctx, groupUctx, "我先随便说点什么", true);
  assert.equal(db.get("SELECT step FROM task_edit_sessions WHERE chat_id = '-100'").step, "add:trigger", "会话不该被清掉");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("没认出这个触发条件")));

  // 回复编号：等价于点了第 2 个触发条件
  await say(env, ctx, groupUctx, "2", true);
  const session = db.get("SELECT step, draft FROM task_edit_sessions WHERE chat_id = '-100'");
  assert.equal(session.step, "add:label");
  assert.equal(JSON.parse(session.draft).trigger, TASK_TRIGGERS[1].key);

  // 继续走完
  await say(env, ctx, groupUctx, "文字建的任务", true);
  await say(env, ctx, groupUctx, "随便发句话", true);
  await say(env, ctx, groupUctx, "9", true);
  const created = db.get("SELECT * FROM daily_task_defs ORDER BY id DESC LIMIT 1");
  assert.equal(created.label, "文字建的任务");
  assert.equal(created.points, 9);
  assert.equal(db.count("task_edit_sessions"), 0);
  await Promise.all(ctx.pending);
  db.close();
});

test("添加任务：带按钮的消息发不出去时，写审计日志并退化成纯文本", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  failKeyboardOnce = true;
  await click(env, ctx, groupUctx, "admin_task_add", "supergroup");

  const failLog = db.get("SELECT action, detail FROM admin_logs ORDER BY id DESC LIMIT 1");
  assert.equal(failLog.action, "task_step_send_failed", "应把发送失败写进审计日志");
  assert.match(String(failLog.detail), /add:trigger/);
  assert.match(String(failLog.detail), /not enough rights/);
  assert.ok(
    textsOf("sendMessage").some((t) => t.includes("按钮没有发送成功")),
    "应退化成不带按钮的纯文本提示"
  );
  assert.equal(db.get("SELECT step FROM task_edit_sessions WHERE chat_id = '-100'").step, "add:trigger");
  await Promise.all(ctx.pending);
  db.close();
});

test("resolveTriggerInput：编号 / key / 名称都能解析", async () => {
  const { resolveTriggerInput } = await import("../src/admin/tasks.js");
  const { TASK_TRIGGERS } = await import("../src/config/tasks.js");

  assert.equal(resolveTriggerInput("1").key, TASK_TRIGGERS[0].key);
  assert.equal(resolveTriggerInput("5").key, TASK_TRIGGERS[4].key);
  assert.equal(resolveTriggerInput("checkin").key, "checkin");
  assert.equal(resolveTriggerInput(TASK_TRIGGERS[2].label).key, TASK_TRIGGERS[2].key);
  assert.equal(resolveTriggerInput("99"), null);
  assert.equal(resolveTriggerInput("随便写"), null);
});

test("添加任务第 1 步：触发条件里的 <占位符> 必须转义（否则 Telegram 直接拒收）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await click(env, ctx, groupUctx, "admin_task_add", "supergroup");

  const picker = apiCalls.find((c) => c.method === "sendMessage" && c.body.reply_markup);
  assert.ok(picker, "应发出触发条件选择消息");
  assert.match(String(picker.body.text), /&lt;兑换码&gt;/, "占位符应转义成实体");
  assert.ok(!/<兑换码>/.test(String(picker.body.text)), "不能残留会被当成标签的原文");
  await Promise.all(ctx.pending);
  db.close();
});

test("本轮所有出站 HTML 消息都能被 Telegram 解析（无未转义尖括号）", () => {
  assert.deepEqual(htmlErrors, [], `发现会被 Telegram 当成标签的片段：${JSON.stringify(htmlErrors.slice(0, 5))}`);
});
