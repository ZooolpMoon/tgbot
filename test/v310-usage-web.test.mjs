// ==========================================
// v3.10.0 守卫测试 · 用量统计 / Web 管理后台
//
// Web 后台的安全性靠三条：
//   1. 登录链接是**一次性**令牌，用过即失效
//   2. 会话 cookie 有 HMAC 签名，伪造的进不来
//   3. cookie 有效也**当场复核角色** —— 撤权后不该还能待到 cookie 过期
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import {
  countUsage, flushUsage, readUsage, groupUsage, resetUsageBuffer, METRIC
} from "../src/services/usage.js";
import { summarizeUsage } from "../src/admin/usage-panel.js";
import { handleWebAdmin, createLoginToken, csvCell } from "../src/web/admin.js";
import { USAGE } from "../src/config/constants.js";

function makeEnv(db, { aiReply = "ok" } = {}) {
  return {
    DB: db,
    AI: { run: async () => ({ response: aiReply }) },
    MY_TELEGRAM_ID: "999",
    WEBHOOK_SECRET: "test-secret"
  };
}

// ==========================================
// 📊 用量统计
// ==========================================

test("用量：内存累加后一次性落库，同一天的同一指标合并成一行", { skip: !hasSqlite }, async () => {
  resetUsageBuffer();
  const db = createTestDB();
  const env = makeEnv(db);

  countUsage(env, METRIC.AI_CALL);
  countUsage(env, METRIC.AI_CALL);
  countUsage(env, METRIC.AI_FAIL);
  assert.equal(await flushUsage(env, { force: true }), 2, "两个指标两条语句");

  const rows = await readUsage(env, 1);
  assert.equal(rows.find((r) => r.metric === METRIC.AI_CALL).count, 2, "同指标应累加");

  // 再记一次：应累加到同一行而不是新增一行
  countUsage(env, METRIC.AI_CALL);
  await flushUsage(env, { force: true });
  assert.equal((await readUsage(env, 1)).find((r) => r.metric === METRIC.AI_CALL).count, 3);
  assert.equal(db.count("usage_stats", "metric = ?", METRIC.AI_CALL), 1, "一天一个指标只有一行");
  db.close();
});

test("用量：没有数据库 / 没有变化时不写库", { skip: !hasSqlite }, async () => {
  resetUsageBuffer();
  const db = createTestDB();
  const env = makeEnv(db);

  assert.equal(await flushUsage(env, { force: true }), 0, "空缓冲不该产生写操作");
  assert.equal(countUsage({}, METRIC.AI_CALL), false, "没有 DB 时直接忽略");
  db.close();
});

test("用量：面板聚合出调用数、失败率与模型分布", () => {
  const byDate = new Map([
    ["2026-09-19", new Map([
      [METRIC.AI_CALL, 10], [METRIC.AI_FAIL, 2], [METRIC.MSG_IN, 50],
      ["ai.model.@cf/meta/llama-3.3", 8], ["ai.model.@cf/mistral/7b", 2]
    ])],
    ["2026-09-18", new Map([[METRIC.AI_CALL, 5], [METRIC.MSG_IN, 20]])]
  ]);

  const data = summarizeUsage(byDate);
  assert.equal(data.aiCall, 15);
  assert.equal(data.aiFail, 2);
  assert.equal(data.msgIn, 70);
  assert.equal(data.models.get("@cf/meta/llama-3.3"), 8);
  assert.equal(data.days[0].date, "2026-09-19", "按日期倒序");
});

test("用量：分组把多天多指标收敛成 日期 → 指标", () => {
  const byDate = groupUsage([
    { date_str: "2026-09-19", metric: "ai.call", count: 1 },
    { date_str: "2026-09-19", metric: "ai.call", count: 2 },
    { date_str: "2026-09-18", metric: "ai.call", count: 5 }
  ]);
  assert.equal(byDate.get("2026-09-19").get("ai.call"), 3);
  assert.equal(byDate.get("2026-09-18").get("ai.call"), 5);
});

test("用量：面板天数可配置且不为 0", () => {
  assert.ok(USAGE.PANEL_DAYS >= 1);
  assert.ok(USAGE.KEEP_DAYS >= USAGE.PANEL_DAYS, "保留天数至少要覆盖展示天数");
});

// ==========================================
// 🖥️ Web 管理后台
// ==========================================

test("Web 后台：CSV 字段中的逗号与引号会被正确转义", () => {
  assert.equal(csvCell("普通"), "普通");
  assert.equal(csvCell("含,逗号"), '"含,逗号"');
  assert.equal(csvCell('含"引号'), '"含""引号"');
  assert.equal(csvCell("含\n换行"), '"含\n换行"');
});

