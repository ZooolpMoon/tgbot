// ==========================================
// 🧭 命令注册表与自动帮助
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, resolveCommand, buildHelpText } from "../src/handlers/commands/registry.js";

test("命令表本身是自洽的（名称唯一、描述齐全、别名不冲突）", () => {
  const seen = new Set();
  for (const cmd of COMMANDS) {
    assert.ok(cmd.name.startsWith("/"), `${cmd.name} 应以 / 开头`);
    assert.ok(cmd.desc, `${cmd.name} 缺少说明`);
    assert.equal(typeof cmd.handle, "function", `${cmd.name} 缺少处理函数`);
    for (const name of [cmd.name, ...(cmd.aliases || [])]) {
      assert.ok(!seen.has(name), `命令名/别名冲突：${name}`);
      seen.add(name);
    }
  }
});

test("按名称与别名都能解析到同一条命令", () => {
  assert.equal(resolveCommand("/checkin").name, "/checkin");
  assert.equal(resolveCommand("/sign").name, "/checkin");
  assert.equal(resolveCommand("/SIGN@MyBot").name, "/checkin", "应忽略 @botname 且大小写不敏感");
  assert.equal(resolveCommand("/sign 额外参数").name, "/checkin");
  assert.equal(resolveCommand("/tasks").name, "/tasks");
  assert.equal(resolveCommand("/not-a-command"), null);
  assert.equal(resolveCommand("普通消息"), null, "非指令不参与解析");
});

test("权限标记正确：只读命令不需要解锁，管理命令需要", () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));

  assert.equal(byName["/start"].scope, undefined, "普通命令不带 scope");
  assert.equal(byName["/admin"].scope, "admin");
  assert.equal(byName["/admin"].needsUnlock, false, "/admin 本身就是解锁命令");
  for (const name of ["/users", "/stats", "/addpoints", "/broadcast", "/code_new", "/shop_add"]) {
    assert.equal(byName[name].scope, "admin", `${name} 应为管理员命令`);
    assert.notEqual(byName[name].needsUnlock, false, `${name} 需要先 /admin 解锁`);
  }

  assert.equal(byName["/shop"].privateOnly, true, "商城仅私聊");
  assert.equal(byName["/redeem"].privateOnly, true, "兑换码仅私聊");
  assert.equal(byName["/clearmem"].privateOnly, undefined, "清除记忆允许在群里执行");
});

test("功能开关标记：受开关控制的命令都标了 feature", () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.equal(byName["/game"].feature, "game");
  assert.equal(byName["/checkin"].feature, "checkin");
  assert.equal(byName["/shop"].feature, "shop");
  assert.equal(byName["/tasks"].feature, "tasks");
  assert.equal(byName["/redeem"].feature, "redeem");
  assert.equal(byName["/points"].feature, undefined, "积分流水不受功能开关控制");
});

test("帮助文案由命令表生成，且按身份/场景裁剪", () => {
  const userPrivate = buildHelpText({ isMaster: false, isGroupCtx: false });
  assert.match(userPrivate, /指令列表/);
  assert.match(userPrivate, /\/tasks/);
  assert.match(userPrivate, /\/shop/);
  assert.match(userPrivate, /\/redeem/);
  assert.doesNotMatch(userPrivate, /\/broadcast/, "普通用户不应看到管理命令细节");

  const userGroup = buildHelpText({ isMaster: false, isGroupCtx: true });
  assert.doesNotMatch(userGroup, /\/shop /, "群聊帮助里不展示仅私聊命令");
  assert.match(userGroup, /仅支持私聊/);

  const adminPrivate = buildHelpText({ isMaster: true, isGroupCtx: false });
  assert.match(adminPrivate, /管理员指令/);
  assert.match(adminPrivate, /\/broadcast/);
  assert.match(adminPrivate, /\/code_new/);

  // 每个命令的说明都应该出现在对应场景的帮助里
  for (const cmd of COMMANDS) {
    const target = cmd.groupOnly ? userGroup : adminPrivate;
    assert.ok(target.includes(cmd.name), `帮助里缺少 ${cmd.name}`);
  }
});

test("帮助文案会转义 usage 里的尖括号占位符（否则会被 Telegram 当 HTML 标签）", () => {
  const html = buildHelpText({ isMaster: true, isGroupCtx: false });
  const withoutAllowedTags = html.replace(/<\/?(code|b|i)>/g, "");
  assert.doesNotMatch(withoutAllowedTags, /<[^>]*>/, "不应残留会被误解析的标签");
  assert.match(html, /&lt;群ID&gt;/, "占位符应以实体形式出现");
 assert.match(html, /&lt;兑换码&gt;/);
});

test("处置类指令：只认 /指令，且本群管理员也能在群里用", () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));

  // 群规处置只提供指令入口，帮助文案里不再宣传自然语言
  const groupHelp = buildHelpText({ isMaster: false, isGroupCtx: true });
  assert.match(groupHelp, /\/report/);
  assert.match(groupHelp, /不猜自然语言/);

  // /report 是群成员可用的举报入口：仅群聊 + 受执法开关控制
  assert.equal(byName["/report"].scope, undefined, "举报不是管理员命令");
  assert.equal(byName["/report"].groupOnly, true, "举报只能在群里用");
  assert.equal(byName["/report"].feature, "guard");

  // 处置指令标了 groupAdmin：本群管理员无需机器人管理员身份也能用
  for (const name of ["/ban", "/unban", "/kick", "/groupban", "/mute", "/unmute", "/rules"]) {
    assert.equal(byName[name].groupAdmin, true, `${name} 应允许本群管理员使用`);
  }
  assert.equal(byName["/guard"].groupAdmin, undefined, "群规面板仍只给机器人管理员");
  assert.equal(byName["/setrules"].groupAdmin, undefined, "改群规仍只给机器人管理员");

  // 群聊帮助里不应出现仅私聊的指令
  assert.doesNotMatch(buildHelpText({ isMaster: false, isGroupCtx: true }), /\/shop /);
});
