// ==========================================
// ⚙️ 功能开关（三级：全局 / 群聊场景 / 私聊场景）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  GLOBAL_SCOPE, FEATURES, getFeatureMap, getExplicitSettings, isFeatureEnabled,
  setFeature, clearFeatureOverride, clearFeatureOverrides, isFeatureKey, featureLabel,
  groupKeyOfScene
} from "../src/services/features.js";
import { handleFeatureToggle, handleFeatureReset, renderFeatureScope } from "../src/admin/features.js";
import { handleCallback } from "../src/handlers/callback.js";
import { buildGroupScopeKey } from "../src/core/context.js";
import { ADMIN_CALLBACK } from "../src/config/constants.js";
import { getSetting, setSetting, getSettings, deleteSetting, SETTINGS_SCOPE } from "../src/services/settings.js";

const GROUP_A = "group:-100:user:1";
const GROUP_B = "group:-200:user:1";
const PRIVATE = "private:1";

// ---------- 捕获出站消息（面板渲染断言用）----------
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
const lastEditedText = () => {
  const edits = apiCalls.filter((c) => c.method === "editMessageText");
  return String(edits[edits.length - 1]?.body?.text || "");
};
const lastEditedKeyboard = () => {
  const edits = apiCalls.filter((c) => c.method === "editMessageText");
  return edits[edits.length - 1]?.body?.reply_markup || null;
};
/** 造一条群成员场景记录（功能开关面板的群列表要从这里聚合） */
function seedGroupScenes(db, chatId, userIds) {
  for (const uid of userIds) {
    db.exec(
      `INSERT INTO user_scenes (scene_key, user_key, chat_id, chat_type, user_id, first_name)
       VALUES ('group:${chatId}:user:${uid}', 'user:${uid}', '${chatId}', 'supergroup', '${uid}', '成员${uid}')`
    );
  }
}

/** 以拥有者身份点一个管理面板按钮（走真实回调入口，覆盖 callback.js 的路由） */
function clickAdmin(env, data) {
  return handleCallback({
    env, ctx: { pending: [], waitUntil(p) { this.pending.push(p); } },
    token: "T", myId: "999",
    uctx: {
      chatId: "999", userId: "999", chatType: "private",
      userKey: "user:999", sceneKey: "private:999", firstName: "管理员"
    },
    payload: {
      callback_query: {
        id: `cb_${data}`, from: { id: 999 }, data,
        message: { message_id: 7, chat: { id: 999, type: "private" } }
      }
    }
  });
}

test("开关定义与识别", () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of FEATURES) assert.ok(f.label && f.desc, `${f.key} 缺少文案`);

  assert.equal(isFeatureKey("ai"), true);
  assert.equal(isFeatureKey("nope"), false);
  assert.equal(featureLabel("game"), "游戏大厅");
});

test("默认开启，但标记了 defaultEnabled:false 的开关默认关闭；未知开关视为开启", async () => {
  const map = await getFeatureMap({});
  for (const f of FEATURES) {
    // 「会主动打扰群成员」的功能（如入群欢迎）必须由管理员显式打开，
    // 否则升级一次就会往所有群发消息、限制新成员发言
    const expected = f.defaultEnabled !== false;
    assert.equal(map[f.key], expected, `开关 ${f.key} 的默认值不符合声明`);
  }
  assert.ok(
    FEATURES.some((f) => f.defaultEnabled === false),
    "至少要有一个默认关闭的开关，否则上面那句断言形同虚设"
  );
  assert.equal(await isFeatureEnabled({}, PRIVATE, "nope"), true);
});

test("全局关闭对所有场景生效", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, GLOBAL_SCOPE, "game", false);
  assert.equal(await isFeatureEnabled(env, GROUP_A, "game"), false);
  assert.equal(await isFeatureEnabled(env, PRIVATE, "game"), false);
  assert.equal(await isFeatureEnabled(env, PRIVATE, "ai"), true, "其他开关不受影响");
  db.close();
});

test("场景设置覆盖全局，且互不影响", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, GLOBAL_SCOPE, "game", false);
  await setFeature(env, GROUP_A, "game", true); // A 群单独打开

  assert.equal(await isFeatureEnabled(env, GROUP_A, "game"), true);
  assert.equal(await isFeatureEnabled(env, GROUP_B, "game"), false, "B 群仍跟随全局");
  assert.equal(await isFeatureEnabled(env, PRIVATE, "game"), false, "私聊场景同样跟随全局");

  const scene = await getExplicitSettings(env, GROUP_A);
  assert.deepEqual(scene, { game: true });
  db.close();
});

