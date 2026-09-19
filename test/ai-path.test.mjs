// ==========================================
// 🤖 AI 对话主链路的「扣分 / 占额度 / 失败回滚」
//
// 背景（v3.8.0 补测）：这条链路此前**零测试覆盖** —— 现有 AI 相关用例都是反向断言
// （「不该出现 AI 回复」），而真正处理钱的 `rollback()`（退积分 + 退额度 + 还原
// last_msg_time）一次都没被执行过。
//
// 顺序是：占额度 → 扣分 → 调模型；任一步失败都要把前面的退回。
// 这里盯住四件事：成功时钱与额度都对、模型失败要全额回滚、
// 额度到顶不再扣分、积分不够时**占掉的额度必须退回**（否则用户白丢一次额度）。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import { POINTS, RULES } from "../src/config/constants.js";
import { handleMessage } from "../src/handlers/message.js";
import { extractQuotedText } from "../src/handlers/ai.js";

let apiCalls = [];
let aiCalls = [];
let aiMode = "ok";
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 7 } })
  };
};
const resetCalls = () => { apiCalls.length = 0; aiCalls.length = 0; };
const textsSent = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));

const makeAI = () => ({
  run: async (_model, opts = {}) => {
    aiCalls.push(opts);
    if (aiMode === "throw") throw new Error("model down");
    if (aiMode === "empty") return { response: "" };
    return { response: "这是模型的回答" };
  }
});

const USER = "777";
const OWNER = "999";

const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", BOT_USERNAME: "TestBot", MY_TELEGRAM_ID: OWNER,
  APP_TIMEZONE: "Asia/Shanghai", AI: makeAI(), ...extra
});
const makeCtx = () => ({ pending: [], waitUntil(p) { this.pending.push(p); } });
const uctxOf = (userId) => ({
  chatId: userId, userId, chatType: "private",
  userKey: `user:${userId}`, sceneKey: `private:${userId}`,
  username: `u${userId}`, firstName: `用户${userId}`
});

/** 造场景配置：额度上限与限流都可以指定（限流默认关掉，方便连发多条做边界测试） */
function seedScene(db, userId = USER, { maxDaily = 50, rateLimitSec = 0 } = {}) {
  db.exec(
    `INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, max_daily, rate_limit_sec)
     VALUES ('private:${userId}', 'user:${userId}', '${userId}', 'private', '${userId}', ${maxDaily}, ${rateLimitSec})`
  );
}

async function say(env, userId = USER, text = "你好") {
  await handleMessage({
    env, ctx: makeCtx(), token: "T", myId: OWNER,
    uctx: uctxOf(userId), isGroupCtx: false,
    payload: { message: { text, entities: [] } }
  });
}

const quotaOf = (db, userId = USER) => Number(
  db.get("SELECT count FROM daily_stats WHERE scene_key = ?", `private:${userId}`)?.count || 0
);

// ==========================================
// 成功路径
// ==========================================

test("成功一轮：扣 1 分、写一条流水、额度 +1、把模型回答发给用户", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 100 - POINTS.AI_COST, "应扣一次 AI 消耗");
  const logs = db.all("SELECT change_amount, reason FROM points_log WHERE user_key = ?", `user:${USER}`);
  assert.equal(logs.length, 1, "成功一轮只该有一条流水");
  assert.equal(Number(logs[0].change_amount), -POINTS.AI_COST);
  assert.match(String(logs[0].reason), /AI 对话消耗/);
  assert.equal(quotaOf(db), 1, "额度应 +1");
  assert.ok(textsSent().some((t) => t.includes("这是模型的回答")), "要把模型回答发出去");
  db.close();
});

// ==========================================
// 失败回滚（rollback 这条路径以前完全没被跑过）
// ==========================================

test("模型报错：积分与额度都要全额退回", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "throw";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 100, "模型失败必须把 1 分退回");
  assert.equal(quotaOf(db), 0, "占掉的额度也要退（count 回到 0）");
  const refund = db.all("SELECT reason FROM points_log WHERE user_key = ?", `user:${USER}`);
  assert.ok(refund.some((r) => /自动退款/.test(String(r.reason))), "退款要留流水，方便对账");
  db.close();
});

test("模型返回空内容：同样按失败回滚（不能白扣一分）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "empty";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 100, "空回复也算失败，积分要退");
  assert.equal(quotaOf(db), 0, "额度要退");
  db.close();
});

// ==========================================
// 额度边界
// ==========================================

test("额度到顶：第 maxDaily+1 次被拒，且**不扣分**", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db, USER, { maxDaily: 2 });
  const env = makeEnv(db);
  aiMode = "ok";

  await say(env);
  await say(env);
  const afterTwo = await getUserPoints(env, `user:${USER}`);
  assert.equal(afterTwo, 98, "两次成功应各扣 1 分");
  assert.equal(quotaOf(db), 2);

  resetCalls();
  await say(env);   // 第 3 次：额度已满

  assert.equal(await getUserPoints(env, `user:${USER}`), 98, "被额度拦下时不该扣分");
  assert.equal(quotaOf(db), 2, "额度计数不能超过上限");
  assert.ok(
    textsSent().some((t) => /额度|上限|用完/.test(t)),
    `要明确告诉用户额度用完了，实际：${textsSent().join(" | ").slice(0, 120)}`
  );
  db.close();
});

