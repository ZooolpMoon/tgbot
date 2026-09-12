// ==========================================
// 🛡️ 群规执法增强测试
//
// 覆盖：处置到期通知、申诉（批准 / 驳回 / 重复）、主动预警（静默提醒）、
//       撤销处置、群规版本历史与回滚。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";

let apiCalls = [];
let chatMembers = {};

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
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
  if (["banChatMember", "unbanChatMember", "restrictChatMember"].includes(method)) return ok(true);
  return ok({ message_id: 99 });
};

const resetCalls = () => { apiCalls.length = 0; };
const sentTexts = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
const callsOf = (method) => apiCalls.filter((c) => c.method === method);
const sentTo = (chatId) => apiCalls.filter((c) => String(c.body?.chat_id) === String(chatId) && c.body?.text);

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: { run: async (_m, o = {}) => (Array.isArray(o.text) ? { data: o.text.map(() => [1, 0, 0]) } : { response: "ok" }) },
  BOT_TOKEN: "TEST_TOKEN",
  BOT_USERNAME: "TestBot",
  MY_TELEGRAM_ID: "999",
  APP_TIMEZONE: "Asia/Shanghai",
  ...extra
});

const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

const adminUctx = {
  chatId: "-100", userId: "999", chatType: "supergroup",
  userKey: "user:999", sceneKey: "group:-100:user:999",
  username: "admin", firstName: "管理员"
};

const { handleMessage } = await import("../src/handlers/message.js");
const { handleCallback } = await import("../src/handlers/callback.js");
const { cleanupStaleData } = await import("../src/services/daily.js");
const { getGroupGuard, setGroupGuard, listRuleVersions } = await import("../src/services/guard.js");

// ==========================================
// 1. 处置到期通知
// ==========================================

test("临时处置到期：标记 expired 并通知群与当事人", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  // 一条 1 分钟前就该到期的禁言
  db.exec(`INSERT INTO group_punishments
    (chat_id, user_id, user_label, action, reason, duration_min, until_at, status, operator_id)
    VALUES ('-100', '555', '坏孩子', 'mute', '刷屏', 30, ${Math.floor(Date.now() / 1000) - 60}, 'done', '999')`);

  const env = makeEnv(db);
  resetCalls();
  const cleanup = await cleanupStaleData(env);

  assert.equal(cleanup.expiredPunishments, 1);
  assert.equal(cleanup.expiredList.length, 1);
  assert.equal(db.get("SELECT status FROM group_punishments ORDER BY id DESC LIMIT 1").status, "expired");
  db.close();
});

