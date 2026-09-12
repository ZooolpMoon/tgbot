// ==========================================
// 🗑️ 消息自动删除测试
//
// 覆盖：类型与默认值、全局 / 场景两级设置、作用域归一化、
//       发送时按类型取时长（0 = 不删）、管理面板的写入与恢复默认。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  AUTO_DELETE_KINDS, autoDeleteLabel, defaultAutoDeleteSec, formatAutoDeleteDelay,
  getAutoDeleteMap, getAutoDeleteSeconds, getExplicitAutoDelete, isAutoDeleteKind,
  parseAutoDeleteValue, resolveAutoDeleteScope, setAutoDeleteSeconds, clearAutoDeleteOverride
} from "../src/services/auto-delete.js";
import { sendAutoDelete } from "../src/telegram/auto-delete.js";
import { validateKeyboard } from "../src/utils/layout.js";
import { getAutoDeleteHomeKeyboard, getAutoDeleteKindKeyboard } from "../src/admin/auto-delete.js";

// ---- Telegram API 桩 ----
let apiCalls = [];
let messageIdSeq = 100;
let lastSentId = 0;

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  const body = opts.body ? JSON.parse(opts.body) : {};
  apiCalls.push({ method, body });
  if (method === "sendMessage") lastSentId = ++messageIdSeq;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => (method === "sendMessage"
      ? { ok: true, result: { message_id: lastSentId } }
      : { ok: true, result: true })
  };
};

const resetCalls = () => { apiCalls.length = 0; };
const callsOf = (method) => apiCalls.filter((c) => c.method === method);

const makeCtx = () => {
  const pending = [];
  return { waitUntil: (p) => pending.push(p), pending };
};

/** 计数型秒表：sendAutoDelete 内部用 ms，小数值方便测试快速跑完 */
const FAST = 0.02;

// ==========================================
// 纯函数
// ==========================================

test("消息类型表：key 唯一、默认值与既有行为一致", () => {
  const keys = AUTO_DELETE_KINDS.map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length, "类型 key 不应重复");

  for (const kind of AUTO_DELETE_KINDS) {
    assert.ok(isAutoDeleteKind(kind.key));
    assert.equal(defaultAutoDeleteSec(kind.key), kind.defaultSec);
    assert.ok(autoDeleteLabel(kind.key).includes(kind.label));
    assert.ok(kind.desc, `${kind.key} 缺少说明`);
  }

  // 改造前的行为：指令类 5 秒删除，卡片 / AI 回复 / 公告保持不动
  assert.equal(defaultAutoDeleteSec("cmd"), 5);
  assert.equal(defaultAutoDeleteSec("guard"), 5);
  assert.equal(defaultAutoDeleteSec("card"), 0);
  assert.equal(defaultAutoDeleteSec("ai"), 0);
  assert.equal(defaultAutoDeleteSec("notice"), 0);
  assert.equal(defaultAutoDeleteSec("未知类型"), 5, "未知类型回落到 RULES.AUTO_DELETE_MS");
});

test("formatAutoDeleteDelay：0 表示不删除，其余换算成中文", () => {
  assert.equal(formatAutoDeleteDelay(0), "不删除");
  assert.equal(formatAutoDeleteDelay(-1), "不删除");
  assert.equal(formatAutoDeleteDelay(5), "5 秒");
  assert.equal(formatAutoDeleteDelay(60), "1 分钟");
  assert.equal(formatAutoDeleteDelay(300), "5 分钟");
  assert.equal(formatAutoDeleteDelay(3600), "1 小时");
  assert.equal(formatAutoDeleteDelay(90), "1 分 30 秒");
});

test("parseAutoDeleteValue：非法值视为没设置，超上限会收敛", () => {
  assert.equal(parseAutoDeleteValue("30"), 30);
  assert.equal(parseAutoDeleteValue("0"), 0);
  assert.equal(parseAutoDeleteValue(""), null);
  assert.equal(parseAutoDeleteValue(null), null);
  assert.equal(parseAutoDeleteValue("abc"), null);
  assert.equal(parseAutoDeleteValue("-5"), null);
  assert.equal(parseAutoDeleteValue(999999), 86400);
});