test("清除场景覆盖后重新跟随全局", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, GLOBAL_SCOPE, "game", false);
  await setFeature(env, GROUP_A, "game", true);
  await setFeature(env, GROUP_A, "ai", false);

  assert.equal(await clearFeatureOverride(env, GROUP_A, "ai"), true);
  assert.equal(await isFeatureEnabled(env, GROUP_A, "ai"), true, "单项清除后跟随全局（默认开启）");

  const cleared = await clearFeatureOverrides(env, GROUP_A);
  assert.equal(cleared, 1, "应清掉剩余的 game 覆盖");
  assert.equal(await isFeatureEnabled(env, GROUP_A, "game"), false, "全部清除后跟随全局");
  assert.equal((await getExplicitSettings(env, GROUP_A)).game, undefined);
  db.close();
});

test("一次查询即可拿到「场景 + 全局」两层设置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  await setFeature(env, GLOBAL_SCOPE, "shop", false);
  await setFeature(env, PRIVATE, "shop", true);
  await setFeature(env, GLOBAL_SCOPE, "game", false);

  let queries = 0;
  const counting = {
    prepare: (sql) => { queries++; return db.prepare(sql); },
    batch: (stmts) => db.batch(stmts)
  };

  const map = await getFeatureMap({ DB: counting }, PRIVATE);
  assert.equal(map.shop, true, "场景覆盖生效");
  assert.equal(map.game, false, "全局设置生效");
  assert.equal(queries, 1, "应只查一次数据库");
  db.close();
});

test("场景级开关不会被 ensureSchema 清掉（回归）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  await setFeature(env, GROUP_A, "game", false);
  await setFeature(env, GLOBAL_SCOPE, "ai", false);

  // v2.1.0 曾有一条「删除非 global 记录」的迁移，会把场景设置清空——这里锁住它不回来
  const { ensureSchema } = await import(`../src/core/db.js?feat=${Date.now()}`);
  await ensureSchema({ DB: db });

  assert.equal(await isFeatureEnabled(env, GROUP_A, "game"), false, "场景覆盖应保留");
  assert.equal(await isFeatureEnabled(env, GROUP_A, "ai"), false, "全局设置应保留");
  assert.equal(db.count("scene_settings", "scene_key <> 'global'"), 1);
  db.close();
});

test("setFeature 的边界处理", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await setFeature(env, GLOBAL_SCOPE, "not-a-feature", false), false);
  assert.equal(await setFeature(env, "", "ai", false), false);
  assert.equal(await setFeature(env, GLOBAL_SCOPE, "ai", false), true);

  await setFeature(env, GLOBAL_SCOPE, "ai", false);
  assert.equal(db.count("scene_settings"), 1, "重复设置只更新一行");
  db.close();
});

test("全局设置服务：读写、前缀查询与删除", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await getSetting(env, "missing", "fallback"), "fallback");
  await setSetting(env, "task.all_bonus", 20);
  assert.equal(await getSetting(env, "task.all_bonus"), "20");
  assert.equal(db.get("SELECT scene_key FROM scene_settings WHERE name = 'task.all_bonus'").scene_key, SETTINGS_SCOPE);

  await setSetting(env, "feature.ai", "off");
  assert.deepEqual(await getSettings(env, "task."), { "task.all_bonus": "20" });

  await deleteSetting(env, "task.all_bonus");
  assert.equal(await getSetting(env, "task.all_bonus", null), null);
  db.close();
});

// ==========================================
// 🏠 群级作用域（v3.9.0）
//
// 起因：功能开关面板原先按**群成员**列场景、写成员级 scene_key，而 /welcome
// 这类群级功能写的是 `group:<群ID>` —— 两个键，于是「面板点了没反应」。
// 现在群成员场景展开成「成员 → 本群 → 全局」，面板的群列表也按群聚合。
// ==========================================

test("groupKeyOfScene：从群成员场景里取出群级键", () => {
  assert.equal(groupKeyOfScene("group:-100123:user:5"), "group:-100123");
  assert.equal(groupKeyOfScene("group:-100123"), null, "本身就是群级键时没有上一层");
  assert.equal(groupKeyOfScene("private:5"), null);
  assert.equal(groupKeyOfScene(""), null);
  assert.equal(groupKeyOfScene(null), null);
});

test("群级设置对整群成员生效（不必逐个成员设）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const groupKey = buildGroupScopeKey("-100123");

  await setFeature(env, groupKey, "game", false);

  assert.equal(
    await isFeatureEnabled(env, "group:-100123:user:1", "game"), false,
    "成员 1 应受本群设置影响"
  );
  assert.equal(
    await isFeatureEnabled(env, "group:-100123:user:2", "game"), false,
    "成员 2 同样受本群设置影响"
  );
  assert.equal(
    await isFeatureEnabled(env, "group:-999:user:1", "game"), true,
    "别的群不受影响"
  );
  db.close();
});

