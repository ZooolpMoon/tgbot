// ==========================================
// 🧠 AI 上下文裁剪
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { trimHistory, clampMessage, resolveHistoryBudget } from "../src/services/history.js";
import { RULES } from "../src/config/constants.js";
import { randomInt, randomFloat } from "../src/utils/random.js";
import { escapeHtml } from "../src/utils/html.js";

test("trimHistory 从最新往前保留，超出预算就丢弃最旧的", () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push({ role: "user", content: `Q${i} ` + "x".repeat(200) });
    history.push({ role: "assistant", content: `A${i} ` + "y".repeat(200) });
  }

  const kept = trimHistory(history, 1000);
  const used = kept.reduce((n, m) => n + m.content.length + 8, 0);
  assert.ok(used <= 1000, `裁剪后超出预算：${used}`);
  assert.ok(kept.length >= 1);
  assert.match(kept[kept.length - 1].content, /^A9/, "最新一条必须保留");
  assert.ok(!kept.some((m) => m.content.startsWith("Q0 ")), "最旧的应被丢弃");
});

test("trimHistory 会过滤 system 消息与空内容，并统一 role", () => {
  const kept = trimHistory([
    { role: "system", content: "系统提示" },
    { role: "user", content: "" },
    { role: "assistant", content: "有效回复" },
    { role: "weird", content: "未知角色" }
  ], 1000);

  assert.equal(kept.length, 2);
  assert.deepEqual(kept[0], { role: "assistant", content: "有效回复" });
  assert.equal(kept[1].role, "user", "未知角色按 user 处理");
});

test("单条超长消息被截断，但仍会保留", () => {
  const long = "a".repeat(5000);
  const kept = trimHistory([{ role: "user", content: long }], 100);
  assert.equal(kept.length, 1);
  assert.ok(kept[0].content.length < long.length);
  assert.match(kept[0].content, /…（已截断）$/);

  assert.equal(clampMessage("short"), "short");
  assert.equal(clampMessage(null), "");
});

test("history 预算可由环境变量覆盖，非法值回退默认", () => {
  assert.equal(resolveHistoryBudget({}), RULES.HISTORY_MAX_CHARS);
  assert.equal(resolveHistoryBudget({ AI_HISTORY_MAX_CHARS: "2000" }), 2000);
  assert.equal(resolveHistoryBudget({ AI_HISTORY_MAX_CHARS: "10" }), RULES.HISTORY_MAX_CHARS, "过小的值不生效");
  assert.equal(resolveHistoryBudget({ AI_HISTORY_MAX_CHARS: "abc" }), RULES.HISTORY_MAX_CHARS);
});

test("randomInt 落在范围内且拒绝非法参数", () => {
  for (let i = 0; i < 200; i++) {
    const n = randomInt(6);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 6);
  }
  assert.throws(() => randomInt(0), RangeError);
  assert.throws(() => randomInt(-1), RangeError);
  assert.throws(() => randomInt(1.5), RangeError);

  for (let i = 0; i < 50; i++) {
    const f = randomFloat();
    assert.ok(f >= 0 && f < 1);
  }
});

test("escapeHtml 转义用户可控文本", () => {
  assert.equal(escapeHtml("<b>&\"'"), "&lt;b&gt;&amp;\"'");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
});
