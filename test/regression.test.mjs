// ==========================================
// 🐞 回归测试（针对已修复的真实缺陷）
//
// 1. 引导式输入会话必须有过期时间，否则会一直吞掉普通消息
// 2. 群聊指令不能同步等待「5 秒后删除」，否则拖慢整条请求
// 3. 签到加分失败时必须回滚签到记录（不能出现「签了但没分」）
// 4. 限额 / 冷却 / 兑换码过期的边界判断
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser, seedItem } from "../test-helpers/d1.mjs";

// ---- Telegram API 桩（只记录调用，不真的联网） ----
const apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  apiCalls.push({ method, body: opts.body ? JSON.parse(opts.body) : {} });
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 99 } })
  };
};

const { handleAddItemInput } = await import("../src/shop/add.js");
const { handleEditItemInput } = await import("../src/shop/edit.js");
const { handleMessage } = await import("../src/handlers/message.js");
const { cmdCheckin } = await import("../src/handlers/commands/checkin.js");
const { handleCallback } = await import("../src/handlers/callback.js");
const { handleModPoints } = await import("../src/admin/user-points.js");
const { cmdBan, cmdUnban } = await import("../src/handlers/commands/ban.js");
const { isCodeExpired } = await import("../src/services/redeem.js");
const { parseMaxDaily, parseRateLimit } = await import("../src/services/users.js");
const { DEFAULTS } = await import("../src/config/constants.js");

const makeEnv = (db, extra = {}) => ({
  DB: db,
  AI: { run: async () => ({ response: "AI 回复" }) },
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

const textCalls = () => apiCalls.filter((c) => c.body?.text).map((c) => String(c.body.text));
const resetCalls = () => { apiCalls.length = 0; };

// ---------- 1. 引导会话过期 ----------

test("过期 30 分钟的商品添加会话不再拦截消息", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  resetCalls();

  // 2 小时前的旧会话（模拟管理员点开后走开）
  db.exec(`INSERT INTO shop_add_sessions (chat_id, step, name, price, stock, category, icon, description, updated_at)
           VALUES ('1', 1, '', 0, -1, 'virtual', '', '', datetime('now', '-2 hours'))`);

  assert.equal(await handleAddItemInput({ env, token: "T", chatId: "1", userText: "随便说点什么" }), false);
  assert.equal(textCalls().length, 0, "过期会话不应该消耗这条消息");

  // 重新开始（新会话）后应当正常拦截
  db.exec(`UPDATE shop_add_sessions SET updated_at = CURRENT_TIMESTAMP WHERE chat_id = '1'`);
  assert.equal(await handleAddItemInput({ env, token: "T", chatId: "1", userText: "新商品" }), true);
  assert.ok(textCalls().some((t) => t.includes("价格")));
  db.close();
});

test("过期 30 分钟的商品编辑会话不再拦截消息", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const itemId = seedItem(db, { name: "测试商品", price: 10, stock: 5 });
  resetCalls();

  db.exec(`INSERT INTO shop_edit_sessions (chat_id, item_id, field, updated_at)
           VALUES ('1', ${itemId}, 'name', datetime('now', '-2 hours'))`);

  assert.equal(await handleEditItemInput({ env, token: "T", chatId: "1", userText: "新名字" }), false);
  assert.equal(db.get("SELECT name FROM shop_items WHERE id = ?", itemId).name, "测试商品", "过期会话不应改库");

  db.exec(`UPDATE shop_edit_sessions SET updated_at = CURRENT_TIMESTAMP WHERE chat_id = '1'`);
  assert.equal(await handleEditItemInput({ env, token: "T", chatId: "1", userText: "新名字" }), true);
  assert.equal(db.get("SELECT name FROM shop_items WHERE id = ?", itemId).name, "新名字");
  db.close();
});

// ---------- 2. 群聊自动删除不能阻塞请求 ----------

test("群聊指令把自动删除放进 waitUntil，不同步等待 5 秒", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 100);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const started = Date.now();
  await handleMessage({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "-100", userId: "1", chatType: "supergroup",
      userKey: "user:1", sceneKey: "group:-100:user:1",
      username: "tester", firstName: "测试用户"
    },
    isGroupCtx: true,
    payload: { message: { text: "/help", entities: [] } }
  });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `群聊指令耗时 ${elapsed}ms，说明又变成了同步等待自动删除`);
  assert.ok(ctx.pending.length >= 1, "自动删除任务应注册到 waitUntil");

  // 等后台任务结束，避免测试进程挂着定时器
  await Promise.all(ctx.pending);
  db.close();
});

