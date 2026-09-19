// ==========================================
// 🛡️ 机器人管理员保护（不可被封禁 / 不可被处置）
//
// 背景（v3.7.0 修的真实越权）：三处硬性兜底原先**只认 owner**（`MY_TELEGRAM_ID`），
// 于是任意用户自己建个群把机器人拉进去（他天然是本群管理员，`groupAdmin` 放行），
// 就能用 `/ban <某 admin 的 user_id> 广告` → 确认 → 把那个 admin 写进**全局**
// `users.blocked`。之后该 admin 的私聊与按钮全被拦，连 `/unban` 都发不出去，
// 只能由 owner 手动解封。
//
// 这里覆盖修复后的三条防线：`isBotAdmin` 判定、`banUserById`、`setUserBlocked`、
// 以及 `executePunishment`（处置执行的最终兜底）。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { isBotAdmin, getAdminRole, setAdmin, clearAdminCache } from "../src/services/admins.js";
import { setUserBlocked, banUserById, isUserBlocked } from "../src/services/users.js";
import { buildUserKey } from "../src/core/context.js";
import { executePunishment } from "../src/services/guard.js";

const OWNER = "999";
const ADMIN = "111";
const MOD = "222";
const NORMAL = "333";

const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: OWNER, APP_TIMEZONE: "Asia/Shanghai" });

/** 造一个「owner + 一个 admin + 一个 moderator + 一个普通用户」的库 */
function seedRoles(db) {
  for (const id of [OWNER, ADMIN, MOD, NORMAL]) seedUser(db, `user:${id}`, 100);
  db.exec(`INSERT INTO bot_admins (user_id, role) VALUES ('${ADMIN}', 'admin')`);
  db.exec(`INSERT INTO bot_admins (user_id, role) VALUES ('${MOD}', 'moderator')`);
  clearAdminCache();
}

test("isBotAdmin：owner / admin / moderator 都算机器人管理员，普通用户不算", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);

  assert.equal(await getAdminRole(env, OWNER), "owner");
  assert.equal(await getAdminRole(env, ADMIN), "admin");
  assert.equal(await getAdminRole(env, MOD), "moderator");
  assert.equal(await getAdminRole(env, NORMAL), null);

  assert.equal(await isBotAdmin(env, OWNER), true);
  assert.equal(await isBotAdmin(env, ADMIN), true);
  assert.equal(await isBotAdmin(env, MOD), true);
  assert.equal(await isBotAdmin(env, NORMAL), false);
  assert.equal(await isBotAdmin(env, ""), false, "空值不能算管理员");
  db.close();
});

test("banUserById：封不了 admin / moderator（原先只拦 owner）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);

  for (const id of [ADMIN, MOD, OWNER]) {
    const res = await banUserById(env, id, { createdBy: NORMAL });
    assert.equal(res.ok, false, `不该能封禁 ${id}`);
    assert.match(res.error, /机器人管理员/);
    assert.equal(await isUserBlocked(env, buildUserKey(id)), false, `${id} 不能被写进封禁名单`);
  }

  // 普通用户照旧可以封
  const ok = await banUserById(env, NORMAL, { createdBy: ADMIN });
  assert.equal(ok.ok, true);
  assert.equal(await isUserBlocked(env, buildUserKey(NORMAL)), true);
  db.close();
});

test("setUserBlocked：对机器人管理员直接返回 false 且不写库", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);

  assert.equal(await setUserBlocked(env, buildUserKey(ADMIN), true), false);
  assert.equal(await isUserBlocked(env, buildUserKey(ADMIN)), false);

  assert.equal(await setUserBlocked(env, buildUserKey(NORMAL), true), true);
  assert.equal(await isUserBlocked(env, buildUserKey(NORMAL)), true);
  db.close();
});

test("executePunishment：处置机器人的记录一定被拒（即使卡片是旧的）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);

  // 模拟「本群管理员给自己群里的某个 admin 开了处置单」——记录已经写进 pending
  const record = {
    id: 1, chat_id: "-100123", user_id: ADMIN, action: "bot_ban",
    duration_min: 0, status: "pending", reason: "广告"
  };

  const res = await executePunishment({ env, token: "T", record, action: "bot_ban", durationMin: 0 });

  assert.equal(res.ok, false);
  assert.match(res.error, /不能处置机器人管理员/);
  assert.equal(await isUserBlocked(env, buildUserKey(ADMIN)), false, "全局封禁名单不能被写入");
  db.close();
});

test("executePunishment：普通成员的 bot_ban 照常执行（别把防线修过头）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);

  const record = {
    id: 2, chat_id: "-100123", user_id: NORMAL, action: "bot_ban",
    duration_min: 0, status: "pending", reason: "广告"
  };

  const res = await executePunishment({ env, token: "T", record, action: "bot_ban", durationMin: 0 });

  assert.equal(res.ok, true);
  assert.equal(await isUserBlocked(env, buildUserKey(NORMAL)), true);
  db.close();
});

test("setAdmin 授了角色之后，保护立刻生效（不吃 60 秒角色缓存）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedRoles(db);
  const env = makeEnv(db);
  const newcomer = "444";
  seedUser(db, `user:${newcomer}`, 100);

  assert.equal(await isBotAdmin(env, newcomer), false);
  await setAdmin(env, newcomer, "moderator", { by: OWNER });
  assert.equal(await isBotAdmin(env, newcomer), true, "刚授权就该受保护");

  const res = await banUserById(env, newcomer, { createdBy: ADMIN });
  assert.equal(res.ok, false);
  db.close();
});
