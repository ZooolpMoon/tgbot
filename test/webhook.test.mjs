// ==========================================
// 🔗 Webhook 自愈巡检测试
//
// 覆盖：期望地址的来源与优先级、地址登记的防伪造、
//       地址被清空后的自动恢复、投递异常告警去重、
//       「地址非空但不同」时保持不动、isolate 内节流。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  ensureWebhook,
  noteIncomingWebhook,
  expectedWebhookUrl,
  resetWebhookCache
} from "../src/services/webhook.js";
import { getSetting } from "../src/services/settings.js";
import { resetAlertCache } from "../src/services/alerts.js";

// ---- Telegram API 桩 ----
let apiCalls = [];
let telegram = { url: "", lastError: "" };
let setWebhookResult = true;

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });

  const ok = (result) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result })
  });

  if (method === "getWebhookInfo") {
    const result = { url: telegram.url, pending_update_count: 0, has_custom_certificate: false };
    if (telegram.lastError) result.last_error_message = telegram.lastError;
    return ok(result);
  }
  if (method === "setWebhook") {
    if (!setWebhookResult) {
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ ok: false, description: "Bad Request: invalid webhook URL" }) };
    }
    telegram.url = body.url;
    return ok(true);
  }
  return ok({ message_id: 99 });
};

const callsOf = (method) => apiCalls.filter((c) => c.method === method);
const alertsSent = () => apiCalls.filter((c) => c.method === "sendMessage" && String(c.body.text || "").includes("机器人异常"));

const makeEnv = (db, extra = {}) => ({
  DB: db,
  BOT_TOKEN: "TEST_TOKEN",
  MY_TELEGRAM_ID: "999",
  ...extra
});

/** 收集 waitUntil 的 ctx（worker.fetch 里有两个后台任务挂在上面） */
const makeCtx = () => {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p) };
};

/** 每个用例都从干净状态开始（模块级缓存与节流要重置） */
function fresh() {
  apiCalls = [];
  telegram = { url: "", lastError: "" };
  setWebhookResult = true;
  resetWebhookCache();
  resetAlertCache();
  return createTestDB();
}

test("期望地址：env.WEBHOOK_URL 优先于库里的记录", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_URL: "https://configured.example.com" });

  await noteIncomingWebhook(env, "https://tgbot.zoolp.workers.dev/", { verified: true });

  assert.equal(await expectedWebhookUrl(env), "https://configured.example.com");
  assert.equal(await getSetting(env, "webhook.url", ""), "", "配了 WEBHOOK_URL 就不该再记请求来源");
  db.close();
});

test("地址登记：没通过 secret 校验的请求改不掉期望地址", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  const recorded = await noteIncomingWebhook(env, "https://evil.example.com/", { verified: false });

  assert.equal(recorded, "");
  assert.equal(await getSetting(env, "webhook.url", ""), "", "伪造请求不能写进期望地址");
  db.close();
});

test("地址登记：校验通过后只记 origin，丢掉 path 与查询串", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  await noteIncomingWebhook(env, "https://tgbot.zoolp.workers.dev/bot?x=1", { verified: true });

  assert.equal(await getSetting(env, "webhook.url", ""), "https://tgbot.zoolp.workers.dev");
  db.close();
});

test("自愈：地址为空时补回期望地址，并带上 secret_token 与告警", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_SECRET: "s3cret-value" });
  await noteIncomingWebhook(env, "https://tgbot.zoolp.workers.dev/", { verified: true });
  apiCalls = [];

  const res = await ensureWebhook(env, "TEST_TOKEN", { force: true });

  assert.equal(res.checked, true);
  assert.equal(res.repaired, true);
  assert.equal(res.url, "https://tgbot.zoolp.workers.dev");

  const setCall = callsOf("setWebhook")[0];
  assert.ok(setCall, "地址为空时必须调用 setWebhook");
  assert.equal(setCall.body.url, "https://tgbot.zoolp.workers.dev");
  assert.equal(setCall.body.secret_token, "s3cret-value", "要带上 secret_token 才能恢复来源校验");
  assert.equal(alertsSent().length, 1, "自愈成功要私聊管理员一条");
  db.close();
});

