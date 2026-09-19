// ==========================================
// v3.10.0 守卫测试 · 自动反垃圾（automod）
//
// 这一块最需要钉死的是：**自己人永不被处置** ——
// 群主、本群管理员、机器人管理员都必须豁免，否则可能把后台一起锁掉。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  detectBehaviorViolation, detectNewcomerViolation, escalateMinutes, decideAction,
  handleAutoMod, getAutoModConfig, setAutoModConfig, noteNewcomers, isNewcomer,
  resetAutoModWindows, countAutoModToday, AUTOMOD_DEFAULTS
} from "../src/services/automod.js";
import { AUTOMOD } from "../src/config/constants.js";
import { setFeature } from "../src/services/features.js";
import { buildGroupScopeKey } from "../src/core/context.js";
import { setAutoDeleteSeconds } from "../src/services/auto-delete.js";

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
const called = (method) => apiCalls.filter((c) => c.method === method);

function makeEnv(db) {
  return { DB: db, AI: { run: async () => ({ response: "ok" }) }, MY_TELEGRAM_ID: "999" };
}

function groupMsg({ userId = "1", chatId = "-100", text = "你好", messageId = 11 } = {}) {
  return {
    uctx: {
      userId, userKey: `user:${userId}`, chatId,
      sceneKey: `group:${chatId}:user:${userId}`,
      chatType: "supergroup", firstName: "测试", username: ""
    },
    message: { message_id: messageId, text, from: { id: userId, is_bot: false } }
  };
}

function fresh() {
  resetAutoModWindows();
  apiCalls = [];
}

test("反垃圾：刷屏按窗口内条数判定，窗口外的旧消息不计", () => {
  const now = 1_000_000;
  const config = { flood: true, repeat: false, link: false };

  const few = [{ t: now - 1000, text: "a" }, { t: now - 2000, text: "b" }];
  assert.equal(detectBehaviorViolation({ msgs: few, text: "c", now, config }), null);

  const many = Array.from({ length: AUTOMOD.FLOOD_MAX_MESSAGES }, (_, i) => ({ t: now - i * 10, text: "x" }));
  assert.equal(detectBehaviorViolation({ msgs: many, text: "y", now, config })?.rule, "flood");

  // 全部滑出窗口后不再判定（避免「聊过天的人永远被拦」）
  const stale = many.map((m) => ({ ...m, t: now - (AUTOMOD.FLOOD_WINDOW_SEC + 5) * 1000 }));
  assert.equal(detectBehaviorViolation({ msgs: stale, text: "y", now, config }), null);
});

test("反垃圾：单条超长消息按刷屏处理", () => {
  const now = 1_000_000;
  const config = { flood: true, repeat: false, link: false };
  const long = "啊".repeat(AUTOMOD.MAX_MESSAGE_CHARS + 1);
  assert.equal(detectBehaviorViolation({ msgs: [], text: long, now, config })?.rule, "flood");
});

test("反垃圾：重复发言去空白与大小写后再比", () => {
  const now = 1_000_000;
  const config = { flood: false, repeat: true, link: false };
  const msgs = [
    { t: now - 10, text: "买 币" },
    { t: now - 20, text: "买币" },
    { t: now - 30, text: " 买币 " }
  ];
  assert.equal(detectBehaviorViolation({ msgs, text: "买币", now, config })?.rule, "repeat");

  const stale = msgs.map((m) => ({ ...m, t: now - (AUTOMOD.REPEAT_WINDOW_SEC + 5) * 1000 }));
  assert.equal(detectBehaviorViolation({ msgs: stale, text: "买币", now, config }), null);
});

test("反垃圾：新成员沙盒认链接与转发，普通文本不算", () => {
  assert.equal(detectNewcomerViolation({ message: { text: "看看 https://x.com/a" } })?.rule, "link");
  assert.equal(detectNewcomerViolation({ message: { text: "hi", forward_origin: { type: "user" } } })?.rule, "link");
  assert.equal(detectNewcomerViolation({ message: { text: "普通聊天" } }), null);

  // text_link 实体（正文里看不到 URL）也要认出来
  const entityLink = {
    text: "点这里",
    entities: [{ type: "text_link", offset: 0, length: 3, url: "https://x.com" }]
  };
  assert.equal(detectNewcomerViolation({ message: entityLink })?.rule, "link");
});

test("反垃圾：默认只删除，配成禁言也只在第 2 次起升级，时长递进", () => {
  assert.equal(decideAction({ action: "delete" }, 5), "delete");
  assert.equal(decideAction({ action: "mute" }, 1), "delete");
  assert.equal(decideAction({ action: "mute" }, 2), "mute");

  assert.equal(escalateMinutes(1), AUTOMOD.ESCALATE_MINUTES[0]);
  assert.equal(escalateMinutes(2), AUTOMOD.ESCALATE_MINUTES[1]);
  // 超出档位取最后一档，不会返回 undefined
  assert.equal(escalateMinutes(99), AUTOMOD.ESCALATE_MINUTES[AUTOMOD.ESCALATE_MINUTES.length - 1]);
});

test("反垃圾：群级配置读写往返，没动的规则保持默认", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);

  assert.deepEqual(await getAutoModConfig(env, "-100"), { ...AUTOMOD_DEFAULTS });

  await setAutoModConfig(env, "-100", { repeat: false, action: "mute" });
  const updated = await getAutoModConfig(env, "-100");
  assert.equal(updated.repeat, false);
  assert.equal(updated.action, "mute");
  assert.equal(updated.flood, true);
  db.close();
});

