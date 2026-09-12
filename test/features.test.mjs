// ==========================================
// ⚙️ 功能开关（三级：全局 / 群聊场景 / 私聊场景）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  GLOBAL_SCOPE, FEATURES, getFeatureMap, getExplicitSettings, isFeatureEnabled,
  setFeature, clearFeatureOverride, clearFeatureOverrides, isFeatureKey, featureLabel
} from "../src/services/features.js";
import { getSetting, setSetting, getSettings, deleteSetting, SETTINGS_SCOPE } from "../src/services/settings.js";

const GROUP_A = "group:-100:user:1";
const GROUP_B = "group:-200:user:1";
const PRIVATE = "private:1";

test("开关定义与识别", () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of FEATURES) assert.ok(f.label && f.desc, `${f.key} 缺少文案`);

  assert.equal(isFeatureKey("ai"), true);
  assert.equal(isFeatureKey("nope"), false);
  assert.equal(featureLabel("game"), "游戏大厅");
});

test("默认全部开启；未知开关视为开启", async () => {
  const map = await getFeatureMap({});
  for (const f of FEATURES) assert.equal(map[f.key], true);
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
  await setFeature(env, GLOBAL_SCOPE, "tasks", false);

  let queries = 0;
  const counting = {
    prepare: (sql) => { queries++; return db.prepare(sql); },
    batch: (stmts) => db.batch(stmts)
  };

  const map = await getFeatureMap({ DB: counting }, PRIVATE);
  assert.equal(map.shop, true, "场景覆盖生效");
  assert.equal(map.tasks, false, "全局设置生效");
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
