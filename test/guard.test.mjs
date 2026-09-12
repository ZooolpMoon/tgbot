// ==========================================
// 🛡️ 群规执法测试
//
// 覆盖：时长解析、动作识别、目标解析（回复 / @提及 / 用户ID）、
//       理由校验（内置违规类型 / 群规文本 / 群知识库）、
//       权限校验、确认卡片、执行落库（机器人封禁 / 踢出 / 限时禁言）。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import {
  parseDuration, formatDuration, detectAction, looksLikeGuardCommand,
  parsePunishmentRequest, validateReason
} from "../src/services/guard.js";

// ---- Telegram API 桩 ----
let apiCalls = [];
let chatMembers = {};              // `${chatId}:${userId}` → getChatMember 返回的 result

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

  if (method === "getMe") return ok({ id: 42, username: "TestBot", is_bot: true, first_name: "Test" });
  if (method === "getChatMember") {
    const member = chatMembers[`${body.chat_id}:${body.user_id}`];
    return member ? ok(member) : fail("Bad Request: user not found");
  }
  if (method === "banChatMember" || method === "unbanChatMember" || method === "restrictChatMember") return ok(true);
  return ok({ message_id: 99 });
};

// 只清 API 调用记录；成员权限表由各用例自行设置（否则会把刚设好的权限清掉）
const resetCalls = () => { apiCalls.length = 0; };
const sentTexts = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
const callsOf = (method) => apiCalls.filter((c) => c.method === method);
const lastKeyboard = () =>
  [...apiCalls].reverse().find((c) => c.body?.reply_markup)?.body.reply_markup || null;

const { handleMessage } = await import("../src/handlers/message.js");
const { handleCallback } = await import("../src/handlers/callback.js");

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: { run: async (_m, opts = {}) => (Array.isArray(opts.text) ? { data: opts.text.map(() => [1, 0, 0]) } : { response: "ok" }) },
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

/** 造一条「管理员 @机器人 说话」的群消息 */
const guardMessage = (text, extra = {}) => ({
  text,
  entities: [{ type: "mention", offset: 0, length: 9 }],
  ...extra
});

/** 调一次 handleMessage（群聊） */
const sendGroup = ({ env, ctx, message, uctx = adminUctx, myId = "999" }) => handleMessage({
  env, ctx, token: "TEST_TOKEN", myId, uctx, isGroupCtx: true, payload: { message }
});

// ==========================================
// 纯函数
// ==========================================

test("parseDuration：支持分钟/小时/天/永久与组合写法", () => {
  assert.deepEqual(parseDuration("禁言 30分钟"), { minutes: 30, matched: true });
  assert.deepEqual(parseDuration("禁言 2小时"), { minutes: 120, matched: true });
  assert.deepEqual(parseDuration("禁言 1天"), { minutes: 1440, matched: true });
  assert.deepEqual(parseDuration("禁言 3天2小时"), { minutes: 4440, matched: true });
  assert.deepEqual(parseDuration("永久禁言"), { minutes: 0, matched: true });
  assert.deepEqual(parseDuration("就禁言"), { minutes: 0, matched: false });

  assert.equal(formatDuration(30), "30 分钟");
  assert.equal(formatDuration(120), "2 小时");
  assert.equal(formatDuration(1440), "1 天");
  assert.equal(formatDuration(0), "永久");
});

test("detectAction：先判解除，再判具体处置", () => {
  assert.equal(detectAction("封禁 @a 广告"), "bot_ban");
  assert.equal(detectAction("把 @a 踢出群"), "kick");
  assert.equal(detectAction("给 @a 禁言 2 小时"), "mute");
  assert.equal(detectAction("群内封禁 @a"), "group_ban");
  assert.equal(detectAction("解除禁言 @a"), "unmute");
  assert.equal(detectAction("解封 @a"), "unban");
  assert.equal(detectAction("今天天气不错"), null);
  assert.equal(looksLikeGuardCommand("禁言他"), true);
});