test("resolveAutoDeleteScope：群聊设置按群共享，私聊按用户", () => {
  assert.equal(resolveAutoDeleteScope("group:-100:user:999"), "group:-100", "群成员场景应归一到群");
  assert.equal(resolveAutoDeleteScope("group:-100"), "group:-100");
  assert.equal(resolveAutoDeleteScope("private:999"), "private:999");
  assert.equal(resolveAutoDeleteScope("global"), "global");
  assert.equal(resolveAutoDeleteScope(""), null);
});

// ==========================================
// 两级设置
// ==========================================

test("设置：全局是默认，群场景覆盖全局，未设置时跟随", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  // 没有任何设置 → 全用内置默认
  let map = await getAutoDeleteMap(env, "group:-100");
  assert.equal(map.cmd, 5);
  assert.equal(map.ai, 0);

  // 全局把 AI 回复改成 30 秒 → 所有场景跟随
  await setAutoDeleteSeconds(env, "global", "ai", 30);
  assert.equal(await getAutoDeleteSeconds(env, "group:-100", "ai"), 30);
  assert.equal(await getAutoDeleteSeconds(env, "group:-200", "ai"), 30);

  // 本群单独设成 0（不删除）→ 只影响这个群
  await setAutoDeleteSeconds(env, "group:-100:user:999", "ai", 0);
  assert.equal(await getAutoDeleteSeconds(env, "group:-100", "ai"), 0);
  assert.equal(await getAutoDeleteSeconds(env, "group:-200", "ai"), 30, "别的群应继续跟随全局");

  const explicit = await getExplicitAutoDelete(env, "group:-100");
  assert.equal(explicit.ai, 0);
  assert.equal(explicit.cmd, undefined);

  // 恢复默认：本群回到跟随全局
  await clearAutoDeleteOverride(env, "group:-100", "ai");
  assert.equal(await getAutoDeleteSeconds(env, "group:-100", "ai"), 30);
  // 全局恢复内置默认
  await clearAutoDeleteOverride(env, "global", "ai");
  assert.equal(await getAutoDeleteSeconds(env, "group:-100", "ai"), 0);

  assert.equal(db.count("scene_settings", "name LIKE 'autodelete.%'"), 0);
  db.close();
});

test("设置：非法输入与未知类型会被拒绝", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await setAutoDeleteSeconds(env, "global", "不存在的类型", 10), false);
  assert.equal(await setAutoDeleteSeconds(env, "global", "cmd", "abc"), false);
  assert.equal(await clearAutoDeleteOverride(env, "global", "不存在的类型"), false);
  assert.equal(db.count("scene_settings", "name LIKE 'autodelete.%'"), 0);
  db.close();
});

// ==========================================
// 发送时按类型取时长
// ==========================================

test("群聊发送：按类型取时长，到期后删除那条消息", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  await setAutoDeleteSeconds(env, "group:-100", "cmd", FAST);

  const ctx = makeCtx();
  resetCalls();
  await sendAutoDelete("T", "-100", "指令回执", null, true, ctx, {
    kind: "cmd", env, sceneKey: "group:-100:user:999"
  });
  await Promise.all(ctx.pending);

  const sent = callsOf("sendMessage").at(-1);
  assert.ok(sent, "应先发出消息");
  const deleted = callsOf("deleteMessage").at(-1);
  assert.ok(deleted, "到期应删除消息");
  assert.equal(String(deleted.body.chat_id), "-100");
  assert.equal(String(deleted.body.message_id), String(lastSentId), "删除的应是刚发出去的那条");
  db.close();
});

test("群聊发送：0 秒表示不删除（AI 回复默认如此）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const ctx = makeCtx();

  resetCalls();
  await sendAutoDelete("T", "-100", "AI 回复", null, true, ctx, {
    kind: "ai", env, sceneKey: "group:-100"
  });
  await Promise.all(ctx.pending);

  assert.equal(callsOf("sendMessage").length, 1);
  assert.equal(callsOf("deleteMessage").length, 0, "默认不应删除 AI 回复");

  // 设置了时长之后才删除
  await setAutoDeleteSeconds(env, "group:-100", "ai", FAST);
  resetCalls();
  const ctx2 = makeCtx();
  await sendAutoDelete("T", "-100", "AI 回复", null, true, ctx2, {
    kind: "ai", env, sceneKey: "group:-100"
  });
  await Promise.all(ctx2.pending);
  assert.equal(callsOf("deleteMessage").length, 1);
  db.close();
});