test("Web 后台：未登录时给说明页，API 给 401", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  const page = await handleWebAdmin(new Request("https://x.test/admin"), env);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("/web"), "要告诉用户去 Telegram 发 /web");

  const api = await handleWebAdmin(new Request("https://x.test/admin/api/overview"), env);
  assert.equal(api.status, 401);
  db.close();
});

test("Web 后台：一次性令牌换 cookie，令牌不能复用", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:999", 100);

  const token = await createLoginToken(env, "999");
  assert.ok(token);

  const login = await handleWebAdmin(new Request(`https://x.test/admin?t=${token}`), env);
  assert.equal(login.status, 302);
  const cookie = String(login.headers.get("set-cookie") || "");
  assert.ok(cookie.includes("tgbot_admin="), "应下发会话 cookie");
  assert.ok(cookie.includes("HttpOnly"), "cookie 必须是 HttpOnly");
  assert.ok(cookie.includes("SameSite=Strict"));

  // 同一个令牌再来一次 → 已经被消费掉
  const replay = await handleWebAdmin(new Request(`https://x.test/admin?t=${token}`), env);
  assert.equal(replay.status, 401);

  // 带 cookie 可以访问 API
  const cookieValue = cookie.split(";")[0];

  // 后台页面本体也要能渲染（登录后不该是一片空白）
  const page = await handleWebAdmin(
    new Request("https://x.test/admin", { headers: { cookie: cookieValue } }), env
  );
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes("概述") === false && pageHtml.includes("概览"), "应有概览标签");
  assert.ok(pageHtml.includes("/admin/api/overview"), "页面要能自己取到数据");
  assert.ok(pageHtml.includes("导出"), "应有导出入口");

  const api = await handleWebAdmin(
    new Request("https://x.test/admin/api/overview", { headers: { cookie: cookieValue } }), env
  );
  assert.equal(api.status, 200);
  const data = await api.json();
  assert.ok(Number.isFinite(data.users));
  db.close();
});

test("Web 后台：过期的令牌不能登录", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const past = Math.floor(Date.now() / 1000) - 10;
  db.exec(`INSERT INTO web_login_tokens (token, user_id, expires_at) VALUES ('old', '999', ${past})`);

  const res = await handleWebAdmin(new Request("https://x.test/admin?t=old"), env);
  assert.equal(res.status, 401);
  assert.equal(db.count("web_login_tokens", "token = 'old'"), 0, "过期令牌用掉也要删掉");
  db.close();
});

test("Web 后台：伪造的会话 cookie 会被拒绝", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  // 全部用 ASCII：HTTP 头不接受非 Latin-1 字符，中文会直接被 Request 拒掉
  for (const forged of ["999.9999999999.deadbeef", "999.1.aa", "not-a-cookie", "a.b.c"]) {
    const api = await handleWebAdmin(
      new Request("https://x.test/admin/api/overview", { headers: { cookie: `tgbot_admin=${forged}` } }), env
    );
    assert.equal(api.status, 401, `伪造 cookie 不该放行：${forged}`);
  }
  db.close();
});

test("Web 后台：非管理员换到 cookie 也进不去", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  // 造一个「不是管理员」的用户令牌（现实中生成端就拦了，这里验证读取端也拦）
  db.exec(`INSERT INTO web_login_tokens (token, user_id, expires_at)
           VALUES ('tok', '1234', ${Math.floor(Date.now() / 1000) + 600})`);

  const login = await handleWebAdmin(new Request("https://x.test/admin?t=tok"), env);
  assert.equal(login.status, 302, "令牌本身有效，会先换 cookie");
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

  const api = await handleWebAdmin(
    new Request("https://x.test/admin/api/overview", { headers: { cookie } }), env
  );
  assert.equal(api.status, 401, "换到了 cookie 也不是管理员，仍然进不去");
  db.close();
});

test("Web 后台：写接口会复核角色，执法员改不了用户积分", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  seedUser(db, "user:1", 100);

  // 造一个 moderator（只有执法能力，没有用户管理）
  db.exec("INSERT INTO bot_admins (user_id, role) VALUES ('7', 'moderator')");
  db.exec(`INSERT INTO web_login_tokens (token, user_id, expires_at)
           VALUES ('m', '7', ${Math.floor(Date.now() / 1000) + 600})`);
  const login = await handleWebAdmin(new Request("https://x.test/admin?t=m"), env);
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];

  const res = await handleWebAdmin(
    new Request("https://x.test/admin/api/users/points", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ target: "1", delta: 1000 })
    }),
    env
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.error, "forbidden", "执法员不该能改积分");
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 100, "积分没被改动");
  db.close();
});