test("validateReason：内置违规类型命中 / 不命中", async () => {
  const ad = await validateReason({ reason: "一直在发广告刷屏" });
  assert.equal(ad.ok, true);
  assert.match(ad.matchedRule, /广告/);

  const abuse = await validateReason({ reason: "辱骂其他群友" });
  assert.equal(abuse.ok, true);

  const bad = await validateReason({ reason: "我就是看他不顺眼" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /不符合群规/);

  const empty = await validateReason({ reason: "" });
  assert.equal(empty.ok, false);
});

test("validateReason：能用本群群规文本判定自定义违规", async () => {
  const rules = "本群禁止讨论其他游戏，禁止深夜刷本，禁止私下交易账号。";
  const hit = await validateReason({ reason: "私下交易账号", rules });
  assert.equal(hit.ok, true);
  assert.equal(hit.how, "匹配到本群群规");

  const miss = await validateReason({ reason: "说话声音太大", rules });
  assert.equal(miss.ok, false);
});

test("parsePunishmentRequest：回复消息 / @提及 / 用户ID 三种目标来源", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  // 1) 回复某人的消息
  const byReply = await parsePunishmentRequest({
    env,
    text: "@TestBot 封禁 发广告",
    message: { text: "@TestBot 封禁 发广告", reply_to_message: { from: { id: 555, first_name: "捣乱的人" } } },
    botUsername: "TestBot"
  });
  assert.equal(byReply.ok, true);
  assert.equal(byReply.userId, "555");
  assert.equal(byReply.action, "bot_ban");
  assert.equal(byReply.reason, "发广告");

  // 2) text_mention（带用户对象）
  const text = "@TestBot 禁言 @某人 2小时 刷屏";
  const byEntity = await parsePunishmentRequest({
    env, text,
    message: {
      text,
      entities: [
        { type: "mention", offset: 0, length: 9 },
        { type: "text_mention", offset: 12, length: 3, user: { id: 777, first_name: "某人" } }
      ]
    },
    botUsername: "TestBot"
  });
  assert.equal(byEntity.userId, "777");
  assert.equal(byEntity.action, "mute");
  assert.equal(byEntity.durationMin, 120);
  assert.equal(byEntity.reason, "刷屏");

  // 3) 纯 @用户名：需要库里查得到
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name)
           VALUES ('group:-100:user:888', 'user:888', '-100', 'supergroup', '888', 'BadBoy', '坏孩子')`);
  const byName = await parsePunishmentRequest({
    env,
    text: "@TestBot 踢出 @BadBoy 发诈骗链接",
    message: { text: "@TestBot 踢出 @BadBoy 发诈骗链接", entities: [{ type: "mention", offset: 0, length: 9 }, { type: "mention", offset: 12, length: 7 }] },
    botUsername: "TestBot"
  });
  assert.equal(byName.userId, "888");
  assert.equal(byName.action, "kick");

  // 4) 找不到目标
  const none = await parsePunishmentRequest({
    env, text: "@TestBot 封禁 广告", message: { text: "@TestBot 封禁 广告" }, botUsername: "TestBot"
  });
  assert.equal(none.ok, false);
  assert.match(none.error, /没找到要处置的用户/);

  db.close();
});

// ==========================================
// 群内自然语言执法（完整链路）
// ==========================================

test("群里 @机器人 说「封禁 @某人 发广告」→ 弹确认卡片，确认后机器人封禁", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:555", 30);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  // 发起人是本群管理员，机器人在群里也有管理权限
  chatMembers["-100:999"] = { status: "administrator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const text = "@TestBot 封禁 @坏孩子 发广告刷屏";
  await sendGroup({
    env, ctx,
    message: guardMessage(text, {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  const card = apiCalls.filter((c) => c.body?.reply_markup).at(-1);
  assert.ok(card, "应弹出确认卡片");
  assert.ok(String(card.body.text).includes("待确认"));
  assert.ok(String(card.body.text).includes("坏孩子"));
  assert.ok(String(card.body.text).includes("广告"), "卡片要显示理由");
  assert.ok(String(card.body.text).includes("广告 / 推广引流"), "卡片要显示依据");

  const keyboard = card.body.reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.some((b) => b.callback_data.startsWith("guard_go_")));
  assert.ok(keyboard.some((b) => b.callback_data.endsWith("_mute")), "应支持一键改成禁言");

  const pending = db.get("SELECT * FROM group_punishments ORDER BY id DESC LIMIT 1");
  assert.equal(pending.status, "pending");
  assert.equal(pending.action, "bot_ban");
  assert.equal(pending.user_id, "555");

  // 确认执行
  const goButton = keyboard.find((b) => b.callback_data.startsWith("guard_go_"));
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb1", from: { id: 999 }, data: goButton.callback_data,
        message: { message_id: 10, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:555'").blocked, 1, "应写入机器人封禁");
  assert.equal(db.get("SELECT status FROM group_punishments ORDER BY id DESC LIMIT 1").status, "done");
  assert.ok(sentTexts().some((t) => t.includes("群规处置")), "应发送群内公告");
  await Promise.all(ctx.pending);
  db.close();
});

test("理由对不上群规 → 不执行，只提示可用违规类型", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  await sendGroup({
    env, ctx,
    message: guardMessage("@TestBot 封禁 @坏孩子 我看他不顺眼", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  assert.ok(sentTexts().some((t) => t.includes("未执行")), "应提示未执行");
  assert.ok(!apiCalls.some((c) => c.body?.reply_markup), "不应弹确认卡片");
  const row = db.get("SELECT * FROM group_punishments ORDER BY id DESC LIMIT 1");
  assert.equal(row.status, "rejected");
  await Promise.all(ctx.pending);
  db.close();
});

test("非管理员 @机器人 下指令 → 拒绝", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:111", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  // 发起人 111 不是管理员
  chatMembers["-100:111"] = { status: "member", user: { id: 111 } };

  await sendGroup({
    env, ctx, myId: "999",
    uctx: { ...adminUctx, userId: "111", userKey: "user:111", sceneKey: "group:-100:user:111" },
    message: guardMessage("@TestBot 封禁 @坏孩子 广告", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  assert.ok(sentTexts().some((t) => t.includes("只有")), "应提示权限不足");
  assert.equal(db.count("group_punishments"), 0, "不应产生处置记录");
  await Promise.all(ctx.pending);
  db.close();
});

test("确认卡片可改成禁言；机器人无权限时拒绝执行", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "administrator", user: { id: 999 } };
  // 机器人只是普通成员 → 不能禁言
  chatMembers["-100:42"] = { status: "member", user: { id: 42 } };

  await sendGroup({
    env, ctx,
    message: guardMessage("@TestBot 禁言 @坏孩子 2小时 刷屏", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  const keyboard = lastKeyboard().inline_keyboard.flat();
  const goButton = keyboard.find((b) => b.callback_data.startsWith("guard_go_"));
  const cardText = apiCalls.filter((c) => c.body?.reply_markup).at(-1).body.text;
  assert.ok(cardText.includes("2 小时"), "卡片应显示禁言时长");

  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb2", from: { id: 999 }, data: goButton.callback_data,
        message: { message_id: 11, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  assert.equal(callsOf("restrictChatMember").length, 0, "没有权限时不应调用禁言接口");
  assert.ok(sentTexts().concat(apiCalls.map((c) => String(c.body?.text || ""))).some((t) => t.includes("无法执行")));
  assert.equal(db.get("SELECT status FROM group_punishments ORDER BY id DESC LIMIT 1").status, "pending");
  await Promise.all(ctx.pending);
  db.close();
});

test("管理员点「改为禁言」再确认 → 调用 restrictChatMember 并记录到期时间", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  await sendGroup({
    env, ctx,
    message: guardMessage("@TestBot 封禁 @坏孩子 发广告", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  const id = db.get("SELECT id FROM group_punishments ORDER BY id DESC LIMIT 1").id;
  const call = (data) => handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb3", from: { id: 999 }, data,
        message: { message_id: 12, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  await call(`guard_set_${id}_mute`);
  assert.equal(db.get("SELECT action FROM group_punishments WHERE id = ?", id).action, "mute");

  resetCalls();
  await call(`guard_go_${id}`);
  const restrict = callsOf("restrictChatMember").at(-1);
  assert.ok(restrict, "应调用禁言接口");
  assert.equal(String(restrict.body.user_id), "555");
  assert.equal(restrict.body.permissions.can_send_messages, false);
  assert.ok(restrict.body.until_date > Math.floor(Date.now() / 1000), "临时禁言应带到期时间");

  const row = db.get("SELECT * FROM group_punishments WHERE id = ?", id);
  assert.equal(row.status, "done");
  assert.ok(row.until_at > 0, "应记录到期时间");
  await Promise.all(ctx.pending);
  db.close();
});

test("取消卡片后不会执行", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:555", 30);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  await sendGroup({
    env, ctx,
    message: guardMessage("@TestBot 踢出 @坏孩子 发诈骗链接", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });
  const id = db.get("SELECT id FROM group_punishments ORDER BY id DESC LIMIT 1").id;

  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb4", from: { id: 999 }, data: `guard_no_${id}`,
        message: { message_id: 13, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  assert.equal(callsOf("banChatMember").length, 0);
  assert.equal(db.get("SELECT status FROM group_punishments WHERE id = ?", id).status, "cancelled");
  await Promise.all(ctx.pending);
  db.close();
});

test("命令形式：/mute @某人 30分钟 刷屏 也走校验与确认", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "administrator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  // 管理指令需要先 /admin 解锁
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('-100', ${Math.floor(Date.now() / 1000) + 600})`);

  const text = "/mute @BadBoy 30分钟 刷屏灌水";
  await sendGroup({
    env, ctx,
    message: {
      text,
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "bot_command", offset: 0, length: 5 }]
    }
  });

  const card = apiCalls.filter((c) => c.body?.reply_markup).at(-1);
  assert.ok(card, "/mute 应弹确认卡片");
  assert.ok(String(card.body.text).includes("30 分钟"));
  const row = db.get("SELECT * FROM group_punishments ORDER BY id DESC LIMIT 1");
  assert.equal(row.action, "mute");
  assert.equal(row.duration_min, 30);
  await Promise.all(ctx.pending);
  db.close();
});

