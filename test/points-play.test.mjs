// ==========================================
// 💸🎁 积分玩法（v3.0.0）：转账 + 抽奖
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import { LOTTERY, TRANSFER } from "../src/config/constants.js";
import { expectedPrize, hasFreeDrawToday, pickPrize } from "../src/services/lottery.js";

let apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 1 } })
  };
};
const textsOf = (method) => apiCalls.filter((c) => c.method === method).map((c) => String(c.body.text || ""));
const resetCalls = () => { apiCalls.length = 0; };

const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", BOT_USERNAME: "TestBot", MY_TELEGRAM_ID: "999",
  APP_TIMEZONE: "Asia/Shanghai", ...extra
});
const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};
const uctxOf = (userId, chatType = "private") => ({
  chatId: chatType === "private" ? userId : "-100",
  userId, chatType,
  userKey: `user:${userId}`,
  sceneKey: chatType === "private" ? `private:${userId}` : `group:-100:user:${userId}`,
  username: `u${userId}`, firstName: `用户${userId}`
});

const { handleMessage } = await import("../src/handlers/message.js");
const { handleCallback } = await import("../src/handlers/callback.js");
const { draw } = await import("../src/services/lottery.js");

// ==========================================
// 抽奖
// ==========================================

test("奖池：权重越高越常见，且期望值低于付费成本（不会刷分）", () => {
  assert.ok(LOTTERY.PRIZES.length >= 4);
  const ev = expectedPrize();
  assert.ok(ev > 0 && ev < LOTTERY.PAID_COST, `期望值 ${ev} 应低于单次成本 ${LOTTERY.PAID_COST}`);

  // 抽 300 次，结果必须都来自奖池
  const allowed = new Set(LOTTERY.PRIZES.map((p) => p.points));
  for (let i = 0; i < 300; i++) {
    assert.ok(allowed.has(pickPrize()), "抽到的奖品必须在奖池内");
  }
});

test("免费抽奖：每天一次，第二次会被挡下", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 0);
  const env = makeEnv(db);

  const first = await draw(env, "user:1", "free");
  assert.equal(first.ok, true);
  assert.ok(first.prize > 0);
  assert.equal(first.cost, 0);
  assert.equal(await getUserPoints(env, "user:1"), first.prize, "免费抽奖积分到账");
  assert.equal(await hasFreeDrawToday(env, "user:1"), true);

  const second = await draw(env, "user:1", "free");
  assert.equal(second.ok, false);
  assert.equal(second.already, true);
  assert.equal(await getUserPoints(env, "user:1"), first.prize, "重复抽奖不改变积分");
  db.close();
});

test("付费抽奖：先扣分再发奖，积分不足直接拒绝", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 25);
  const env = makeEnv(db);

  const res = await draw(env, "user:1", "paid");
  assert.equal(res.ok, true);
  assert.equal(res.cost, LOTTERY.PAID_COST);
  assert.equal(await getUserPoints(env, "user:1"), 25 - LOTTERY.PAID_COST + res.prize);

  // 抽到不够扣为止
  seedUser(db, "user:2", LOTTERY.PAID_COST - 1);
  const poor = await draw(env, "user:2", "paid");
  assert.equal(poor.ok, false);
  assert.match(poor.error, /积分不足/);
  assert.equal(await getUserPoints(env, "user:2"), LOTTERY.PAID_COST - 1, "失败不扣分");
  db.close();
});

test("抽奖流水：每次抽奖都写一条 points_log", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const env = makeEnv(db);

  await draw(env, "user:1", "free");
  await draw(env, "user:1", "paid");
  const logs = db.all("SELECT change_amount, reason FROM points_log WHERE user_key = 'user:1' ORDER BY id");
  assert.equal(logs.length, 2);
  assert.match(String(logs[0].reason), /每日免费/);
  assert.match(String(logs[1].reason), /花费/);
  db.close();
});

