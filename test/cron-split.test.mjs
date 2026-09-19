// ==========================================
// ⏰ cron 的「日级 / 及时型」拆分
//
// 背景（v3.7.0）：原先每 2 分钟的 tick 都会跑一遍「一整天 / 一周 / 一个月才需要
// 一次」的清理，以及 7 条只为日报服务的统计（还都是全表扫描）—— 720 次/天白做。
// 现在拆成：及时型（长延时删除 / 超时牌局退款 / webhook 自愈）每次跑，
// 日级（清理 / 统计 / 索引维护 / 日报）只在 `0 16 * * *` 跑。
//
// 这个文件盯住拆分的**两面**：日报时段确实做了日级维护，
// 而**及时型在任何时段都不能少**（尤其超时牌局退款 —— 那是用户的积分）。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { runScheduledTasks, cleanupTimely, DAILY_SUMMARY_CRON } from "../src/services/daily.js";
import { getUserPoints } from "../src/services/users.js";

let apiCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split("/").pop();
  apiCalls.push({ method, body: opts.body ? JSON.parse(opts.body) : {} });
  return {
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ ok: true, result: { message_id: 7 } })
  };
};

const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai" });
const USER = "user:1";
const EVERY_2_MIN = "*/2 * * * *";

/** 造一条过期的管理员解锁会话（日级清理的目标） */
function seedExpiredAdminSession(db) {
  const past = Math.floor(Date.now() / 1000) - 3600;
  db.exec(`INSERT INTO admin_sessions (chat_id, expires_at) VALUES ('999', ${past})`);
}

/** 造一条「开局 31 分钟没动作」的 21 点牌局（及时型退款的目标），本金已扣 */
function seedStaleBlackjack(db, { bet = 80 } = {}) {
  db.exec(
    `INSERT INTO blackjack_sessions (chat_id, user_key, bet, player, dealer, deck, doubled, status)
     VALUES ('1','${USER}',${bet},'["10♠","7♥"]','["9♣","8♦"]','["2♠"]',0,'playing')`
  );
  db.exec(`UPDATE users SET points = points - ${bet} WHERE user_key = '${USER}'`);
  db.exec("UPDATE blackjack_sessions SET updated_at = datetime('now','-31 minutes')");
}

test("及时型清理：超时牌局退款可以脱离日级单独跑", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedStaleBlackjack(db, { bet: 80 });

  const res = await cleanupTimely(env);

  assert.equal(res.blackjackRefunded, 1);
  assert.equal(res.blackjackSessions, 1);
  assert.equal(await getUserPoints(env, USER), 1000, "本金必须退回来");
  db.close();
});

test("非日报时段：跳过日级维护，但及时型一件都不能少", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedExpiredAdminSession(db);
  seedStaleBlackjack(db, { bet: 80 });
  apiCalls = [];

  const res = await runScheduledTasks(env, "T", null, { cron: EVERY_2_MIN });

  assert.equal(res.skipped, "非日报时段");
  assert.equal(res.notified, false);
  // 及时型照跑：超时牌局的本金退回来了
  assert.equal(res.timely.blackjackRefunded, 1);
  assert.equal(await getUserPoints(env, USER), 1000);
  assert.equal(db.count("blackjack_sessions"), 0);
  // 日级被跳过：过期的管理员会话还躺在库里
  assert.equal(db.count("admin_sessions"), 1, "非日报时段不该做日级清理");
  // 也不该推日报
  assert.equal(apiCalls.filter((c) => String(c.body?.text || "").includes("每日概况")).length, 0);
  db.close();
});

test("日报时段：日级清理与日报照常执行", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedExpiredAdminSession(db);
  seedStaleBlackjack(db, { bet: 80 });
  apiCalls = [];

  const res = await runScheduledTasks(env, "T", null, { cron: DAILY_SUMMARY_CRON });

  assert.equal(res.notified, true);
  assert.ok(res.cleanup, "日报时段要返回日级清理结果");
  assert.equal(db.count("admin_sessions"), 0, "日级清理应把过期会话清掉");
  assert.equal(db.count("blackjack_sessions"), 0);
  assert.equal(await getUserPoints(env, USER), 1000);
  assert.ok(
    apiCalls.some((c) => String(c.body?.text || "").includes("每日概况")),
    "日报时段要推概况"
  );
  db.close();
});

test("日报时段：同一天重复触发不会再推一条（原有去重不能被拆坏）", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);

  await runScheduledTasks(env, "T", null, { cron: DAILY_SUMMARY_CRON });
  apiCalls = [];
  const again = await runScheduledTasks(env, "T", null, { cron: DAILY_SUMMARY_CRON });

  assert.equal(again.notified, false);
  assert.equal(again.skipped, "今日已推送");
  assert.equal(apiCalls.filter((c) => String(c.body?.text || "").includes("每日概况")).length, 0);
  db.close();
});