test("成员级设置仍然优先于群级（向后兼容）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const groupKey = buildGroupScopeKey("-100123");

  await setFeature(env, groupKey, "game", false);          // 本群：关
  await setFeature(env, "group:-100123:user:1", "game", true);  // 成员 1：单独开

  assert.equal(await isFeatureEnabled(env, "group:-100123:user:1", "game"), true, "成员级应覆盖群级");
  assert.equal(await isFeatureEnabled(env, "group:-100123:user:2", "game"), false, "其他成员仍跟随群级");

  // 来源也要说清是哪一层定的
  const { getFeatureSources } = await import("../src/services/features.js");
  const sources = await getFeatureSources(env, "group:-100123:user:1");
  assert.equal(sources.game, "group:-100123:user:1");
  db.close();
});

test("群聊列表按群聚合：同一群多个成员只出现一次", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedGroupScenes(db, "-100123", ["1", "2", "3"]);
  seedGroupScenes(db, "-200456", ["1"]);
  resetCalls();

  await renderFeatureScope("T", env, "999", 7, "gl1");

  const text = lastEditedText();
  assert.match(text, /共 2 个群/, `应按群去重计数，实际：${text.split("\n")[1]}`);
  const labels = (lastEditedKeyboard()?.inline_keyboard || []).flat().map((b) => b.text);
  const groupButtons = labels.filter((l) => l.includes("群 "));
  assert.equal(groupButtons.length, 2, `两个群应只有两个按钮，实际：${groupButtons.join(" | ")}`);
  db.close();
});

test("走真实回调入口：点群列表里的群能打开**群级**开关面板（不能再是「参数无效」）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  seedGroupScenes(db, "-100123", ["1", "2"]);
  resetCalls();

  // 首页 → 群聊列表
  await clickAdmin(env, `${ADMIN_CALLBACK.FEATURES_GROUP_PREFIX}1`);
  const groupButton = (lastEditedKeyboard()?.inline_keyboard || [])
    .flat().find((b) => String(b.text).includes("群 -100123"));
  assert.ok(groupButton, "群列表里应有该群按钮");

  // 点进这个群 —— 这一层曾经用 parseInt 解析 token，把 gc-100123 变成了 NaN
  await clickAdmin(env, groupButton.callback_data);

  const text = lastEditedText();
  assert.match(text, /群 <code>-100123<\/code>/, `应打开群级面板，实际：${text.slice(0, 120)}`);
  assert.ok(!/参数无效/.test(text), "不该再报参数无效");
  assert.ok(text.includes("入群欢迎与验证"), "应列出 welcome 开关");
  db.close();
});

test("面板点群开关写的是群级键，与 /welcome 完全同步", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const groupChatId = "-100123";
  const groupKey = buildGroupScopeKey(groupChatId);

  // 面板按钮：admin_feat_t_gc<群ID>_welcome
  await handleFeatureToggle({
    env, token: "T", chatId: "999", msgId: 7, adminId: "999",
    callback: { id: "cb1" },
    data: `${ADMIN_CALLBACK.FEATURE_TOGGLE_PREFIX}gc${groupChatId}_welcome`
  });

  // 写入的必须是群级键（不是成员级）
  const row = db.get("SELECT scene_key, value FROM scene_settings WHERE name = 'feature.welcome'");
  assert.equal(row.scene_key, groupKey, "面板应写群级键");
  assert.equal(row.value, "on");

  // 入群欢迎与 /welcome 面板读的也是这个键 —— 这就是「同步」
  const { isWelcomeEnabled } = await import("../src/services/welcome.js");
  assert.equal(await isWelcomeEnabled(env, groupChatId), true, "开启后入群欢迎应立即生效");
  assert.equal(
    await isFeatureEnabled(env, groupKey, "welcome"), true,
    "/welcome 面板与入群检查读的是同一个键"
  );
  db.close();
});

test("群面板的「恢复跟随全局」清的是群级覆盖", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const groupChatId = "-100123";
  const groupKey = buildGroupScopeKey(groupChatId);
  await setFeature(env, groupKey, "welcome", true);
  await setFeature(env, groupKey, "game", false);

  const { handleFeatureReset } = await import("../src/admin/features.js");
  await handleFeatureReset({
    env, token: "T", chatId: "999", msgId: 7, adminId: "999",
    callback: { id: "cb1" },
    data: `${ADMIN_CALLBACK.FEATURES_RESET_PREFIX}gc${groupChatId}`
  });

  assert.equal(db.count("scene_settings", "scene_key = ?", groupKey), 0, "群级覆盖应被清空");
  assert.equal(await isFeatureEnabled(env, groupKey, "game"), true, "恢复后跟随全局（默认开启）");
  db.close();
});

test("群面板显示的来源是「本群设置」而不是「本场景设置」", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const groupChatId = "-100123";
  await setFeature(env, buildGroupScopeKey(groupChatId), "welcome", true);
  resetCalls();

  await renderFeatureScope("T", env, "999", 7, `gc${groupChatId}`);

  const text = lastEditedText();
  assert.match(text, /本群设置/, `群级面板应把来源标为「本群设置」：${text.slice(0, 200)}`);
  assert.ok(text.includes("入群欢迎与验证"), "应列出 welcome 开关");
  db.close();
});