test("/lottery：私聊与群里都能打开面板，按钮可抽奖", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "/lottery", entities: [] } }
  });
  assert.ok(textsOf("sendMessage").some((t) => t.includes("每日抽奖")), "应打开抽奖面板");
  const panelButtons = apiCalls
    .filter((c) => c.method === "sendMessage" && c.body.reply_markup)
    .at(-1)?.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data) || [];
  assert.ok(panelButtons.includes("lottery_draw_free"), "面板应有免费抽奖按钮");

  // 点「免费抽一次」
  resetCalls();
  await handleCallback({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"),
    payload: {
      callback_query: {
        id: "cb1", from: { id: 1 }, data: "lottery_draw_free",
        message: { message_id: 5, chat: { id: 1, type: "private" } }
      }
    }
  });
  assert.ok(textsOf("editMessageText").some((t) => t.includes("抽到")), "应展示抽奖结果");
  assert.ok(await getUserPoints(env, "user:1") > 100, "免费抽奖应加分");
  await Promise.all(ctx.pending);
  db.close();
});

test("抽奖功能开关：关掉后按钮被拦下", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { setFeature, GLOBAL_SCOPE } = await import("../src/services/features.js");
  await setFeature(env, GLOBAL_SCOPE, "lottery", false);

  resetCalls();
  await handleCallback({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"),
    payload: {
      callback_query: {
        id: "cb1", from: { id: 1 }, data: "lottery_draw_free",
        message: { message_id: 5, chat: { id: 1, type: "private" } }
      }
    }
  });
  assert.ok(
    apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("已关闭")),
    "关掉开关后应拒绝"
  );
  assert.equal(await getUserPoints(env, "user:1"), 100);
  await Promise.all(ctx.pending);
  db.close();
});

// ==========================================
// 转账
// ==========================================

test("/transfer：私聊按用户 ID 转账成功", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  seedUser(db, "user:2", 5);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "/transfer 2 40", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(await getUserPoints(env, "user:1"), 60);
  assert.equal(await getUserPoints(env, "user:2"), 45);
  assert.ok(textsOf("sendMessage").some((t) => t.includes("转账成功")));

  const logs = db.all("SELECT change_amount, reason FROM points_log ORDER BY id");
  assert.ok(logs.some((l) => Number(l.change_amount) === -40), "转出方应有负数流水");
  assert.ok(logs.some((l) => Number(l.change_amount) === 40), "收款方应有正数流水");
  db.close();
});

test("/transfer：回复消息 + 只写金额（群聊最常用的方式）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 30);
  seedUser(db, "user:2", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  // 群聊回执默认 5 秒后删除，测试里设成不删除避免白等
  db.exec("INSERT INTO scene_settings (scene_key, name, value) VALUES ('group:-100', 'autodelete.cmd', '0')");
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1", "supergroup"), isGroupCtx: true,
    payload: {
      message: {
        text: "/transfer 12",
        reply_to_message: { from: { id: 2, first_name: "小王" } }
      }
    }
  });
  await Promise.all(ctx.pending);

  assert.equal(await getUserPoints(env, "user:1"), 18);
  assert.equal(await getUserPoints(env, "user:2"), 12);
  db.close();
});

test("/transfer：余额不足 / 转给自己 / 对方没账户 / 金额非法都会被挡住", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 5);
  seedUser(db, "user:2", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();

  const send = async (text, extra = {}) => {
    resetCalls();
    await handleMessage({
      env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
      payload: { message: { text, entities: [], ...extra } }
    });
    await Promise.all(ctx.pending);
  };

  await send("/transfer 2 100");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("积分不足")));
  assert.equal(await getUserPoints(env, "user:1"), 5);

  await send("/transfer 1 1");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("不能给自己")));

  await send("/transfer 77777 1");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("还没有和机器人交互过")));

  await send("/transfer 2 abc");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("转账数量")));

  await send(`/transfer 2 ${TRANSFER.MAX + 1}`);
  assert.ok(textsOf("sendMessage").some((t) => t.includes("转账数量")));

  assert.equal(await getUserPoints(env, "user:1"), 5, "所有失败路径都不该动积分");
  db.close();
});

test("转账功能开关：关掉后不发积分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 50);
  seedUser(db, "user:2", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { setFeature, GLOBAL_SCOPE } = await import("../src/services/features.js");
  await setFeature(env, GLOBAL_SCOPE, "transfer", false);

  resetCalls();
  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "/transfer 2 10", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.ok(textsOf("sendMessage").some((t) => t.includes("已关闭")), "关掉开关后应提示功能已关闭");
  assert.equal(await getUserPoints(env, "user:1"), 50);
  assert.equal(await getUserPoints(env, "user:2"), 0);
  db.close();
});
