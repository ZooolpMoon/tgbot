// ==========================================
// ⚙️ 功能开关（v2.1.0：只服务全局）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  FEATURES, getFeatureMap, isFeatureEnabled, setFeature, resetFeature, isFeatureKey, featureLabel
} from "../src/services/features.js";
import { getSetting, setSetting, getSettings, deleteSetting, SETTINGS_SCOPE } from "../src/services/settings.js";

test("开关定义与识别", () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length, "开关 key 不能重复");
  for (const f of FEATURES) assert.ok(f.label && f.desc, `${f.key} 缺少文案`);

  assert.equal(isFeatureKey("ai"), true);
  assert.equal(isFeatureKey("nope"), false);
  assert.equal(featureLabel("game"), "游戏大厅");
  assert.equal(featureLabel("nope"), "nope");
});

test("默认全部开启；未知开关视为开启", async () => {
  const map = await getFeatureMap({});
  for (const f of FEATURES) assert.equal(map[f.key], true, `${f.key} 默认应开启`);
  assert.equal(await isFeatureEnabled({}, "nope"), true);
});

test("关闭 / 重新开启并持久化", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await isFeatureEnabled(env, "game"), true);
  assert.equal(await setFeature(env, "game", false), true);
  assert.equal(await isFeatureEnabled(env, "game"), false);
  assert.equal(await isFeatureEnabled(env, "shop"), true, "其他开关不受影响");

  assert.equal(await setFeature(env, "game", true), true);
  assert.equal(await isFeatureEnabled(env, "game"), true);

  // 重复设置只更新一行
  await setFeature(env, "game", false);
  await setFeature(env, "game", false);
  assert.equal(db.count("scene_settings", "name = 'feature.game'"), 1);

  // 未知开关不写入
  assert.equal(await setFeature(env, "nope", false), false);
  assert.equal(db.count("scene_settings"), 1);
  db.close();
});

test("resetFeature 清除设置后恢复默认开启", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, "tasks", false);
  assert.equal(await isFeatureEnabled(env, "tasks"), false);

  assert.equal(await resetFeature(env, "tasks"), true);
  assert.equal(await isFeatureEnabled(env, "tasks"), true);
  assert.equal(db.count("scene_settings"), 0);
  db.close();
});

test("功能开关只写全局作用域（不会再出现场景级记录）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, "ai", false);
  const rows = db.all("SELECT scene_key, name FROM scene_settings");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scene_key, SETTINGS_SCOPE);
  db.close();
});

test("全局设置服务：读写、前缀查询与删除", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await getSetting(env, "missing", "fallback"), "fallback");
  await setSetting(env, "task.all_bonus", 20);
  assert.equal(await getSetting(env, "task.all_bonus"), "20");

  await setSetting(env, "feature.ai", "off");
  const prefixed = await getSettings(env, "task.");
  assert.deepEqual(prefixed, { "task.all_bonus": "20" });

  await deleteSetting(env, "task.all_bonus");
  assert.equal(await getSetting(env, "task.all_bonus", null), null);
  assert.equal(db.count("scene_settings"), 1);
  db.close();
});