test("功能开关：关掉「群规执法」后 @机器人 下指令不会触发处置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const { setFeature, GLOBAL_SCOPE } = await import("../src/services/features.js");
  await setFeature(env, GLOBAL_SCOPE, "guard", false);

  await sendGroup({
    env, ctx,
    message: guardMessage("@TestBot 封禁 @坏孩子 发广告", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  assert.equal(db.count("group_punishments"), 0, "关掉开关后不应产生处置");
  assert.ok(!apiCalls.some((c) => c.body?.reply_markup?.inline_keyboard?.flat?.().some((b) => String(b.callback_data).startsWith("guard_"))));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 群规引导式编辑面板
// ==========================================

/** 以机器人管理员身份点击一个面板按钮 */
const clickAdmin = ({ env, ctx, data, chatType = "supergroup" }) => handleCallback({
  env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
  payload: {
    callback_query: {
      id: `cb_${data}`, from: { id: 999 }, data,
      message: { message_id: 20, chat: { id: -100, type: chatType } }
    }
  }
});

test("群规面板：默认处置 / 默认禁言时长 / 开关都能改", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  // 打开面板
  await clickAdmin({ env, ctx, data: "admin_guard" });
  const panel = apiCalls.filter((c) => c.method === "editMessageText").at(-1);
  assert.ok(String(panel.body.text).includes("群规执法"));
  assert.ok(String(panel.body.text).includes("还没有群规"));
  const keys = panel.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes("admin_guard_rules"));
  assert.ok(keys.includes("admin_guard_hist_1"));

  // 默认处置 → 选「群内禁言」
  await clickAdmin({ env, ctx, data: "admin_guard_act_menu" });
  resetCalls();
  await clickAdmin({ env, ctx, data: "admin_guard_act_mute" });
  assert.equal(db.get("SELECT default_action FROM group_guard WHERE chat_id = '-100'").default_action, "mute");

  // 默认禁言时长 → 30 分钟
  await clickAdmin({ env, ctx, data: "admin_guard_mute_menu" });
  resetCalls();
  await clickAdmin({ env, ctx, data: "admin_guard_mute_30" });
  assert.equal(db.get("SELECT default_mute_minutes FROM group_guard WHERE chat_id = '-100'").default_mute_minutes, 30);

  // 关闭执法
  resetCalls();
  await clickAdmin({ env, ctx, data: "admin_guard_toggle" });
  assert.equal(db.get("SELECT enabled FROM group_guard WHERE chat_id = '-100'").enabled, 0);

  await Promise.all(ctx.pending);
  db.close();
});

test("群规引导式编辑：覆盖 / 追加 / 清空", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:999"] = { status: "creator", user: { id: 999 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  // 点「编辑群规」→ 进入引导
  await clickAdmin({ env, ctx, data: "admin_guard_rules" });
  assert.equal(db.get("SELECT step FROM guard_sessions WHERE chat_id = '-100'").step, "rules:replace");
  resetCalls();

  // 群里直接发正文（不 @ 机器人也应被引导流程接收）
  await sendGroup({ env, ctx, message: { text: "本群禁止广告与刷屏", entities: [] } });
  assert.equal(db.get("SELECT rules FROM group_guard WHERE chat_id = '-100'").rules, "本群禁止广告与刷屏");
  assert.equal(db.count("guard_sessions"), 0, "完成后应清掉会话");

  // 追加一条
  resetCalls();
  await clickAdmin({ env, ctx, data: "admin_guard_append" });
  await sendGroup({ env, ctx, message: { text: "禁止私下交易账号", entities: [] } });
  const rules = db.get("SELECT rules FROM group_guard WHERE chat_id = '-100'").rules;
  assert.equal(rules, "本群禁止广告与刷屏\n禁止私下交易账号");

  // 清空
  resetCalls();
  await clickAdmin({ env, ctx, data: "admin_guard_clearrules" });
  assert.equal(db.get("SELECT rules FROM group_guard WHERE chat_id = '-100'").rules, "");

  await Promise.all(ctx.pending);
  db.close();
});

test("群规面板：处置记录能看到待确认与已执行", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:555", 10);
  db.exec(`INSERT INTO group_punishments (chat_id, user_id, user_label, action, reason, matched_rule, status, operator_id)
           VALUES ('-100', '555', '坏孩子', 'mute', '刷屏', '刷屏 / 灌水', 'done', '999')`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await clickAdmin({ env, ctx, data: "admin_guard_hist_1" });
  const text = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(text.includes("坏孩子"));
  assert.ok(text.includes("已执行"));
  assert.ok(text.includes("群内禁言"));
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 成员举报 → 管理员一键处置（功能联动）
// ==========================================

test("成员举报：卡片发到管理员私聊，确认后在群里执行", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:111", 0);
  seedUser(db, "user:555", 10);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:111"] = { status: "member", user: { id: 111 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };
  // 默认处置设为「群内禁言 30 分钟」，便于断言 Telegram 调用
  const { setGroupGuard } = await import("../src/services/guard.js");
  await setGroupGuard(env, "-100", { defaultAction: "mute", defaultMuteMinutes: 30 });

  const memberUctx = { ...adminUctx, userId: "111", userKey: "user:111", sceneKey: "group:-100:user:111" };
  await sendGroup({
    env, ctx, myId: "999", uctx: memberUctx,
    message: guardMessage("@TestBot 举报 发广告刷屏", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  const row = db.get("SELECT * FROM group_punishments ORDER BY id DESC LIMIT 1");
  assert.ok(row, "应产生待确认记录");
  assert.equal(row.chat_id, "-100", "记录必须归属到群，便于执行");
  assert.equal(row.action, "mute");
  assert.equal(row.status, "pending");

  // 卡片应该发到管理员私聊（MY_TELEGRAM_ID = 999）
  const cardCall = apiCalls.filter((c) => c.body?.reply_markup).at(-1);
  assert.equal(String(cardCall.body.chat_id), "999", "确认卡片应发到管理员私聊");
  assert.ok(String(cardCall.body.text).includes("坏孩子"));

  // 群里给举报人回执
  assert.ok(sentTexts().some((t) => t.includes("已把举报转给管理员")));

  // 管理员在私聊里一键确认
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminUctx,
    payload: {
      callback_query: {
        id: "cb_report", from: { id: 999 }, data: `guard_go_${row.id}`,
        message: { message_id: 30, chat: { id: 999, type: "private" } }
      }
    }
  });

  const restrict = callsOf("restrictChatMember").at(-1);
  assert.ok(restrict, "应在群里执行禁言");
  assert.equal(String(restrict.body.chat_id), "-100");
  assert.equal(String(restrict.body.user_id), "555");
  assert.equal(db.get("SELECT status FROM group_punishments WHERE id = ?", row.id).status, "done");
  await Promise.all(ctx.pending);
  db.close();
});

test("成员举报但没有说明违规现象 → 只提示补充理由", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:111", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();
  chatMembers["-100:111"] = { status: "member", user: { id: 111 } };
  chatMembers["-100:42"] = { status: "administrator", can_restrict_members: true, user: { id: 42 } };

  const memberUctx = { ...adminUctx, userId: "111", userKey: "user:111", sceneKey: "group:-100:user:111" };
  await sendGroup({
    env, ctx, myId: "999", uctx: memberUctx,
    message: guardMessage("@TestBot 举报 我看他不爽", {
      reply_to_message: { from: { id: 555, first_name: "坏孩子" } },
      entities: [{ type: "mention", offset: 0, length: 9 }]
    })
  });

  assert.equal(db.count("group_punishments"), 0);
  assert.ok(sentTexts().some((t) => t.includes("举报理由需要说清")));
  await Promise.all(ctx.pending);
  db.close();
});
