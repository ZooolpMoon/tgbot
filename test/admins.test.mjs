// ==========================================
// 👑 管理员与角色权限（v3.0.0）
//
// 覆盖：角色解析与缓存、能力矩阵、命令分发拦截、回调能力拦截、
//       引导式添加管理员、主菜单与 /help 按角色裁剪。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import {
  can, clearAdminCache, getAdminRole, isBackstageRole, listAdmins,
  removeAdmin, setAdmin
} from "../src/services/admins.js";
import { dispatchCommand, buildHelpText } from "../src/handlers/commands/registry.js";
import { getAdminMainKeyboard } from "../src/admin/menus.js";

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

const { handleCallback } = await import("../src/handlers/callback.js");

const uctxOf = (userId, chatType = "private") => ({
  chatId: chatType === "private" ? userId : "-100",
  userId,
  chatType,
  userKey: `user:${userId}`,
  sceneKey: chatType === "private" ? `private:${userId}` : `group:-100:user:${userId}`,
  username: `u${userId}`,
  firstName: `用户${userId}`
});

const click = (env, ctx, uctx, data, chatType = "private", myId = "999") => handleCallback({
  env, ctx, token: "T", myId, uctx,
  payload: {
    callback_query: {
      id: `cb_${data}`, from: { id: Number(uctx.userId) }, data,
      message: { message_id: 10, chat: { id: uctx.chatId, type: chatType } }
    }
  }
});

// ==========================================
// 1. 角色解析与能力矩阵
// ==========================================

test("角色解析：拥有者来自环境变量，其余来自 bot_admins 表", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  assert.equal(await getAdminRole(env, "999"), "owner", "MY_TELEGRAM_ID 即拥有者");
  assert.equal(await getAdminRole(env, "888"), null, "不在名单里就是普通用户");

  await setAdmin(env, "888", "admin", { by: "999", note: "副管理员" });
  assert.equal(await getAdminRole(env, "888"), "admin");

  await setAdmin(env, "777", "moderator", { by: "999" });
  assert.equal(await getAdminRole(env, "777"), "moderator");

  // 角色缓存：改角色后要立刻生效（服务层会主动清缓存）
  await setAdmin(env, "888", "moderator", { by: "999" });
  assert.equal(await getAdminRole(env, "888"), "moderator");

  await removeAdmin(env, "888");
  assert.equal(await getAdminRole(env, "888"), null);
  db.close();
});

test("能力矩阵：拥有者全权，管理员不能管权限，执法员只能执法", () => {
  assert.equal(can("owner", "manage_admins"), true);
  assert.equal(can("owner", "enforce"), true);

  assert.equal(can("admin", "manage_users"), true);
  assert.equal(can("admin", "manage_shop"), true);
  assert.equal(can("admin", "enforce"), true);
  assert.equal(can("admin", "manage_admins"), false, "管理员不能自己加管理员");

  assert.equal(can("moderator", "enforce"), true);
  assert.equal(can("moderator", "manage_users"), false);
  assert.equal(can("moderator", "manage_kb"), false);
  assert.equal(can("moderator", "manage_admins"), false);

  assert.equal(can(null, "enforce"), false);
  assert.equal(isBackstageRole("moderator"), false, "执法员不进后台");
  assert.equal(isBackstageRole("admin"), true);
});

test("setAdmin / removeAdmin：校验 ID、角色，且动不了拥有者", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  assert.equal((await setAdmin(env, "abc", "admin")).ok, false, "必须纯数字 ID");
  assert.equal((await setAdmin(env, "888", "owner")).ok, false, "不能把别人设成拥有者");
  assert.equal((await setAdmin(env, "999", "admin")).ok, false, "拥有者不进表");
  assert.equal((await removeAdmin(env, "999")).ok, false, "拥有者移不掉");
  assert.equal((await removeAdmin(env, "888")).ok, false, "不在名单里");

  const created = await setAdmin(env, "888", "admin", { by: "999", note: "测试" });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  const again = await setAdmin(env, "888", "admin", { by: "999" });
  assert.equal(again.created, false, "重复添加算更新");
  assert.equal((await listAdmins(env)).length, 1);
  db.close();
});

// ==========================================
// 2. 命令分发拦截
// ==========================================

