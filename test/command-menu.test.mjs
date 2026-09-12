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