test("私聊发送：从不删除，键盘也不会丢", { skip: !hasSqlite && "需要 node:sqlite" }, async () => { 
  const db = createTestDB();
  const env = { DB: db };
  await setAutoDeleteSeconds(env, "global", "card", FAST);
  const ctx = makeCtx();

  resetCalls();
  await sendAutoDelete("T", "999", "卡片", "HTML", false, ctx, {
    kind: "card", env, sceneKey: "private:999",
    keyboard: { inline_keyboard: [[{ text: "确定", callback_data: "ok" }]] }
  });
  await Promise.all(ctx.pending);

  assert.equal(callsOf("deleteMessage").length, 0, "私聊不应删除");
  const sent = callsOf("sendMessage").at(-1);
  assert.ok(sent.body.reply_markup, "卡片键盘应保留");
  db.close();
});

// ==========================================
// 管理面板
// ==========================================

test("面板键盘：行数受控，类型按钮带当前时长", () => {
  const home = getAutoDeleteHomeKeyboard("c", { cmd: 30, ai: 0 }, { cmd: 30 });
  assert.deepEqual(validateKeyboard(home), []);
  const flat = home.inline_keyboard.flat();
  assert.equal(flat[0].callback_data, "admin_autodel_o_g");
  assert.equal(flat[1].callback_data, "admin_autodel_o_c");
  assert.ok(flat.some((b) => b.text.includes("30 秒")), "应显示当前时长");
  assert.ok(flat.some((b) => b.callback_data === "admin_autodel_k_c_cmd"));

  const kindKb = getAutoDeleteKindKeyboard("c", "ai", 0);
  assert.deepEqual(validateKeyboard(kindKb), []);
  const kindFlat = kindKb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(kindFlat.includes("admin_autodel_s_c_ai_0"));
  assert.ok(kindFlat.includes("admin_autodel_s_c_ai_1800"));
  assert.ok(kindFlat.includes("admin_autodel_s_c_ai_d"), "应能恢复跟随全局");
  assert.ok(kindFlat.includes("admin_autodel_o_c"), "应能返回面板");
});

test("面板：改某个类型的时长、切换全局、恢复默认", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  db.exec(`INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, username, first_name)
           VALUES ('group:-100:user:999', 'user:999', '-100', 'supergroup', '999', 'admin', '管理员')`);
  const env = { DB: db };
  const ctx = makeCtx();
  const uctx = {
    chatId: "-100", userId: "999", chatType: "supergroup",
    userKey: "user:999", sceneKey: "group:-100:user:999"
  };
  const { handleCallback } = await import("../src/handlers/callback.js");

  const click = (data) => handleCallback({
    env, ctx, token: "T", myId: "999", uctx,
    payload: {
      callback_query: {
        id: `cb_${data}`, from: { id: 999 }, data,
        message: { message_id: 10, chat: { id: -100, type: "supergroup" } }
      }
    }
  });

  // 打开面板
  resetCalls();
  await click("admin_autodel");
  const panel = callsOf("editMessageText").at(-1);
  assert.ok(String(panel.body.text).includes("消息自动删除"));
  assert.ok(String(panel.body.text).includes("指令回执"));
  const keys = panel.body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(keys.includes("admin_autodel_k_c_cmd"));

  // 打开某一类 → 选 30 秒（写场景级设置，群内共享）
  await click("admin_autodel_k_c_cmd");
  await click("admin_autodel_s_c_cmd_30");
  assert.equal(
    db.get("SELECT value FROM scene_settings WHERE scene_key = 'group:-100' AND name = 'autodelete.cmd'").value,
    "30"
  );

  // 切到全局默认页 → 设置全局 0（不删除）
  await click("admin_autodel_o_g");
  const globalPanel = callsOf("editMessageText").at(-1);
  assert.ok(String(globalPanel.body.text).includes("全局默认值"));
  await click("admin_autodel_s_g_ai_0");
  assert.equal(
    db.get("SELECT value FROM scene_settings WHERE scene_key = 'global' AND name = 'autodelete.ai'").value,
    "0"
  );

  // 恢复默认 → 记录被删掉
  await click("admin_autodel_s_c_cmd_d");
  assert.equal(db.count("scene_settings", "scene_key = 'group:-100' AND name = 'autodelete.cmd'"), 0);

  await Promise.all(ctx.pending);
  db.close();
});