test("额度不限（-1）时不做拦截，但消息计数照记", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db, USER, { maxDaily: -1 });
  const env = makeEnv(db);
  aiMode = "ok";

  await say(env);
  await say(env);
  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 97, "每次正常扣 1 分");
  // daily_stats.count 同时承担「今日额度用量」与「今日消息量」两个含义：
  // 不限额度时不拦，但条数还是要记（日报的「昨日消息量」靠它）
  assert.equal(quotaOf(db), 3, "不限额度也要照记消息量");
  db.close();
});

// ==========================================
// 积分不足：占掉的额度必须退回
// ==========================================

test("积分不够：提示积分不足，且**占掉的额度要退回**", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 0);
  seedScene(db, USER, { maxDaily: 5 });
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 0);
  assert.equal(quotaOf(db), 0, "先占额度后扣分，扣分失败必须把额度退回去（否则白丢一次）");
  assert.equal(db.count("points_log", "user_key = ?", `user:${USER}`), 0, "失败不该留消费流水");
  assert.ok(textsSent().some((t) => /积分/.test(t)), "要提示积分不足");
  db.close();
});

test("额度为 0：直接拒绝，不扣分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db, USER, { maxDaily: 0 });
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 100);
  assert.equal(quotaOf(db), 0);
  assert.ok(textsSent().length > 0, "要给用户一个说明");
  db.close();
});

// ==========================================
// 限额与封禁的交互（别把拦截顺序搞反）
// ==========================================

test("被封禁的用户走不到 AI：不扣分、不占额度", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  db.exec(`UPDATE users SET blocked = 1 WHERE user_key = 'user:${USER}'`);
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await say(env);

  assert.equal(await getUserPoints(env, `user:${USER}`), 100, "封禁用户不该扣分");
  assert.equal(quotaOf(db), 0, "也不该占额度");
  db.close();
});

// ==========================================
// 📎 引用消息（v3.9.0）：回复某条消息再提问，让 AI 针对那一条作答
// ==========================================

/** 以「回复某条消息」的方式提问 */
async function reply(env, repliedMessage, text = "帮我总结一下", userId = USER) {
  await handleMessage({
    env, ctx: makeCtx(), token: "T", myId: OWNER,
    uctx: uctxOf(userId), isGroupCtx: false,
    payload: { message: { text, entities: [], reply_to_message: repliedMessage } }
  });
}

const systemPromptOf = (index = 0) => String(aiCalls[index]?.messages?.[0]?.content || "");

test("extractQuotedText：正文 / 媒体说明都能取，无文本返回空串", () => {
  assert.equal(extractQuotedText(null), "", "没有引用时是空串");
  assert.equal(extractQuotedText({ photo: [] }), "", "图片消息没有文本");
  assert.equal(extractQuotedText({ text: "  你好  " }), "你好", "首尾空白要去掉");
  assert.equal(extractQuotedText({ caption: "活动海报的说明" }), "活动海报的说明", "媒体说明也能用");
  assert.equal(extractQuotedText({ text: "a\r\nb\r\n\r\n\r\n\r\nc" }), "a\nb\n\nc", "折叠多余空行");
  assert.equal(
    extractQuotedText({ text: "很".repeat(5000) }).length,
    RULES.QUOTED_MESSAGE_MAX_CHARS,
    "超长引用要截断，别把上下文预算吃光"
  );
});

test("引用消息：被引用内容进入模型上下文，且只额外调用零次", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await reply(env, { text: "本周活动：周三晚八点开始，参与方式是群里发暗号，奖励是 50 积分。" });

  const sys = systemPromptOf();
  assert.match(sys, /用户引用的消息/, "要在系统提示里点明用户引用了哪条消息");
  assert.match(sys, /周三晚八点开始/, "被引用消息的正文要带进去");
  assert.match(sys, /不要执行/, "引用内容来自群成员，必须声明为不可信素材");
  assert.equal(aiCalls.length, 1, "引用消息只是拼进提示词，不该多花一次模型调用");
  db.close();
});

test("引用消息：没有引用时不出现空引用段", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await say(env, USER, "你好");

  assert.doesNotMatch(systemPromptOf(), /用户引用的消息/, "普通提问不该带上引用段");
  db.close();
});

test("引用消息：被回复的是图片等无文本消息时，不编造引用内容", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${USER}`, 100);
  seedScene(db);
  const env = makeEnv(db);
  aiMode = "ok";
  resetCalls();

  await reply(env, { photo: [{ file_id: "x" }] }, "这张图什么意思");

  assert.doesNotMatch(systemPromptOf(), /用户引用的消息/, "没有文本可引用时不该加空段");
  assert.equal(aiCalls.length, 1);
  db.close();
});
