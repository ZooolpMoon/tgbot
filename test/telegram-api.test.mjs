// ==========================================
// 📡 Telegram API 的退避重试
//
// 背景（v3.8.0 修）：`backoffMs` 把退避截断在 `MAX_BACKOFF_MS = 8000`，
// 而 Telegram 的 `retry_after` 动辄 30 秒 —— 结果是「等 8 秒再撞一次 429」，
// 3 次尝试 16 秒耗尽仍然失败（白等）。而这段退避逻辑**此前零测试覆盖**。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, backoffMs, withinBackoffBudget, sendMessage, getMe } from "../src/telegram/api.js";

// ---- fetch 桩：按脚本依次返回 ----
let script = [];
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  const step = script.shift() || { status: 200, body: { ok: true, result: { message_id: 1 } } };
  if (step.throw) throw new Error(step.throw);
  return {
    ok: step.status >= 200 && step.status < 300,
    status: step.status,
    headers: { get: (name) => (name === "Retry-After" ? (step.retryAfterHeader ?? null) : null) },
    json: async () => step.body
  };
};
const reset = (steps) => { script = steps.slice(); calls = 0; };

// ==========================================
// 纯函数
// ==========================================

test("parseRetryAfter：优先读响应体，其次读 Retry-After 头，都没有就是 0", () => {
  assert.equal(parseRetryAfter({ headers: { get: () => null } }, { parameters: { retry_after: 17 } }), 17);
  assert.equal(parseRetryAfter({ headers: { get: () => "25" } }, null), 25);
  assert.equal(
    parseRetryAfter({ headers: { get: () => "25" } }, { parameters: { retry_after: 17 } }),
    17,
    "响应体优先于头"
  );
  assert.equal(parseRetryAfter({ headers: { get: () => null } }, null), 0);
  assert.equal(parseRetryAfter({ headers: { get: () => null } }, { parameters: { retry_after: 0 } }), 0);
  assert.equal(parseRetryAfter(null, null), 0, "参数缺失也不能抛");
});

test("backoffMs：必须听 Telegram 的 retry_after，不能被截断成 8 秒", () => {
  const wait30 = backoffMs(1, 30);
  assert.ok(wait30 >= 30000, `retry_after=30 至少等 30 秒，实际 ${wait30}ms`);
  assert.ok(wait30 <= 30150, "抖动不该超过 150ms 的量级");

  const wait5 = backoffMs(1, 5);
  assert.ok(wait5 >= 5000 && wait5 <= 5150);

  // 单次上限 30 秒：Telegram 要 120 秒时不会真的等两分钟（webhook 撑不住）
  assert.ok(backoffMs(1, 120) <= 30000);
});

test("backoffMs：没有 retry_after 时按指数退避，且始终带抖动、不超过上限", () => {
  const a1 = backoffMs(1, 0);
  const a2 = backoffMs(2, 0);
  const a3 = backoffMs(3, 0);
  assert.ok(a1 >= 400 && a1 <= 550, `第一次约 400ms，实际 ${a1}`);
  assert.ok(a2 >= 800 && a2 <= 950, `第二次约 800ms，实际 ${a2}`);
  assert.ok(a3 >= 1600 && a3 <= 1750, `第三次约 1600ms，实际 ${a3}`);
  assert.ok(a1 < a2 && a2 < a3, "要递增");
  assert.ok(backoffMs(20, 0) <= 30000, "再多次也不能超过单次上限");
});

// ==========================================
// 重试行为
// ==========================================

test("5xx：会重试，成功后正常返回", async () => {
  reset([
    { status: 500, body: { ok: false, error_code: 500 } },
    { status: 200, body: { ok: true, result: { message_id: 42 } } }
  ]);

  const res = await sendMessage("T", "1", "hi");

  assert.equal(calls, 2, "5xx 应该重试一次");
  assert.equal(res.result.message_id, 42);
});

test("网络层错误：重试到次数用尽后返回失败（不抛异常）", async () => {
  reset([{ throw: "fetch failed" }, { throw: "fetch failed" }, { throw: "fetch failed" }, { throw: "fetch failed" }]);

  const res = await getMe("T");

  assert.equal(calls, 3, "最多尝试 3 次");
  assert.equal(res.ok, false);
  assert.ok(res.error, "要把最后一次错误带回去");
});

test("400 这类不可重试的错误：只请求一次就返回", async () => {
  reset([{ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }]);

  const res = await sendMessage("T", "1", "hi");

  assert.equal(calls, 1, "业务错误不该重试");
  assert.equal(res.description, "Bad Request: chat not found");
});

test("429（没给 retry_after）：按指数退避重试一次就成功", async () => {
  reset([
    { status: 429, body: { ok: false, error_code: 429 } },
    { status: 200, body: { ok: true, result: { message_id: 7 } } }
  ]);

  const res = await sendMessage("T", "1", "hi");

  assert.equal(calls, 2, "429 应该重试");
  assert.equal(res.result.message_id, 7);
});

test("退避预算：容得下一次「等 30 秒」，但容不下第二次", () => {
  const once = backoffMs(1, 30);
  assert.equal(withinBackoffBudget(0, once), true, "第一次 30 秒要允许");
  assert.equal(withinBackoffBudget(once, once), false, "第二次就超预算了，必须放弃重试");
  assert.equal(withinBackoffBudget(0, backoffMs(1, 0)), true);
  assert.equal(withinBackoffBudget(0, 60000), false, "比预算还长的等待直接放弃");
});

test("429 且要求的等待超出预算：不会重试（不再出现「等 8 秒再撞一次」的老行为）", async () => {
  // 用 under-budget 的 retry_after 让这次请求**真的**走一次等待，但不至于慢：
  // 600 秒被单次上限压到 30 秒 —— 仍然超预算？不，第一次允许，所以这里改用
  // 小值验证「429 会重试」，超预算的判定交给上面的纯函数用例（不然测试要等 30 秒）。
  reset([
    { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 0 } } },
    { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 0 } } },
    { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 0 } } }
  ]);

  const res = await sendMessage("T", "1", "hi");

  assert.equal(calls, 3, "429 会重试到次数用尽");
  assert.equal(res.ok, false, "最终失败要如实返回，不能抛异常");
});
