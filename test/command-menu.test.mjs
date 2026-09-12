// ==========================================
// ⌨️ 输入框命令菜单测试
//
// 覆盖：由注册表生成菜单（私聊 / 群聊 / 管理员三套）、名称与描述合法、
//       哈希版本比对（内容没变不调接口）、force 强制同步、isolate 内只检查一次。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  buildCommandMenu, menuHash, syncCommandMenu, syncCommandMenuOnce, resetCommandMenuCache
} from "../src/services/command-menu.js";
import { COMMANDS } from "../src/handlers/commands/registry.js";
import { getSetting } from "../src/services/settings.js";
import { removeAdmin, setAdmin } from "../src/services/admins.js";

const apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  apiCalls.push({ method, body: opts.body ? JSON.parse(opts.body) : {} });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: true })
  };
};

const resetCalls = () => { apiCalls.length = 0; };
const callsOf = (method) => apiCalls.filter((c) => c.method === method);

const makeEnv = (db, extra = {}) => ({
  DB: db,
  BOT_TOKEN: "TEST_TOKEN",
  MY_TELEGRAM_ID: "999",
  ...extra
});

test("buildCommandMenu：私聊只给普通命令，群聊再去掉「仅私聊」命令", () => {
  const pub = buildCommandMenu({ includeAdmin: false, inGroup: false });
  const grp = buildCommandMenu({ includeAdmin: false, inGroup: true });
  const adm = buildCommandMenu({ includeAdmin: true, inGroup: false });

  const names = (list) => list.map((c) => c.command);
  assert.ok(names(pub).includes("help"));
  assert.ok(!names(pub).includes("ban"), "普通用户菜单里不应有管理命令");
  assert.ok(names(adm).includes("ban"), "管理员菜单里应有管理命令");
  assert.ok(names(pub).includes("shop"));
  assert.ok(!names(grp).includes("shop"), "群聊菜单里不应有「仅私聊」命令");
  assert.ok(names(grp).includes("report"), "群聊菜单里应有「仅群聊」命令");
  assert.ok(!names(pub).includes("report"), "私聊菜单里不应有「仅群聊」命令");
  assert.ok(!names(adm).includes("report"), "私聊（含管理员）菜单里也不应有仅群聊命令");
  assert.ok(names(grp).includes("game"));

  // Telegram 对命令名与描述的限制
  for (const item of adm) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(item.description.length >= 3 && item.description.length <= 60, item.description);
    assert.ok(!item.description.includes("\n"));
  }
  assert.ok(adm.length <= 100);
});

test("menuHash：内容变了哈希就变", () => {
  const a = menuHash([[{ command: "help", description: "帮助" }]]);
  const b = menuHash([[{ command: "help", description: "帮助" }, { command: "new", description: "新命令" }]]);
  const c = menuHash([[{ command: "help", description: "帮助" }]]);
  assert.notEqual(a, b);
  assert.equal(a, c);
});

test("buildCommandMenu：管理指令按角色 capability 裁，本群管理员只拿执法指令", () => {
  const names = (list) => list.map((c) => c.command);
  const admin = names(buildCommandMenu({ includeAdmin: true, inGroup: false, role: "admin" }));
  const moderator = names(buildCommandMenu({ includeAdmin: true, inGroup: false, role: "moderator" }));
  const owner = names(buildCommandMenu({ includeAdmin: true, inGroup: false, role: "owner" }));

  assert.ok(admin.includes("users"), "管理员能管用户");
  assert.ok(!admin.includes("admins"), "管理员不能管权限（/admins 只给拥有者）");
  assert.ok(owner.includes("admins"), "拥有者有权限管理");
  assert.ok(moderator.includes("mute"), "执法员有执法指令");
  assert.ok(!moderator.includes("users"), "执法员没有用户管理");
  assert.ok(!moderator.includes("code_new"), "执法员没有兑换码");
  assert.ok(!moderator.includes("broadcast"), "执法员不能群发");

  const groupAdmins = names(buildCommandMenu({ includeAdmin: true, inGroup: true, groupAdmin: true }));
  for (const cmd of ["ban", "unban", "kick", "groupban", "mute", "unmute", "rules"]) {
    assert.ok(groupAdmins.includes(cmd), `本群管理员菜单应有 /${cmd}`);
  }
  assert.ok(!groupAdmins.includes("guard"), "/guard 面板仍只给机器人管理员");
  assert.ok(!groupAdmins.includes("users"), "本群管理员看不到用户管理");
  assert.ok(groupAdmins.includes("report"), "群里普通人可用的举报要留着");
});

