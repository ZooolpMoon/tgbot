// ==========================================
// 🔗 入口链路集成测试
// 桩掉 Telegram API，真实驱动 handleMessage / handleCallback
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";
import { createRedeemCode } from "../src/services/redeem.js";
import { getOrderNote } from "../src/shop/notes.js";
import { getUserPoints } from "../src/services/users.js";

// ---- Telegram API 桩 ----
const apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 99 } })
  };
};

const { handleMessage } = await import("../src/handlers/message.js");
const { handleCallback } = await import("../src/handlers/callback.js");

const sentTexts = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
const lastText = () => sentTexts().at(-1) || "";
const findText = (needle) => sentTexts().some((t) => t.includes(needle));
const resetCalls = () => { apiCalls.length = 0; };

function makeEnv(db, extra = {}) {
  return {
    DB: db,
    AI: { run: async () => ({ response: "AI 回复" }) },
    BOT_TOKEN: "TEST_TOKEN",
    BOT_USERNAME: "TestBot",
    MY_TELEGRAM_ID: "999",
    APP_TIMEZONE: "Asia/Shanghai",
    BOT_OWNER_NAME: "管理员",
    BOT_OWNER_USERNAME: "admin",
    ...extra
  };
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
}

const uctx = (over = {}) => ({
  chatId: "1",
  userId: "1",
  chatType: "private",
  userKey: "user:1",
  sceneKey: "private:1",
  username: "tester",
  firstName: "测试用户",
  ...over
});

test("/redeem 兑换成功并加积分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 10);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { code } = await createRedeemCode(env, { points: 40 });

  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx(), isGroupCtx: false,
    payload: { message: { text: `/redeem ${code}`, entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(await getUserPoints(env, "user:1"), 50);
  assert.ok(findText("兑换成功"), lastText().slice(0, 40));
  db.close();
});

test("群聊里不能兑换（提示去私聊）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const { code } = await createRedeemCode(env, { points: 40 });

  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx({ chatId: "-100", chatType: "supergroup", sceneKey: "group:-100:user:1" }),
    isGroupCtx: true,
    payload: { message: { text: `/redeem ${code}`, entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(await getUserPoints(env, "user:1"), 0, "群里不应发放积分");
  assert.ok(findText("私聊"));
  db.close();
});

test("管理员 /code_new 生成兑换码（需先解锁）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  const nowSec = Math.floor(Date.now() / 1000);

  // 未解锁：应被拦下
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx({ userId: "999", userKey: "user:999" }), isGroupCtx: false,
    payload: { message: { text: "/code_new 100", entities: [] } }
  });
  assert.ok(findText("请先输入 /admin"), lastText().slice(0, 40));
  assert.equal(db.count("redeem_codes"), 0);

  // 解锁后再试
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('1', ${nowSec + 600})`);
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx({ userId: "999", userKey: "user:999" }), isGroupCtx: false,
    payload: { message: { text: "/code_new 100 5 7", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(db.count("redeem_codes"), 1);
  const row = db.get("SELECT points, max_uses, expires_at FROM redeem_codes");
  assert.equal(row.points, 100);
  assert.equal(row.max_uses, 5);
  assert.ok(row.expires_at, "应写入过期日期");
  assert.ok(findText("兑换码已生成"), lastText().slice(0, 40));

  // 审计日志应记录下来
  assert.equal(db.get("SELECT action FROM admin_logs ORDER BY id DESC LIMIT 1").action, "redeem_code_create");
  db.close();
});

test("下单备注：按钮 → 文本输入 → 写入订单草稿", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const itemId = seedItem(db, { name: "限定手办", price: 10, stock: 3 });
  const env = makeEnv(db);
  const ctx = makeCtx();

  // 1) 点「填写备注」
  resetCalls();
  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: uctx(),
    payload: {
      callback_query: {
        id: "cb1", data: `shop_note_${itemId}`,
        message: { message_id: 5, chat: { id: 1, type: "private" } },
        from: { id: 1, username: "tester", first_name: "测试用户" }
      }
    }
  });
  await Promise.all(ctx.pending);
  assert.ok(findText("填写下单备注"), lastText().slice(0, 40));

  // 2) 回复备注内容
  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx(), isGroupCtx: false,
    payload: { message: { text: "北京市朝阳区 xx 路 1 号", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.equal(await getOrderNote(env, "1", itemId), "北京市朝阳区 xx 路 1 号");
  assert.ok(findText("备注已保存"));
  assert.ok(!findText("AI 回复"), "备注输入不应被当成 AI 对话");
  db.close();
});

test("被封禁用户的普通消息不会触发 AI", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  db.exec("UPDATE users SET blocked = 1 WHERE user_key = 'user:1'");
  const env = makeEnv(db);
  const ctx = makeCtx();

  resetCalls();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: uctx(), isGroupCtx: false,
    payload: { message: { text: "你好", entities: [] } }
  });
  await Promise.all(ctx.pending);

  assert.ok(findText("已被管理员限制"), lastText().slice(0, 40));
  assert.ok(!findText("AI 回复"));
  db.close();
});

test("定时任务入口：先清理过期数据，再给管理员发日报", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const ctx = makeCtx();
  const nowSec = Math.floor(Date.now() / 1000);

  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('1', ${nowSec - 60})`);
  db.exec("INSERT INTO shop_order_drafts (chat_id, item_id, note, updated_at) VALUES ('1', 1, 'x', datetime('now','-2 days'))");

  const { default: worker } = await import("../src/index.js");
  await worker.scheduled({ cron: "0 16 * * *" }, env, ctx);
  await Promise.all(ctx.pending);

  assert.equal(db.count("admin_sessions"), 0, "过期的管理员会话应被清理");
  assert.equal(db.count("shop_order_drafts"), 0, "陈旧备注草稿应被清理");
  assert.ok(findText("每日概况"), lastText().slice(0, 30));
  assert.ok(findText("待处理订单"), "日报里应包含待处理订单信息");
  db.close();
});
