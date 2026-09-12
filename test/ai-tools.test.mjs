// ==========================================
// 🛠️ AI 工具调用（v3.0.0）
//
// 覆盖：工具解析（含代码块 / 夹带文字）、只读工具执行、
//       一轮工具调用后给出最终回答、开关关闭时不注入工具说明。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { buildToolPrompt, parseToolCall, runTool } from "../src/services/ai-tools.js";

let apiCalls = [];
let aiCalls = [];
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
const resetCalls = () => { apiCalls.length = 0; aiCalls.length = 0; };

/** 可编排的 AI 桩：按顺序返回预设内容 */
const makeAI = (replies) => ({
  run: async (model, opts = {}) => {
    aiCalls.push({ model, messages: opts.messages });
    const next = replies.shift();
    return { response: typeof next === "function" ? next(opts) : next };
  }
});

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

// ==========================================
// 解析
// ==========================================

test("parseToolCall：整段 JSON / 代码块 / 夹带文字都能解析，非法输入返回 null", () => {
  assert.deepEqual(parseToolCall('{"tool":"get_my_points","args":{}}'), { name: "get_my_points", args: {} });
  assert.deepEqual(
    parseToolCall('```json\n{"tool":"search_knowledge","args":{"query":"退货"}}\n```'),
    { name: "search_knowledge", args: { query: "退货" } }
  );
  assert.deepEqual(
    parseToolCall('好的，我查一下。{"tool":"get_rank"}'),
    { name: "get_rank", args: {} }
  );

  assert.equal(parseToolCall("普通回答，没有任何工具"), null);
  assert.equal(parseToolCall('{"tool":"__evil__","args":{}}'), null, "未知工具应被拒绝");
  assert.equal(parseToolCall("{不是合法 JSON"), null);
});

test("buildToolPrompt：列出全部只读工具，并强调一次只调用一个", () => {
  const prompt = buildToolPrompt();
  assert.match(prompt, /get_my_points/);
  assert.match(prompt, /search_knowledge/);
  assert.match(prompt, /一次只能调用一个工具/);
});

// ==========================================
// 工具执行
// ==========================================

test("只读工具：积分 / 签到 / 排行榜 / 群规 / 知识库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 42);
  seedUser(db, "user:2", 100);
  db.exec(`INSERT INTO daily_checkin (user_key, date_str) VALUES ('user:1', '${new Date().toISOString().slice(0, 10)}')`);
  const env = makeEnv(db);

  const ctxInfo = { userKey: "user:1", chatId: "1", isGroupCtx: false };

  const points = await runTool(env, "get_my_points", {}, ctxInfo);
  assert.equal(points.ok, true);
  assert.equal(points.result.points, 42);

  const rank = await runTool(env, "get_rank", {}, ctxInfo);
  assert.equal(rank.result.top[0].points, 100, "第一名应是 100 分");
  assert.equal(rank.result.top.length, 2);

  const checkin = await runTool(env, "get_my_checkin", {}, ctxInfo);
  assert.equal(checkin.ok, true);
  assert.ok(checkin.result.totalDays >= 1);

  const rulesPrivate = await runTool(env, "get_group_rules", {}, ctxInfo);
  assert.match(String(rulesPrivate.result.note || ""), /私聊/);

  const unknown = await runTool(env, "drop_database", {}, ctxInfo);
  assert.equal(unknown.ok, false, "未知工具必须失败");
  db.close();
});

// ==========================================
// 端到端：模型先要数据，再给答案
// ==========================================

test("AI 工具调用：模型请求数据 → 我们执行 → 模型给出最终回答", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 77);
  const env = makeEnv(db, {
    AI: makeAI([
      '{"tool":"get_my_points","args":{}}',   // 第一次：要数据
      "你现在有 76 积分。"                      // 第二次：最终回答（已扣掉本次 AI 消耗的 1 分）
    ])
  });
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "我还有多少积分？", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(aiCalls.length, 2, "应发生两次模型调用（要数据 + 最终回答）");
  const followUp = aiCalls[1].messages.at(-1).content;
  assert.match(String(followUp), /工具结果/, "第二次请求里应带上工具结果");
  assert.match(String(followUp), /76/, "工具结果里应包含真实积分（77 - 本次消耗 1）");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("76 积分")), "最终回答应发给用户");
  db.close();
});

test("AI 工具调用：普通回答不会被当成工具调用", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 10);
  const env = makeEnv(db, { AI: makeAI(["今天天气不错，适合出门走走。"]) });
  const ctx = makeCtx();
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "今天天气如何", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(aiCalls.length, 1, "没有工具调用时只调一次模型");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("天气不错")));
  db.close();
});

test("AI 工具调用：关掉开关后不再往提示词里塞工具说明", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 10);
  const env = makeEnv(db, { AI: makeAI(["好的。"]) });
  const ctx = makeCtx();
  const { setFeature, GLOBAL_SCOPE } = await import("../src/services/features.js");
  await setFeature(env, GLOBAL_SCOPE, "ai_tools", false);
  resetCalls();

  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: uctxOf("1"), isGroupCtx: false,
    payload: { message: { text: "我还有多少积分", entities: [] } }
  });
  await Promise.all(ctx.pending);

  const systemPrompt = String(aiCalls[0].messages[0].content);
  assert.doesNotMatch(systemPrompt, /【可用工具】/, "关掉开关后不应注入工具说明");
  db.close();
});