test("syncCommandMenu：按多管理员模型挂作用域，移除管理员后清空他那一份", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id)
           VALUES ('group:-100:user:777', 'user:777', '-100', 'supergroup', '777')`);
  await setAdmin(env, "777", "moderator", { by: "999" });
  resetCalls();
  resetCommandMenuCache();

  const first = await syncCommandMenu(env, "TEST_TOKEN");
  assert.equal(first.synced, true);

  const calls = callsOf("setMyCommands");
  const scopeLabel = (c) => (c.body.scope
    ? (c.body.scope.chat_id ? `${c.body.scope.type}:${c.body.scope.chat_id}` : c.body.scope.type)
    : "default");
  assert.deepEqual(calls.map(scopeLabel), [
    "default", "all_group_chats", "chat:999", "chat:777", "chat_administrators:-100"
  ]);

  const menuOf = (label) =>
    new Set(calls.find((c) => scopeLabel(c) === label).body.commands.map((c) => c.command));
  assert.ok(menuOf("chat:999").has("admins"), "拥有者菜单含权限管理");
  assert.ok(menuOf("chat:777").has("mute"), "执法员菜单含执法指令");
  assert.ok(!menuOf("chat:777").has("users"), "执法员菜单不含用户管理");
  assert.ok(!menuOf("chat:777").has("code_new"), "执法员菜单不含兑换码");
  assert.ok(menuOf("chat_administrators:-100").has("ban"), "群管理员菜单含 /ban");
  assert.ok(!menuOf("chat_administrators:-100").has("guard"), "群管理员菜单不含 /guard");
  assert.ok(!menuOf("all_group_chats").has("ban"), "群里普通成员看不到执法指令");

  await removeAdmin(env, "777");
  resetCalls();
  const second = await syncCommandMenu(env, "TEST_TOKEN");
  assert.equal(second.synced, true);
  assert.equal(second.cleared, 1, "被移除的管理员那一份要清掉");
  const cleared = callsOf("setMyCommands").filter((c) => (c.body.commands || []).length === 0);
  assert.equal(cleared.length, 1);
  assert.deepEqual(cleared[0].body.scope, { type: "chat", chat_id: "777" });
  db.close();
});

test("syncCommandMenu：首次同步三套菜单并记录版本，重复调用不再调接口", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  resetCalls();
  resetCommandMenuCache();

  const first = await syncCommandMenu(env, "TEST_TOKEN");
  assert.equal(first.synced, true);
  assert.equal(callsOf("setMyCommands").length, 3, "私聊 / 群聊 / 管理员私聊 三套");
  const scopes = callsOf("setMyCommands").map((c) => c.body.scope?.type || "default");
  assert.deepEqual(scopes, ["default", "all_group_chats", "chat"]);
  assert.equal(await getSetting(env, "commands.version", ""), first.hash, "应记录版本哈希");

  // 内容没变 → 不再调用
  resetCalls();
  const second = await syncCommandMenu(env, "TEST_TOKEN");
  assert.equal(second.synced, false);
  assert.equal(callsOf("setMyCommands").length, 0);

  // force → 强制刷新
  resetCalls();
  const third = await syncCommandMenu(env, "TEST_TOKEN", { force: true });
  assert.equal(third.synced, true);
  assert.equal(callsOf("setMyCommands").length, 3);

  // 注册表里真的包含这些命令（防止菜单与实现脱节）
  const menuNames = new Set(callsOf("setMyCommands")[2].body.commands.map((c) => c.command));
  for (const cmd of COMMANDS.filter((c) => c.scope === "admin")) {
    assert.ok(menuNames.has(cmd.name.replace(/^\//, "")), `管理员菜单缺少 ${cmd.name}`);
  }
  db.close();
});

test("syncCommandMenuOnce：同一 isolate 内只检查一次", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  resetCalls();
  resetCommandMenuCache();

  const first = await syncCommandMenuOnce(env, "TEST_TOKEN");
  assert.equal(first.synced, true);
  assert.equal(callsOf("setMyCommands").length, 3);

  resetCalls();
  const second = await syncCommandMenuOnce(env, "TEST_TOKEN");
  assert.equal(second.synced, false);
  assert.equal(callsOf("setMyCommands").length, 0);

  resetCommandMenuCache();
  resetCalls();
  await syncCommandMenuOnce(env, "TEST_TOKEN");
  assert.equal(callsOf("setMyCommands").length, 0, "版本没变时即便重新检查也不该调接口");
  db.close();
});

test("没有数据库 / 没有 token 时安全返回", async () => {
  const result = await syncCommandMenu({}, "");
  assert.equal(result.synced, false);
});