// ---------- 3. 签到失败回滚 ----------

test("签到加分失败时回滚签到记录（不会出现「签了但没分」）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  // 故意不建 users 记录：模拟数据异常（正常流程里 upsertUserInfo 会先建好）
  await cmdCheckin({
    env, ctx, token: "T", chatId: "1",
    userKey: "user:404", isGroupCtx: false, uctx: { sceneKey: "private:1" }
  });

  assert.equal(db.count("daily_checkin", "user_key = 'user:404'"), 0, "签到记录应被回滚");
  assert.ok(textCalls().some((t) => t.includes("签到失败")));
  db.close();
});

// ---------- 4. 边界判断 ----------

test("限额 / 冷却解析容忍脏数据", () => {
  assert.equal(parseMaxDaily(null), DEFAULTS.MAX_DAILY);
  assert.equal(parseMaxDaily("abc"), DEFAULTS.MAX_DAILY);
  assert.equal(parseMaxDaily(-1), -1);
  assert.equal(parseMaxDaily("0"), 0);
  assert.equal(parseMaxDaily(12.9), 12);
  assert.equal(parseMaxDaily(-5), 0, "负数（除 -1）应夹到 0，不能变成负额度");

  assert.equal(parseRateLimit(null), DEFAULTS.RATE_LIMIT_SEC);
  assert.equal(parseRateLimit("x"), DEFAULTS.RATE_LIMIT_SEC);
  assert.equal(parseRateLimit(0), 0);
  assert.equal(parseRateLimit(3.7), 3);
  assert.equal(parseRateLimit(-2), 0);
});

test("兑换码过期判断：当天仍可用，昨天已过期", () => {
  const today = "2026-09-12";
  assert.equal(isCodeExpired(null, today), false, "永久有效");
  assert.equal(isCodeExpired("", today), false);
  assert.equal(isCodeExpired(today, today), false);
  assert.equal(isCodeExpired("2026-09-12", today), false);
  assert.equal(isCodeExpired("2026-09-11", today), true);
  assert.equal(isCodeExpired("2026-09-13", today), false);
});

// ---------- 6. 管理员调整积分：原子夹断 ----------

test("管理员加积分会被夹断在 0 ~ 1000000 之间并写流水", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:1", 999999);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
           VALUES ('private:1', 'user:1', '1', 'private', '1', '测试用户')`);
  const env = makeEnv(db);
  resetCalls();

  await handleModPoints({
    env, token: "T", chatId: "1", msgId: 5,
    callback: { id: "cb", message: { chat: { id: 1 } } },
    data: "admin_modpts_1:100",
    adminId: "999"
  });

  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 1000000, "应夹断在上限");
  const log = db.get("SELECT change_amount, balance_after FROM points_log ORDER BY id DESC LIMIT 1");
  assert.equal(log.change_amount, 1, "流水应记录实际增加了 1 分");
  assert.equal(log.balance_after, 1000000);

  // 反向：扣到底也不会变成负数
  await handleModPoints({
    env, token: "T", chatId: "1", msgId: 5,
    callback: { id: "cb", message: { chat: { id: 1 } } },
    data: "admin_modpts_1:-2000000",
    adminId: "999"
  });
  assert.equal(db.get("SELECT points FROM users WHERE user_key = 'user:1'").points, 0, "应夹断在 0");
  db.close();
});

// ---------- 7. 用户管理二级菜单 ----------

test("点击「用户管理」进入二级菜单：私聊用户 / 群组用户", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('1', ${Math.floor(Date.now() / 1000) + 600})`);

  await handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999",
    uctx: {
      chatId: "1", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:999",
      username: "admin", firstName: "管理员"
    },
    payload: {
      callback_query: {
        id: "cb2",
        from: { id: 999 },
        data: "admin_users_home",
        message: { message_id: 6, chat: { id: 1, type: "private" } }
      }
    }
  });

  const edited = apiCalls.filter((c) => c.method === "editMessageText").at(-1);
  assert.ok(edited, "应该编辑出二级菜单");
  const keyboard = edited.body.reply_markup?.inline_keyboard || [];
  assert.deepEqual(
    keyboard[0].map((b) => b.callback_data),
    ["admin_users_private_1", "admin_users_group_1"]
  );
  assert.ok(String(edited.body.text).includes("用户管理"));

  await Promise.all(ctx.pending);
  db.close();
});

// ---------- 8. 封禁名单 ----------