const dispatchCtx = (env, { role, userId = "888", isGroupCtx = false, chatId = "888" }) => ({
  env, ctx: { waitUntil: (p) => p }, token: "T", chatId,
  userKey: `user:${userId}`, sceneKey: isGroupCtx ? `group:-100:user:${userId}` : `private:${userId}`,
  isGroupCtx, isMaster: role === "owner", role,
  uctx: uctxOf(userId, isGroupCtx ? "supergroup" : "private")
});

test("命令分发：执法员只能执法，管理员不能用权限管理", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:777", 0);
  seedUser(db, "user:888", 0);
  const env = makeEnv(db);
  await setAdmin(env, "888", "admin", { by: "999" });
  await setAdmin(env, "777", "moderator", { by: "999" });
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('888', ${Math.floor(Date.now() / 1000) + 600})`);
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('-100', ${Math.floor(Date.now() / 1000) + 600})`);

  // 执法员：能用执法指令，进不了后台
  resetCalls();
  assert.equal(await dispatchCommand("/mute", dispatchCtx(env, { role: "moderator", userId: "777", isGroupCtx: true, chatId: "-100" })), true);
  assert.ok(textsOf("sendMessage").some((t) => t.includes("用法") || t.includes("群内禁言")), "执法员应能拿到用法提示");

  resetCalls();
  await dispatchCommand("/users", dispatchCtx(env, { role: "moderator", userId: "777" }));
  assert.ok(textsOf("sendMessage").some((t) => t.includes("权限不足")), "执法员不能用用户管理");

  resetCalls();
  await dispatchCommand("/admin", dispatchCtx(env, { role: "moderator", userId: "777" }));
  assert.ok(textsOf("sendMessage").some((t) => t.includes("权限不足")), "执法员打不开管理控制台");

  // 管理员：能进后台，但不能用 /admins
  resetCalls();
  await dispatchCommand("/users", dispatchCtx(env, { role: "admin", userId: "888" }));
  assert.ok(!textsOf("sendMessage").some((t) => t.includes("权限不足")), "管理员应能用用户管理");

  resetCalls();
  await dispatchCommand("/admins", dispatchCtx(env, { role: "admin", userId: "888" }));
  assert.ok(textsOf("sendMessage").some((t) => t.includes("权限不足")), "管理员不能用权限管理");

  // 拥有者：权限管理可用
  resetCalls();
  await dispatchCommand("/admins", dispatchCtx(env, { role: "owner", userId: "999", chatId: "999" }));
  assert.ok(!textsOf("sendMessage").some((t) => t.includes("权限不足")), "拥有者应能打开权限管理");
  db.close();
});

test("命令分发：普通用户用管理指令一律拒绝", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  resetCalls();

  await dispatchCommand("/stats", dispatchCtx(env, { role: null, userId: "555" }));
  assert.ok(textsOf("sendMessage").some((t) => t.includes("权限不足")));
  db.close();
});

// ==========================================
// 3. 回调能力拦截
// ==========================================

test("回调拦截：只有拥有者能进权限管理，执法员进不了任何后台面板", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:888", 0);
  seedUser(db, "user:777", 0);
  const env = makeEnv(db);
  const ctx = { waitUntil: (p) => p };
  await setAdmin(env, "888", "admin", { by: "999" });
  await setAdmin(env, "777", "moderator", { by: "999" });

  // 管理员点权限管理 → 拒绝
  resetCalls();
  await click(env, ctx, uctxOf("888"), "admin_admins");
  assert.ok(
    apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("权限不足")),
    "管理员不该能进权限管理"
  );

  // 拥有者点权限管理 → 打开面板
  resetCalls();
  await click(env, ctx, uctxOf("999"), "admin_admins");
  assert.ok(textsOf("editMessageText").some((t) => t.includes("管理员与权限")));

  // 执法员点功能开关 → 拒绝
  resetCalls();
  await click(env, ctx, uctxOf("777"), "admin_feat_home");
  assert.ok(apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text).includes("权限不足")));
  db.close();
});

// ==========================================
// 4. 引导式添加管理员
// ==========================================

