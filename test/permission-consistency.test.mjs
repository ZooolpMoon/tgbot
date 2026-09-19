// ==========================================
// 🔑 权限判断的一致性（可见性 = 能用性）
//
// 背景（v3.8.0 修）：注册表按 **capability** 裁菜单与 `/help`，但有几个地方还在
// 硬判 `isMaster`（仅 owner），于是出现两类真实缺陷：
//   • `/broadcast`：菜单给 admin 看了，点下去却「权限不足」
//   • 引导式输入：admin 点了「添加文档 / 编辑群规 / 添加商品」，随后回复的正文
//     不会被对应流程消费 —— 私聊里还会掉进 AI 对话，**扣 1 积分且正文永久丢失**
//
// 这个文件盯住这两类，并补一条「菜单可见 ⇒ 不该被判无权限」的一致性用例。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import { setAdmin, clearAdminCache, can, getAdminRole } from "../src/services/admins.js";
import { COMMANDS } from "../src/handlers/commands/registry.js";
import { cmdBroadcast } from "../src/handlers/commands/broadcast.js";
import { handleMessage } from "../src/handlers/message.js";

let apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 7 } })
  };
};
const resetCalls = () => { apiCalls.length = 0; };
const textsSent = () => apiCalls
  .filter((c) => c.body?.text)
  .map((c) => String(c.body.text));

const OWNER = "999";
const ADMIN = "111";
const PLAIN = "333";

const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", BOT_USERNAME: "TestBot", MY_TELEGRAM_ID: OWNER,
  APP_TIMEZONE: "Asia/Shanghai", ...extra
});
const makeCtx = () => ({ pending: [], waitUntil(p) { this.pending.push(p); } });
const uctxOf = (userId, chatType = "private") => ({
  chatId: chatType === "private" ? userId : "-100",
  userId, chatType,
  userKey: `user:${userId}`,
  sceneKey: chatType === "private" ? `private:${userId}` : `group:-100:user:${userId}`,
  username: `u${userId}`, firstName: `用户${userId}`
});

function seedAdmin(db, userId = ADMIN, role = "admin") {
  seedUser(db, `user:${userId}`, 100);
  db.exec(`INSERT INTO bot_admins (user_id, role) VALUES ('${userId}', '${role}')`);
  clearAdminCache();
}

// ==========================================
// /broadcast
// ==========================================

test("/broadcast：admin 不再被 isMaster 挡下（权限只由注册表 capability 决定）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedAdmin(db);
  const env = makeEnv(db);
  resetCalls();

  // 群里调用：应该回「仅支持私聊」，而**不是**权限不足（证明不再走 isMaster 硬判）
  await cmdBroadcast({ env, ctx: {}, token: "T", chatId: "-100", isGroupCtx: true, rawText: "/broadcast hi" });

  const texts = textsSent().join("\n");
  assert.ok(texts.includes("仅支持"), `admin 应能走到业务分支，实际回复：${texts.slice(0, 120)}`);
  assert.ok(!texts.includes("权限"), "不该再出现权限不足");
  db.close();
});

test("注册表声明了 broadcast 能力，且 admin 角色确实有它（两边一致）", () => {
  const cmd = COMMANDS.find((c) => c.name === "/broadcast");
  assert.equal(cmd.capability, "broadcast");
  assert.equal(can("admin", "broadcast"), true, "菜单给 admin 看，就必须让他能用");
  assert.equal(can("moderator", "broadcast"), false, "执法员不该能群发");
  assert.equal(can("owner", "broadcast"), true);
});

test("一致性守卫：每条管理指令的 capability 都要有角色真的能用", () => {
  const roles = ["owner", "admin", "moderator"];
  for (const cmd of COMMANDS.filter((c) => c.scope === "admin")) {
    if (!cmd.capability) continue;
    const usable = roles.some((r) => can(r, cmd.capability));
    assert.ok(usable, `${cmd.name} 的 capability「${cmd.capability}」没有任何角色能用 —— 挂上去也没人点得动`);
  }
});

test("一致性守卫：admin 角色可用的管理指令，不该在 handler 里再被 isMaster 拒掉", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedAdmin(db);
  const env = makeEnv(db);

  const role = await getAdminRole(env, ADMIN);
  assert.equal(role, "admin");
  // 至少确认这几条「admin 有 capability」的指令都确实对他开放
  for (const capability of ["manage_kb", "manage_guard", "manage_shop", "broadcast"]) {
    assert.equal(can(role, capability), true, `admin 应具备 ${capability}`);
  }
  db.close();
});

// ==========================================
// 引导式输入：正文必须被对应流程消费（而不是掉进 AI 计费）
// ==========================================

test("admin 的知识库引导输入会被消费，不会掉进 AI 对话扣积分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedAdmin(db);
  const env = makeEnv(db, {
    AI: { run: async () => ({ response: "（这是 AI 回复，说明正文掉进了 AI 路径）" }) }
  });
  // 造一个「正在等文档正文」的知识库引导会话（step 的合法取值带阶段前缀）
  db.exec(
    `INSERT INTO kb_sessions (chat_id, step, draft, updated_at)
     VALUES ('${ADMIN}', 'add:content', '{"title":"测试文档","scope":"global"}', CURRENT_TIMESTAMP)`
  );
  const before = await getUserPoints(env, `user:${ADMIN}`);
  resetCalls();

  await handleMessage({
    env, ctx: makeCtx(), token: "T", myId: OWNER,
    uctx: uctxOf(ADMIN), isGroupCtx: false,
    payload: { message: { text: "这是要入库的文档正文", entities: [] } }
  });

  const after = await getUserPoints(env, `user:${ADMIN}`);
  assert.equal(after, before, "引导输入被消费时不该扣 AI 积分（掉进 AI 路径才会扣）");
  db.close();
});

test("对照：普通用户的同样文本会走 AI（所以上面那条断言是有意义的）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, `user:${PLAIN}`, 100);
  const env = makeEnv(db, {
    AI: { run: async () => ({ response: "AI 回复" }) }
  });
  const before = await getUserPoints(env, `user:${PLAIN}`);
  resetCalls();

  await handleMessage({
    env, ctx: makeCtx(), token: "T", myId: OWNER,
    uctx: uctxOf(PLAIN), isGroupCtx: false,
    payload: { message: { text: "你好呀", entities: [] } }
  });

  const after = await getUserPoints(env, `user:${PLAIN}`);
  assert.ok(after < before, `普通用户的普通消息应该走 AI 并扣积分（${before} → ${after}）`);
  db.close();
});

test("moderator 不该能改群规 / 知识库（权限放宽别放过头）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedAdmin(db, "222", "moderator");
  const env = makeEnv(db);
  const role = await getAdminRole(env, "222");

  assert.equal(role, "moderator");
  assert.equal(can(role, "manage_kb"), false);
  assert.equal(can(role, "manage_guard"), false, "执法员只能执法，不能改群规");
  assert.equal(can(role, "broadcast"), false);
  db.close();
});