test("反垃圾：开关关闭时一条消息都不动", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);
  // automod 默认关闭：会自动删消息的功能不能默认开
  await setFeature(env, buildGroupScopeKey("-100"), "automod", false);

  const { uctx, message } = groupMsg();
  assert.equal(await handleAutoMod({ env, token: "T", ctx: null, chatId: "-100", uctx, message, myId: "999" }), false);
  assert.equal(called("deleteMessage").length, 0);
  db.close();
});

test("反垃圾：开启后刷屏被删消息并记账一次", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);
  await setFeature(env, buildGroupScopeKey("-100"), "automod", true);
  // 关掉「执法回执」的自动删除：否则提示消息会在测试里 sleep 5 秒再删，
  // 既拖慢用例，也会让 deleteMessage 的调用数不好断言
  await setAutoDeleteSeconds(env, buildGroupScopeKey("-100"), "guard", 0);

  const { uctx } = groupMsg();
  for (let i = 0; i < AUTOMOD.FLOOD_MAX_MESSAGES; i++) {
    await handleAutoMod({
      env, token: "T", ctx: null, chatId: "-100", uctx,
      message: { message_id: 100 + i, text: `刷屏${i}`, from: { id: 1, is_bot: false } },
      myId: "999"
    });
  }
  const handled = await handleAutoMod({
    env, token: "T", ctx: null, chatId: "-100", uctx,
    message: { message_id: 999, text: "刷屏最后一条", from: { id: 1, is_bot: false } },
    myId: "999"
  });

  assert.equal(handled, true, "达到阈值应触发");
  const deletes = called("deleteMessage");
  assert.equal(deletes.length, 1, "只该删除触发的那条消息");
  assert.equal(Number(deletes[0].body.message_id), 999, "删的必须是违规的那条");
  assert.equal(db.count("automod_events"), 1);
  assert.equal(db.count("automod_strikes"), 1);
  db.close();
});

test("反垃圾：冷却期内连发不会重复处置同一个人", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);
  await setFeature(env, buildGroupScopeKey("-100"), "automod", true);
  const { uctx } = groupMsg();

  for (let i = 0; i < AUTOMOD.FLOOD_MAX_MESSAGES; i++) {
    await handleAutoMod({
      env, token: "T", ctx: null, chatId: "-100", uctx,
      message: { message_id: 300 + i, text: `x${i}`, from: { id: 1, is_bot: false } }, myId: "999"
    });
  }
  // 紧接着的十几条都还在冷却期里，只该留下一条记录
  for (let i = 0; i < 5; i++) {
    await handleAutoMod({
      env, token: "T", ctx: null, chatId: "-100", uctx,
      message: { message_id: 400 + i, text: `y${i}`, from: { id: 1, is_bot: false } }, myId: "999"
    });
  }
  assert.equal(db.count("automod_events"), 1, "一次刷屏只处理一次");
  db.close();
});

test("反垃圾：机器人管理员与群主不会被自动处置", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);
  await setFeature(env, buildGroupScopeKey("-100"), "automod", true);

  const owner = groupMsg({ userId: "999" });
  for (let i = 0; i < AUTOMOD.FLOOD_MAX_MESSAGES + 1; i++) {
    await handleAutoMod({
      env, token: "T", ctx: null, chatId: "-100", uctx: owner.uctx,
      message: { message_id: 200 + i, text: `管理员连发${i}`, from: { id: 999, is_bot: false } },
      myId: "999"
    });
  }
  assert.equal(db.count("automod_events"), 0, "owner 不该被自动反垃圾处理");
  assert.equal(called("deleteMessage").length, 0);
  db.close();
});

test("反垃圾：指令消息与机器人自己的发言不参与判定", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);
  await setFeature(env, buildGroupScopeKey("-100"), "automod", true);
  const { uctx } = groupMsg();

  for (let i = 0; i < AUTOMOD.FLOOD_MAX_MESSAGES + 2; i++) {
    await handleAutoMod({
      env, token: "T", ctx: null, chatId: "-100", uctx,
      message: { message_id: 500 + i, text: "/ban 1 广告", from: { id: 1, is_bot: false } }, myId: "999"
    });
  }
  assert.equal(db.count("automod_events"), 0, "指令不算刷屏");

  await handleAutoMod({
    env, token: "T", ctx: null, chatId: "-100", uctx,
    message: { message_id: 600, text: "机器人发言", from: { id: 1, is_bot: true } }, myId: "999"
  });
  assert.equal(db.count("automod_events"), 0, "机器人自己的消息不该被判定");
  db.close();
});

test("反垃圾：新成员时间可记录与判定", { skip: !hasSqlite }, async () => {
  fresh();
  const db = createTestDB();
  const env = makeEnv(db);

  await noteNewcomers(env, "-100", [{ id: "55", is_bot: false }]);
  assert.equal(await isNewcomer(env, "-100", "55"), true);
  assert.equal(await isNewcomer(env, "-100", "56"), false, "没记录的人不算新成员");

  // 机器人不该被记成新成员
  await noteNewcomers(env, "-100", [{ id: "77", is_bot: true }]);
  assert.equal(db.count("group_newcomers", "user_id = '77'"), 0);
  db.close();
});

test("反垃圾：某天的处置次数可统计（群报要用）", { skip: !hasSqlite }, async () => {
  const db = createTestDB();
  const env = makeEnv(db);
  const dateStr = "2026-09-18";
  db.exec(`
    INSERT INTO automod_events (chat_id, user_id, user_label, rule, action, detail, created_at) VALUES
      ('-100','1','@a','flood','delete','刷屏','${dateStr} 09:00:00'),
      ('-100','2','@b','repeat','mute','重复','${dateStr} 10:00:00'),
      ('-200','3','@c','flood','delete','刷屏','${dateStr} 11:00:00')
  `);
  assert.equal(await countAutoModToday(env, "-100", dateStr), 2, "只看本群");
  db.close();
});
