// ==========================================
// ⚙️ 功能开关
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite } from "../test-helpers/d1.mjs";
import {
  GLOBAL_SCOPE, FEATURES, getFeatureMap, getExplicitSettings,
  isFeatureEnabled, setFeature, clearFeatureOverride, isFeatureKey
} from "../src/services/features.js";

test("默认全部开启，且能识别合法的开关名", async () => {
  const map = await getFeatureMap({});
  for (const f of FEATURES) assert.equal(map[f.key], true, `${f.key} 默认应开启`);

  assert.equal(isFeatureKey("ai"), true);
  assert.equal(isFeatureKey("nope"), false);
  // 未知开关一律视为开启，不误伤
  assert.equal(await isFeatureEnabled({}, "private:1", "nope"), true);
});

test("全局关闭会作用于未单独设置的场景", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  await setFeature(env, GLOBAL_SCOPE, "game", false);
  assert.equal(await isFeatureEnabled(env, "group:-100:user:1", "game"), false);
  assert.equal(await isFeatureEnabled(env, "group:-100:user:1", "ai"), true);

  const map = await getFeatureMap(env, "private:1");
  assert.equal(map.game, false);
  assert.equal(map.checkin, true);
  db.close();
});

test("场景设置优先于全局设置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const scene = "group:-100:user:1";

  await setFeature(env, GLOBAL_SCOPE, "game", false);
  await setFeature(env, scene, "game", true); // 这个群单独打开
  assert.equal(await isFeatureEnabled(env, scene, "game"), true);
  assert.equal(await isFeatureEnabled(env, "group:-200:user:1", "game"), false, "其他群仍跟随全局关闭");

  const sceneOnly = await getExplicitSettings(env, scene);
  assert.deepEqual(sceneOnly, { game: true });

  await clearFeatureOverride(env, scene, "game");
  assert.equal(await isFeatureEnabled(env, scene, "game"), false, "清除覆盖后重新跟随全局");
  db.close();
});

test("一次查询即可同时拿到场景与全局两层设置", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };
  const scene = "private:1";

  await setFeature(env, GLOBAL_SCOPE, "tasks", false);
  await setFeature(env, scene, "tasks", true);
  await setFeature(env, GLOBAL_SCOPE, "shop", false);

  let queries = 0;
  const original = db.prepare;
  const env2 = { DB: { prepare: (sql) => { queries++; return original(sql); }, batch: db.batch } };

  const map = await getFeatureMap(env2, scene);
  assert.equal(map.tasks, true, "场景覆盖生效");
  assert.equal(map.shop, false, "全局设置生效");
  assert.equal(queries, 1, "应只查一次数据库");
  db.close();
});

test("setFeature / clearFeatureOverride 的边界处理", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  const env = { DB: db };

  assert.equal(await setFeature(env, GLOBAL_SCOPE, "not-a-feature", false), false);
  assert.equal(await setFeature(env, "", "ai", false), false);
  assert.equal(await setFeature(env, GLOBAL_SCOPE, "ai", false), true);
  assert.equal(db.count("scene_settings"), 1);

  // 重复设置只更新，不新增行
  await setFeature(env, GLOBAL_SCOPE, "ai", true);
  assert.equal(db.count("scene_settings"), 1);
  assert.equal(await isFeatureEnabled(env, "private:1", "ai"), true);
  db.close();
});