test("/ban 建档并封禁，/unban 解封，重复解封会提示", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  // 封禁一个从没说过话的用户：应自动建档，且积分保持 0
  await cmdBan({
    env, ctx, token: "T", chatId: "1", isGroupCtx: false,
    rawText: "/ban 123456 广告刷屏", myId: "999"
  });
  const row = db.get("SELECT * FROM users WHERE user_key = 'user:123456'");
  assert.ok(row, "应自动创建用户档案");
  assert.equal(row.blocked, 1);
  assert.equal(row.points, 0, "封禁建档不应白送初始积分");
  assert.ok(textCalls().some((t) => t.includes("已加入封禁名单")));
  assert.equal(db.get("SELECT action FROM admin_logs ORDER BY id DESC LIMIT 1").action, "user_block");

  // 已在名单里时再解封
  resetCalls();
  await cmdUnban({ env, ctx, token: "T", chatId: "1", isGroupCtx: false, rawText: "/unban 123456", myId: "999" });
  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:123456'").blocked, 0);
  assert.ok(textCalls().some((t) => t.includes("已解封")));

  // 再解封一次应提示不在名单里
  resetCalls();
  await cmdUnban({ env, ctx, token: "T", chatId: "1", isGroupCtx: false, rawText: "/unban 123456", myId: "999" });
  assert.ok(textCalls().some((t) => t.includes("不在封禁名单")));

  await Promise.all(ctx.pending);
  db.close();
});

test("/ban 参数校验：非法 ID 与封禁自己都会被拒绝", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  await cmdBan({ env, ctx, token: "T", chatId: "1", isGroupCtx: false, rawText: "/ban abc", myId: "999" });
  assert.ok(textCalls().some((t) => t.includes("纯数字")));

  resetCalls();
  await cmdBan({ env, ctx, token: "T", chatId: "1", isGroupCtx: false, rawText: "/ban 999", myId: "999" });
  assert.ok(textCalls().some((t) => t.includes("不能封禁管理员自己")));
  assert.equal(db.count("users", "user_key = 'user:999'"), 0, "不应给自己建档");

  await Promise.all(ctx.pending);
  db.close();
});

test("封禁名单面板：列表显示被封禁用户，点按钮立即解封", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:555", 30);
  db.exec("UPDATE users SET blocked = 1, first_name = '捣乱的人' WHERE user_key = 'user:555'");
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const adminCtx = {
    chatId: "1", userId: "999", chatType: "private",
    userKey: "user:999", sceneKey: "private:999",
    username: "admin", firstName: "管理员"
  };
  const call = (data) => handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminCtx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data,
        message: { message_id: 7, chat: { id: 1, type: "private" } }
      }
    }
  });

  await call("admin_banned_1");
  const listText = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(listText.includes("捣乱的人"), "列表应显示被封禁用户");
  const unbanBtn = apiCalls.filter((c) => c.method === "editMessageText").at(-1)
    .body.reply_markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith("admin_unban_"));
  assert.ok(unbanBtn, "应有解封按钮");

  await call(unbanBtn.callback_data);
  assert.equal(db.get("SELECT blocked FROM users WHERE user_key = 'user:555'").blocked, 0);

  await Promise.all(ctx.pending);
  db.close();
});

// ---------- 9. 群组用户两级浏览 ----------

test("群组用户：先看群列表，再看群成员", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  seedUser(db, "user:111", 50);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
           VALUES ('group:-100:user:111', 'user:111', '-100', 'supergroup', '111', '群成员甲')`);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
           VALUES ('group:-200:user:999', 'user:999', '-200', 'supergroup', '999', '管理员')`);
  const env = makeEnv(db);
  const ctx = makeCtx();
  resetCalls();

  const adminCtx = {
    chatId: "1", userId: "999", chatType: "private",
    userKey: "user:999", sceneKey: "private:999"
  };
  const call = (data) => handleCallback({
    env, ctx, token: "TEST_TOKEN", myId: "999", uctx: adminCtx,
    payload: {
      callback_query: {
        id: "cb", from: { id: 999 }, data,
        message: { message_id: 8, chat: { id: 1, type: "private" } }
      }
    }
  });

  await call("admin_groups_1");
  const groupKb = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.reply_markup.inline_keyboard;
  const groupButtons = groupKb.flat().filter((b) => b.callback_data.startsWith("admin_group_m_"));
  assert.equal(groupButtons.length, 2, "应列出两个群");

  const target = groupButtons.find((b) => b.callback_data.includes("-100"));
  await call(target.callback_data);
  const memberText = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.text;
  assert.ok(memberText.includes("群成员甲"), "群成员列表应包含该群成员");
  assert.ok(!memberText.includes("管理员"), "不应混入其他群的成员");

  await Promise.all(ctx.pending);
  db.close();
});