test("自愈：setWebhook 失败时如实返回 error", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_URL: "https://tgbot.zoolp.workers.dev" });
  setWebhookResult = false;

  const res = await ensureWebhook(env, "TEST_TOKEN", { force: true });

  assert.equal(res.repaired, false);
  assert.match(String(res.error), /invalid webhook URL/);
  assert.equal(alertsSent().length, 0, "没修好就不发「已恢复」的告警");
  db.close();
});

test("自愈：地址非空但与期望不同时保持不动", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_URL: "https://tgbot.zoolp.workers.dev" });
  telegram.url = "https://my-own-domain.example.com/";

  const res = await ensureWebhook(env, "TEST_TOKEN", { force: true });

  assert.equal(res.checked, true);
  assert.equal(res.url, "https://my-own-domain.example.com/");
  assert.equal(callsOf("setWebhook").length, 0, "有意配的地址不能被自愈覆盖");
  db.close();
});

test("自愈：投递异常只告警一次，恢复了就清掉标记", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_URL: "https://tgbot.zoolp.workers.dev" });
  telegram.url = "https://tgbot.zoolp.workers.dev/";
  telegram.lastError = "Wrong response from the webhook: 401 Unauthorized";

  await ensureWebhook(env, "TEST_TOKEN", { force: true });
  assert.equal(alertsSent().length, 1, "第一次发现要告警");
  assert.equal(await getSetting(env, "webhook.last_error", ""), telegram.lastError);

  // 同一个错误重复巡检：不再刷屏
  await ensureWebhook(env, "TEST_TOKEN", { force: true });
  assert.equal(alertsSent().length, 1);

  // 投递恢复后标记清空，下次真出问题还会提醒
  telegram.lastError = "";
  await ensureWebhook(env, "TEST_TOKEN", { force: true });
  assert.equal(await getSetting(env, "webhook.last_error", ""), "");
  db.close();
});

test("自愈：不知道期望地址时不查 Telegram（公开模板默认就是这样）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db);

  const res = await ensureWebhook(env, "TEST_TOKEN", { force: true });

  assert.equal(res.checked, false);
  assert.equal(callsOf("getWebhookInfo").length, 0);
  db.close();
});

test("自愈：isolate 内节流，10 分钟内只查一次", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_URL: "https://tgbot.zoolp.workers.dev" });
  telegram.url = "https://tgbot.zoolp.workers.dev/";

  await ensureWebhook(env, "TEST_TOKEN");
  assert.equal(callsOf("getWebhookInfo").length, 1);

  const second = await ensureWebhook(env, "TEST_TOKEN");
  assert.equal(second.checked, false);
  assert.equal(second.skipped, "距上次巡检不足 10 分钟");
  assert.equal(callsOf("getWebhookInfo").length, 1, "第二次不该再问 Telegram");
  db.close();
});

test("入口：secret 校验拦下伪造请求，通过校验的请求才会登记地址", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = fresh();
  const env = makeEnv(db, { WEBHOOK_SECRET: "s3cret-value" });
  const { default: worker } = await import("../src/index.js");
  const post = (headers, body) => worker.fetch(
    new Request("https://tgbot.zoolp.workers.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    }),
    env, makeCtx()
  );

  // 没有 secret_token 头 → 直接拒绝，也不该动库
  const denied = await post({}, { update_id: 1 });
  assert.equal(denied.status, 401);
  assert.equal(await getSetting(env, "webhook.url", ""), "");

  // 带上正确的头 → 放行，并把本次请求的 origin 记下来供自愈使用
  const ctx = makeCtx();
  const allowed = await worker.fetch(
    new Request("https://tgbot.zoolp.workers.dev/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "s3cret-value"
      },
      body: JSON.stringify({ update_id: 2 })
    }),
    env, ctx
  );
  await Promise.all(ctx.pending);

  assert.equal(allowed.status, 200);
  assert.equal(await getSetting(env, "webhook.url", ""), "https://tgbot.zoolp.workers.dev");
  db.close();
});