test("定时任务会给到期处置发通知（群公告 + 私聊当事人）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  db.exec(`INSERT INTO group_punishments
    (chat_id, user_id, user_label, action, reason, duration_min, until_at, status, operator_id)
    VALUES ('-100', '555', '坏孩子', 'mute', '刷屏', 30, ${Math.floor(Date.now() / 1000) - 60}, 'done', '999')`);

  const env = makeEnv(db);
  resetCalls();
  const { runScheduledTasks } = await import("../src/services/daily.js");
  await runScheduledTasks(env, "TEST_TOKEN");

  assert.ok(sentTo("-100").some((c) => String(c.body.text).includes("处置已到期")), "群里应公告到期");
  assert.ok(sentTo("555").some((c) => String(c.body.text).includes("限制已解除")), "当事人应收到私聊");
  db.close();
});

// ==========================================
// 2. 申诉
// ==========================================

/** 造一条已执行的禁言记录，返回 id */
function seedPunishment(db, over = {}) {
  const values = {
    chatId: "-100", userId: "555", label: "坏孩子", action: "mute",
    reason: "刷屏", duration: 30, status: "done", operator: "999", ...over
  };
  db.exec(`INSERT INTO group_punishments
    (chat_id, user_id, user_label, action, reason, duration_min, status, operator_id)
    VALUES ('${values.chatId}', '${values.userId}', '${values.label}', '${values.action}', '${values.reason}', ${values.duration}, '${values.status}', '${values.operator}')`);
  return Number(db.get("SELECT id FROM group_punishments ORDER BY id DESC LIMIT 1").id);
}

test("申诉：被处置人私聊申诉 → 卡片发到管理员，批准后撤销处置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  const punishmentId = seedPunishment(db);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "administrator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const userUctx = {
    chatId: "555", userId: "555", chatType: "private",
    userKey: "user:555", sceneKey: "private:555"
  };

  // 私聊里用 /appeal 申诉（自然语言入口已移除）
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: userUctx, isGroupCtx: false,
    payload: { message: { text: "/appeal 我那是正常讨论，不是刷屏", entities: [] } }
  });

  const appeal = db.get("SELECT * FROM punishment_appeals ORDER BY id DESC LIMIT 1");
  assert.ok(appeal, "应生成申诉记录");
  assert.equal(appeal.punishment_id, punishmentId);
  assert.equal(appeal.status, "pending");

  const card = apiCalls.filter((c) => c.body?.reply_markup).at(-1);
  assert.equal(String(card.body.chat_id), "999", "卡片应发到管理员私聊");
  assert.ok(String(card.body.text).includes("收到一条申诉"));
  assert.ok(sentTo("555").some((c) => String(c.body.text).includes("已提交给管理员")));

  // 管理员批准 → 撤销处置
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data: `appeal_ok_${appeal.id}`,
        message: { message_id: 40, chat: { id: 999, type: "private" } }
      }
    }
  });

  assert.equal(db.get("SELECT status FROM punishment_appeals WHERE id = ?", appeal.id).status, "approved");
  assert.equal(db.get("SELECT status FROM group_punishments WHERE id = ?", punishmentId).status, "revoked");
  assert.ok(callsOf("restrictChatMember").length >= 1, "应解除群内禁言");
  assert.ok(sentTo("555").some((c) => String(c.body.text).includes("申诉已通过")));
  assert.ok(sentTo("-100").some((c) => String(c.body.text).includes("申诉通过")));
  await Promise.all(ctx.pending);
  db.close();
});

test("申诉：驳回会通知当事人且不改动处置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  const punishmentId = seedPunishment(db);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const userUctx = { chatId: "555", userId: "555", chatType: "private", userKey: "user:555", sceneKey: "private:555" };
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: userUctx, isGroupCtx: false,
    payload: { message: { text: "/appeal 我觉得不合理", entities: [] } }
  });
  const appeal = db.get("SELECT * FROM punishment_appeals ORDER BY id DESC LIMIT 1");

  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data: `appeal_no_${appeal.id}`,
        message: { message_id: 41, chat: { id: 999, type: "private" } }
      }
    }
  });

  assert.equal(db.get("SELECT status FROM punishment_appeals WHERE id = ?", appeal.id).status, "rejected");
  assert.equal(db.get("SELECT status FROM group_punishments WHERE id = ?", punishmentId).status, "done", "驳回不应改动原处置");
  assert.equal(callsOf("restrictChatMember").length, 0);
  assert.ok(sentTo("555").some((c) => String(c.body.text).includes("未通过")));
  await Promise.all(ctx.pending);
  db.close();
});

test("申诉：同一处置重复申诉会被拒绝，没有可申诉记录时给出提示", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  seedPunishment(db);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  const userUctx = { chatId: "555", userId: "555", chatType: "private", userKey: "user:555", sceneKey: "private:555" };
  const appeal = (text) => handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: userUctx, isGroupCtx: false,
    payload: { message: { text, entities: [] } }
  });

  await appeal("/appeal 第一次申诉");
  resetCalls();
  await appeal("/appeal 再来一次");
  assert.ok(sentTexts().some((t) => t.includes("已经申诉过了")));

  // 换个没有处置记录的用户
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", isGroupCtx: false,
    uctx: { chatId: "777", userId: "777", chatType: "private", userKey: "user:777", sceneKey: "private:777" },
    payload: { message: { text: "/appeal 我没被处置过", entities: [] } }
  });
  assert.ok(sentTexts().some((t) => t.includes("没有找到可以申诉的处置记录")));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 3. 主动预警
// ==========================================

test("主动预警：命中关键词只私聊提醒管理员，不在群里发声", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:111", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:111"] = { status: "member", user: { id: 111 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const memberUctx = { chatId: "-100", userId: "111", chatType: "supergroup", userKey: "user:111", sceneKey: "group:-100:user:111" };
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: memberUctx, isGroupCtx: true,
    payload: { message: { text: "这个兼职日赚500，加微信了解", entities: [] } }
  });

  const alert = db.get("SELECT * FROM group_punishments ORDER BY id DESC LIMIT 1");
  assert.ok(alert, "应生成预警记录");
  assert.equal(alert.status, "pending");
  assert.equal(alert.chat_id, "-100", "记录要归属到群");
  assert.match(alert.reason, /预警关键词/);

  const card = apiCalls.filter((c) => c.body?.reply_markup).at(-1);
  assert.equal(String(card.body.chat_id), "999", "预警卡片发到管理员私聊");
  // 群里不应出现「预警」相关公告（只有 AI 回复）
  const groupTexts = sentTo("-100").map((c) => String(c.body.text));
  assert.ok(!groupTexts.some((t) => t.includes("预警")), "群里不应公开预警");

  // 同一用户 10 分钟内不重复提醒
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: memberUctx, isGroupCtx: true,
    payload: { message: { text: "继续发广告 加微信", entities: [] } }
  });
  assert.equal(db.count("group_punishments", "status = 'pending'"), 1, "不应重复生成预警");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 4. 撤销处置
// ==========================================

test("群规对所有人一视同仁：owner 与本群管理员发言同样触发预警", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:42", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  // 42 是本群管理员，999 是机器人 owner —— 以前这两种身份会被直接跳过
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };

  // owner 在群里发一句带关键词的普通消息（没 @机器人）
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx, isGroupCtx: true,
    payload: { message: { text: "免费领取 加微信 兼职日赚", entities: [] } }
  });
  const ownerAlert = db.get("SELECT * FROM group_punishments WHERE user_id = '999' ORDER BY id DESC LIMIT 1");
  assert.ok(ownerAlert, "owner 发言也要预警：群规对谁都一样");
  assert.equal(ownerAlert.status, "pending");
  assert.equal(ownerAlert.chat_id, "-100");
  assert.match(ownerAlert.reason, /预警关键词/);
  const ownerCard = sentTo("999").map((c) => String(c.body.text)).join("\n");
  assert.ok(ownerCard.includes("预警关键词"), "预警卡片要私聊提醒管理员");
  assert.ok(ownerCard.includes("机器人管理员"), "要说明管理员不会被自动处置，免得以为机器人坏了");

  // 本群管理员（不是机器人管理员）发言同样预警
  const groupAdminUctx = {
    chatId: "-100", userId: "42", chatType: "supergroup",
    userKey: "user:42", sceneKey: "group:-100:user:42",
    username: "gadmin", firstName: "群管理员"
  };
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: groupAdminUctx, isGroupCtx: true,
    payload: { message: { text: "推广一下 加VX", entities: [] } }
  });
  assert.ok(
    db.get("SELECT * FROM group_punishments WHERE user_id = '42' ORDER BY id DESC LIMIT 1"),
    "本群管理员发言也要预警"
  );
  await Promise.all(ctx.pending);
  db.close();
});

test("处置记录里可以一键撤销，并公告 + 私聊当事人", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:555", 10);
  const punishmentId = seedPunishment(db);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data: `admin_guard_rev_${punishmentId}`,
        message: { message_id: 50, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  assert.equal(db.get("SELECT status FROM group_punishments WHERE id = ?", punishmentId).status, "revoked");
  assert.ok(callsOf("restrictChatMember").length >= 1);
  assert.ok(sentTo("-100").some((c) => String(c.body.text).includes("处置已撤销")));
  assert.ok(sentTo("555").some((c) => String(c.body.text).includes("已被管理员撤销")));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 5. 群规版本历史
// ==========================================

test("群规版本：每改一次留一个版本，可回滚", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  await setGroupGuard(env, "-100", { rules: "第一条：禁止广告", changedBy: "999" });
  await setGroupGuard(env, "-100", { rules: "第一条：禁止广告\n第二条：禁止刷屏", changedBy: "999", note: "追加" });
  // 只改默认处置不应产生新版本
  await setGroupGuard(env, "-100", { defaultAction: "mute" });

  const versions = await listRuleVersions(env, "-100", 1, 10);
  assert.equal(versions.total, 2, "只记录群规正文变化的版本");
  assert.equal(versions.rows[0].version, 2, "最新版本在前");

  // 回滚到 v1
  const { getRuleVersion } = await import("../src/services/guard.js");
  const v1 = await getRuleVersion(env, versions.rows[1].id);
  await setGroupGuard(env, "-100", { rules: v1.rules, changedBy: "999", note: `回滚到 v${v1.version}` });

  const settings = await getGroupGuard(env, "-100");
  assert.equal(settings.rules, "第一条：禁止广告");
  const after = await listRuleVersions(env, "-100", 1, 10);
  assert.equal(after.total, 3, "回滚本身也是一次变更（保留历史）");
  db.close();
});

test("群规面板：预警开关与关键词引导式编辑", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };

  const click = (data) => handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: `cb_${data}`, from: { id: 999 }, data,
        message: { message_id: 60, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  // 面板里能看到预警状态
  await click("admin_guard");
  const panel = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.ok(String(panel.text).includes("主动预警"));
  const keys = panel.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes("admin_guard_alert"));
  assert.ok(keys.includes("admin_guard_keywords"));
  assert.ok(keys.includes("admin_guard_ver_1"));

  // 关闭预警
  resetCalls();
  await click("admin_guard_alert");
  assert.equal(db.get("SELECT alert_enabled FROM group_guard WHERE chat_id = '-100'").alert_enabled, 0);

  // 引导式改关键词（群里直接发文字）
  resetCalls();
  await click("admin_guard_keywords");
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx, isGroupCtx: true,
    payload: { message: { text: "代购、私聊我、外挂", entities: [] } }
  });
  const saved = db.get("SELECT alert_keywords FROM group_guard WHERE chat_id = '-100'").alert_keywords;
  assert.equal(saved, "代购、私聊我、外挂");
  assert.ok(sentTexts().some((t) => t.includes("预警关键词已更新")));
  await Promise.all(ctx.pending);
  db.close();
});

test("群规历史面板：显示版本与回滚按钮", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };

  await setGroupGuard(env, "-100", { rules: "旧版群规：禁止广告", changedBy: "999" });
  await setGroupGuard(env, "-100", { rules: "新版群规：禁止广告与刷屏", changedBy: "999" });

  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data: "admin_guard_ver_1",
        message: { message_id: 61, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  const view = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body;
  assert.ok(String(view.text).includes("群规历史"));
  assert.ok(String(view.text).includes("当前"));
  const buttons = view.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.some((b) => b.startsWith("admin_guard_vr_")), "应能回滚旧版本");

  const restore = buttons.find((b) => b.startsWith("admin_guard_vr_"));
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb2", from: { id: 999 }, data: restore,
        message: { message_id: 61, chat: { id: -100, type: "supergroup" } }
      }
    }
  });
  assert.equal((await getGroupGuard(env, "-100")).rules, "旧版群规：禁止广告");
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 7. /help 的可见性跟着身份走
// ==========================================

test("/help：机器人角色按能力裁，本群管理员也能看到执法指令", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:777", 0);
  seedUser(db, "user:42", 0);
  seedUser(db, "user:111", 0);
  // 关掉群里的指令回执自动删除，测试不用等 5 秒
  db.exec(`INSERT INTO scene_settings (scene_key, name, value)
           VALUES ('group:-100', 'autodelete.cmd', '0')`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  chatMembers["-100:111"] = { status: "member", user: { id: 111 } };

  // 执法员（bot_admins）私聊 /help：能看到执法指令，看不到用户管理
  const { setAdmin } = await import("../src/services/admins.js");
  await setAdmin(env, "777", "moderator", { by: "999" });
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", isGroupCtx: false,
    uctx: {
      chatId: "777", userId: "777", chatType: "private",
      userKey: "user:777", sceneKey: "private:777", username: "mod", firstName: "执法员"
    },
    payload: { message: { text: "/help", entities: [] } }
  });
  const modHelp = sentTexts().join("\n");
  assert.match(modHelp, /\/mute/, "执法员应看到执法指令");
  assert.doesNotMatch(modHelp, /\/users/, "执法员不该看到用户管理");
  assert.doesNotMatch(modHelp, /仅管理员可用/, "执法员不该被当成普通用户");

  // 本群管理员（没有机器人角色）在群里 /help：能看到执法指令
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", isGroupCtx: true,
    uctx: {
      chatId: "-100", userId: "42", chatType: "supergroup",
      userKey: "user:42", sceneKey: "group:-100:user:42", username: "gadmin", firstName: "群管"
    },
    payload: { message: { text: "/help", entities: [] } }
  });
  const groupAdminHelp = sentTexts().join("\n");
  assert.match(groupAdminHelp, /你是本群管理员/, "本群管理员应看到自己的那一档");
  assert.doesNotMatch(groupAdminHelp, /仅管理员可用/);
  assert.doesNotMatch(groupAdminHelp, /\/users/, "本群管理员不该看到用户管理");

  // 普通成员在群里 /help：还是「仅管理员可用」
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999", isGroupCtx: true,
    uctx: {
      chatId: "-100", userId: "111", chatType: "supergroup",
      userKey: "user:111", sceneKey: "group:-100:user:111", username: "member", firstName: "成员"
    },
    payload: { message: { text: "/help", entities: [] } }
  });
  const memberHelp = sentTexts().join("\n");
  assert.match(memberHelp, /仅管理员可用/, "普通成员不该看到管理员那部分");
  await Promise.all(ctx.pending);
  db.close();
});