test("引导式添加管理员：输入 ID → 选角色 → 备注", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = { waitUntil: (p) => p };
  const owner = uctxOf("999");
  const { handleMessage } = await import("../src/handlers/message.js");

  // 打开面板 → 添加
  await click(env, ctx, owner, "admin_admins");
  resetCalls();
  await click(env, ctx, owner, "admin_admins_add");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("第 1 步")));
  assert.equal(db.get("SELECT step FROM admin_manage_sessions WHERE chat_id = '999'").step, "add:user");

  // 输入 ID
  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: owner, isGroupCtx: false,
    payload: { message: { text: "666666", entities: [] } }
  });
  assert.equal(db.get("SELECT step FROM admin_manage_sessions WHERE chat_id = '999'").step, "add:role");

  // 选角色（执法员）
  await click(env, ctx, owner, "admin_admins_gr_moderator");
  assert.equal(db.get("SELECT step FROM admin_manage_sessions WHERE chat_id = '999'").step, "add:note");

  // 填备注 → 落库
  resetCalls();
  await handleMessage({
    env, ctx, token: "T", myId: "999", uctx: owner, isGroupCtx: false,
    payload: { message: { text: "值班小号", entities: [] } }
  });
  const row = db.get("SELECT * FROM bot_admins WHERE user_id = '666666'");
  assert.equal(row.role, "moderator");
  assert.equal(row.note, "值班小号");
  assert.equal(row.granted_by, "999");
  assert.equal(db.count("admin_manage_sessions"), 0, "完成后应清掉引导会话");
  assert.equal(db.get("SELECT action FROM admin_logs ORDER BY id DESC LIMIT 1").action, "admin_add");
  db.close();
});

test("引导式添加：非数字 ID 会提示重发，拥有者自己的 ID 会被挡下", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:999", 0);
  const env = makeEnv(db);
  const ctx = { waitUntil: (p) => p };
  const owner = uctxOf("999");
  const { handleMessage } = await import("../src/handlers/message.js");
  const say = (text) => handleMessage({
    env, ctx, token: "T", myId: "999", uctx: owner, isGroupCtx: false,
    payload: { message: { text, entities: [] } }
  });

  await click(env, ctx, owner, "admin_admins_add");
  resetCalls();
  await say("@someone");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("纯数字")));
  assert.equal(db.get("SELECT step FROM admin_manage_sessions WHERE chat_id = '999'").step, "add:user");

  resetCalls();
  await say("999");
  assert.ok(textsOf("sendMessage").some((t) => t.includes("拥有者")));
  assert.equal(db.count("bot_admins"), 0);
  db.close();
});

test("移除管理员：先二次确认，确认后生效", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, "user:888", 0);
  const env = makeEnv(db);
  const ctx = { waitUntil: (p) => p };
  await setAdmin(env, "888", "admin", { by: "999", note: "副管理员" });

  resetCalls();
  await click(env, ctx, uctxOf("999"), "admin_admins_d_888");
  assert.equal((await listAdmins(env)).length, 1, "第一次点击只是确认");
  assert.ok(textsOf("editMessageText").some((t) => t.includes("确认移除管理员")));

  resetCalls();
  await click(env, ctx, uctxOf("999"), "admin_admins_dok_888");
  assert.equal((await listAdmins(env)).length, 0);
  assert.equal(db.get("SELECT action FROM admin_logs ORDER BY id DESC LIMIT 1").action, "admin_remove");
  db.close();
});

// ==========================================
// 5. 菜单与帮助按角色裁剪
// ==========================================

test("主菜单：只有拥有者能看到「管理员与权限」", () => {
  const owner = getAdminMainKeyboard(true, "owner").inline_keyboard.flat().map((b) => b.callback_data);
  const admin = getAdminMainKeyboard(true, "admin").inline_keyboard.flat().map((b) => b.callback_data);

  assert.ok(owner.includes("admin_admins"), "拥有者应有权限管理入口");
  assert.ok(!admin.includes("admin_admins"), "管理员不该有权限管理入口");
  assert.ok(admin.includes("admin_users_home"), "管理员仍能管理用户");
});

test("/help 按角色裁剪：执法员只看到执法指令", () => {
  const moderator = buildHelpText({ isGroupCtx: true, role: "moderator" });
  assert.match(moderator, /\/mute/, "执法员应看到执法指令");
  assert.doesNotMatch(moderator, /\/users/, "执法员不该看到用户管理");
  assert.doesNotMatch(moderator, /\/admins/, "执法员不该看到权限管理");

  const admin = buildHelpText({ isGroupCtx: false, role: "admin" });
  assert.match(admin, /\/users/);
  assert.doesNotMatch(admin, /\/admins/, "管理员不该看到权限管理");

  const owner = buildHelpText({ isGroupCtx: false, role: "owner" });
  assert.match(owner, /\/admins/, "拥有者应看到权限管理");
});
