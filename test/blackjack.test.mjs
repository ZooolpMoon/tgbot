// ==========================================
// 🃏 21 点（AI 庄家）测试
//
// 覆盖：点数计算（A 软硬）、Blackjack / 爆牌判定、庄家要牌规则、
//       结算赔付（3:2、平局、庄家爆）、开局扣分与牌局落库、
//       要牌 / 停牌 / 双倍（含重复点击不重复扣分）、
//       结算后旧按钮失效、超时退款、AI 台词清洗与回退、菜单排版。
//
// 可测性的关键：牌堆**存在会话里**，测试直接塞一副固定牌，发牌结果完全确定。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import {
  handValue,
  isSoft,
  isBlackjack,
  isBust,
  dealerShouldHit,
  settleRound,
  buildDeck,
  formatHand,
  BlackjackGame
} from "../src/games/blackjack.js";
import { dealerLine, sanitizeLine, pickFallbackLine, FALLBACK_LINES } from "../src/games/blackjack-ai.js";
import { getGameCenterKeyboard, renderGameCenter } from "../src/games/index.js";
import { cleanupStaleData } from "../src/services/daily.js";

// ---- Telegram API 桩 ----
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
const editedTexts = () => apiCalls.filter((c) => c.method === "editMessageText").map((c) => String(c.body.text || ""));
const lastEdited = () => editedTexts().at(-1) || "";
const answerTexts = () => apiCalls.filter((c) => c.method === "answerCallbackQuery").map((c) => String(c.body.text || ""));

const makeEnv = (db, extra = {}) => ({
  DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai", ...extra
});

const USER = "user:1";
const CHAT = "1";

/**
 * 造一局「已经开好」的牌：写入会话并把本金扣掉，
 * 这样状态与真实流程（开局先扣分）一致，断言余额才准。
 * deck 的**末尾**是最先发出的牌（抽牌用 pop）。
 */
function seedSession(db, {
  chatId = CHAT, userKey = USER, bet = 50, doubled = 0,
  player = ["10♠", "7♥"], dealer = ["9♣", "8♦"], deck = ["2♠", "3♥"]
} = {}) {
  db.exec(
    `INSERT OR REPLACE INTO blackjack_sessions (chat_id, user_key, bet, player, dealer, deck, doubled, status)
     VALUES ('${chatId}','${userKey}',${bet},'${JSON.stringify(player)}','${JSON.stringify(dealer)}','${JSON.stringify(deck)}',${doubled},'playing')`
  );
  db.exec(`UPDATE users SET points = points - ${bet} WHERE user_key = '${userKey}'`);
}

/** 一副固定牌：末尾依次弹出 player[0]、player[1]、dealer[0]、dealer[1] */
const fixedDeck = (player, dealer) => ["2♠", "3♥", dealer[1], dealer[0], player[1], player[0]];

// ==========================================
// 纯逻辑
// ==========================================

test("点数：A 自动取不爆的最大值", () => {
  assert.equal(handValue(["A♠", "6♥"]), 17, "A 当 11");
  assert.equal(handValue(["A♠", "6♥", "K♦"]), 17, "爆了就降为 1");
  assert.equal(handValue(["A♠", "A♥", "9♦"]), 21);
  assert.equal(handValue(["A♠", "A♥", "A♦", "8♣"]), 21);
  assert.equal(handValue(["A♠", "A♥"]), 12, "两个 A 只能算 12");
  assert.equal(handValue(["K♠", "Q♥", "J♦"]), 30);
  assert.equal(handValue(["10♠", "7♥"]), 17);
  assert.equal(handValue([]), 0);
});

test("软牌判定：还有 A 当 11 用才算软", () => {
  assert.equal(isSoft(["A♠", "6♥"]), true);
  assert.equal(isSoft(["A♠", "6♥", "K♦"]), false);
  assert.equal(isSoft(["10♠", "7♥"]), false);
});

test("Blackjack 与爆牌：只有首两张 21 点才算 Blackjack", () => {
  assert.equal(isBlackjack(["A♠", "K♥"]), true);
  assert.equal(isBlackjack(["7♠", "7♥", "7♦"]), false, "三张凑 21 不是 Blackjack");
  assert.equal(isBlackjack(["10♠", "9♥"]), false);
  assert.equal(isBust(["K♠", "Q♥", "5♦"]), true);
  assert.equal(isBust(["K♠", "Q♥"]), false);
});

test("庄家规则：不足 17 点必须继续要牌，软 17 也停", () => {
  assert.equal(dealerShouldHit(["9♣", "5♦"]), true, "14 点要牌");
  assert.equal(dealerShouldHit(["A♠", "5♦"]), true, "软 16 要牌");
  assert.equal(dealerShouldHit(["9♣", "8♦"]), false, "17 点停牌");
  assert.equal(dealerShouldHit(["A♠", "6♦"]), false, "软 17 也停");
  assert.equal(dealerShouldHit(["10♣", "9♦"]), false);
});

test("结算：Blackjack 赔 3:2、平局退本、庄家爆牌算玩家赢", () => {
  const bet = 100;
  // 玩家爆牌
  assert.deepEqual(
    (({ outcome, payout }) => ({ outcome, payout }))(settleRound({ player: ["K♠", "Q♥", "5♦"], dealer: ["9♣", "8♦"], bet })),
    { outcome: "lose", payout: 0 }
  );
  // 玩家 Blackjack
  assert.equal(settleRound({ player: ["A♠", "K♥"], dealer: ["9♣", "8♦"], bet }).payout, 250);
  assert.equal(settleRound({ player: ["A♠", "K♥"], dealer: ["9♣", "8♦"], bet }).outcome, "blackjack");
  // 奇数下注不会算出小数积分
  const odd = settleRound({ player: ["A♠", "K♥"], dealer: ["9♣", "8♦"], bet: 5 });
  assert.equal(odd.payout, 5 + 7);
  assert.equal(Number.isInteger(odd.payout), true);
  // 双方 Blackjack → 平局
  assert.equal(settleRound({ player: ["A♠", "K♥"], dealer: ["A♣", "Q♦"], bet }).outcome, "push");
  // 庄家 Blackjack
  assert.equal(settleRound({ player: ["10♠", "9♥"], dealer: ["A♣", "Q♦"], bet }).outcome, "lose");
  // 庄家爆牌
  assert.equal(settleRound({ player: ["10♠", "8♥"], dealer: ["K♣", "Q♦", "5♠"], bet }).outcome, "win");
  // 比大小
  assert.equal(settleRound({ player: ["10♠", "9♥"], dealer: ["9♣", "8♦"], bet }).outcome, "win");
  assert.equal(settleRound({ player: ["10♠", "6♥"], dealer: ["9♣", "8♦"], bet }).outcome, "lose");
  assert.equal(settleRound({ player: ["10♠", "8♥"], dealer: ["9♣", "9♦"], bet }).outcome, "push");
});

test("洗牌：一副 52 张且不重复", () => {
  const deck = buildDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52, "同一副牌里不能有重复牌");
  for (const card of deck) assert.match(card, /^(A|[2-9]|10|J|Q|K)[♠♥♦♣]$/);
});

test("手牌展示：hideSecond 时第二张换成暗牌", () => {
  assert.equal(formatHand(["9♣", "8♦"]), "9♣ 8♦");
  assert.equal(formatHand(["9♣", "8♦"], { hideSecond: true }), "9♣ 🎴");
});

// ==========================================
// 开局
// ==========================================

test("开局：扣本金、牌局落库、庄家第二张是暗牌", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await BlackjackGame.start("T", env, "cb", CHAT, USER, 7, 50, fixedDeck(["10♠", "7♥"], ["9♣", "8♦"]));

  assert.equal(await getUserPoints(env, USER), 950, "开局先扣本金");
  assert.equal(db.count("blackjack_sessions"), 1);

  const text = lastEdited();
  assert.ok(text.includes("🎴"), "还没停牌时庄家第二张必须是暗牌");
  assert.ok(text.includes("9♣"), "庄家明牌要显示");
  assert.ok(text.includes("17"), "玩家点数要显示");
  db.close();
});

test("开局：积分不足直接拒绝，不写牌局、不扣分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 10);
  const env = makeEnv(db);
  resetCalls();

  await BlackjackGame.start("T", env, "cb", CHAT, USER, 7, 50);

  assert.equal(await getUserPoints(env, USER), 10);
  assert.equal(db.count("blackjack_sessions"), 0);
  assert.ok(answerTexts().some((t) => t.includes("积分不足")));
  db.close();
});

test("开局：已有没打完的牌局时不重复扣分，直接把牌桌再显示一遍", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 50, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"] });
  resetCalls();

  await BlackjackGame.start("T", env, "cb", CHAT, USER, 7, 100);

  assert.equal(await getUserPoints(env, USER), 950, "只应保留第一次的扣分");
  assert.ok(answerTexts().some((t) => t.includes("没打完")));
  db.close();
});

test("开局：玩家首两张 21 点（Blackjack）直接结算，赔 3:2", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await BlackjackGame.start("T", env, "cb", CHAT, USER, 7, 50, fixedDeck(["A♠", "K♥"], ["9♣", "8♦"]));

  // 1000 - 50 本金 + (50 + 75) 赔付 = 1075
  assert.equal(await getUserPoints(env, USER), 1075);
  assert.equal(db.count("blackjack_sessions"), 0, "直接结算，不留下进行中的牌局");
  assert.ok(lastEdited().includes("Blackjack"));
  db.close();
});

// ==========================================
// 要牌 / 停牌
// ==========================================

test("要牌：牌数增加、点数更新，没爆就继续打", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { player: ["10♠", "2♥"], dealer: ["9♣", "8♦"], deck: ["3♥", "5♦"] });
  resetCalls();

  await BlackjackGame.hit("T", env, "cb", CHAT, USER, 7);

  const row = db.get("SELECT player FROM blackjack_sessions WHERE user_key = ?", USER);
  assert.deepEqual(JSON.parse(row.player), ["10♠", "2♥", "5♦"], "应该只多一张牌");
  assert.equal(db.count("blackjack_sessions"), 1, "没爆就继续");
  assert.ok(lastEdited().includes("17"));
  db.close();
});

test("要牌：爆牌立即结算，本金归庄家", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 50, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"], deck: ["3♥", "5♦"] });
  resetCalls();

  await BlackjackGame.hit("T", env, "cb", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), 950, "爆牌后本金不退");
  assert.equal(db.count("blackjack_sessions"), 0);
  assert.ok(lastEdited().includes("你输了"));
  db.close();
});

test("停牌：庄家补到 17 点停牌，点数大的赢", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  // 玩家 18；庄家 14 → 必须补一张 3♠ 到 17 后停牌 → 玩家赢
  seedSession(db, { bet: 50, player: ["10♠", "8♥"], dealer: ["9♣", "5♦"], deck: ["3♥", "3♠"] });
  resetCalls();

  await BlackjackGame.stand("T", env, "cb", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), 1050, "赢了连本带利 2 倍");
  assert.equal(db.count("blackjack_sessions"), 0);
  const text = lastEdited();
  assert.ok(text.includes("3♠"), "结算卡片要亮出庄家补的牌");
  assert.ok(text.includes("你赢了"));
  db.close();
});

test("停牌：庄家爆牌玩家赢，点数相同退回本金", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  // 庄家 16 → 补 K♠ 爆牌
  seedSession(db, { bet: 50, player: ["10♠", "7♥"], dealer: ["9♣", "7♦"], deck: ["2♥", "K♠"] });
  resetCalls();
  await BlackjackGame.stand("T", env, "cb", CHAT, USER, 7);
  assert.equal(await getUserPoints(env, USER), 1050, "庄家爆牌 = 玩家赢");
  assert.ok(lastEdited().includes("庄家爆牌"));

  // 平局：双方都是 18
  const db2 = createTestDB();
  seedUser(db2, USER, 1000);
  const env2 = makeEnv(db2);
  seedSession(db2, { bet: 50, player: ["10♠", "8♥"], dealer: ["9♣", "9♦"] });
  resetCalls();
  await BlackjackGame.stand("T", env2, "cb", CHAT, USER, 7);
  assert.equal(await getUserPoints(env2, USER), 1000, "平局退回本金，净变动 0");
  assert.ok(lastEdited().includes("平局"));
  db.close();
  db2.close();
});

// ==========================================
// 双倍下注
// ==========================================

test("双倍：本金翻倍、只补一张牌、自动走完庄家回合", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  // 玩家 11 双倍拿 10♦ 到 21；庄家 17 停牌 → 玩家赢
  seedSession(db, { bet: 50, player: ["5♠", "6♥"], dealer: ["9♣", "8♦"], deck: ["3♥", "10♦"] });
  resetCalls();

  await BlackjackGame.double("T", env, "cb", CHAT, USER, 7);

  // 1000 - 50（开局） - 50（双倍） + 200（赢 2 倍本金）= 1100
  assert.equal(await getUserPoints(env, USER), 1100);
  assert.equal(db.count("blackjack_sessions"), 0, "双倍后自动结算");
  const text = lastEdited();
  assert.ok(text.includes("21"), "补牌后 21 点");
  assert.ok(text.includes("200") || text.includes("+100"), "按翻倍后的本金结算");
  db.close();
});

test("双倍：已经双倍过就不再扣分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 100, doubled: 1, player: ["5♠", "6♥"], dealer: ["9♣", "8♦"] });
  resetCalls();

  await BlackjackGame.double("T", env, "cb", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), 900, "不应再扣第二份本金");
  assert.ok(answerTexts().some((t) => t.includes("已经双倍")));
  db.close();
});

test("双倍：积分不够时拒绝，牌局保持原样", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 60);
  const env = makeEnv(db);
  seedSession(db, { bet: 50, player: ["5♠", "6♥"], dealer: ["9♣", "8♦"] });
  resetCalls();

  await BlackjackGame.double("T", env, "cb", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), 10, "双倍的那份没扣成");
  assert.equal(db.count("blackjack_sessions"), 1, "牌局还在，可以改成停牌");
  assert.ok(answerTexts().some((t) => t.includes("积分不足")));
  db.close();
});

// ==========================================
// 边界：结束后的旧按钮、超时退款
// ==========================================

test("结算之后旧按钮失效：提示没有进行中的牌局", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await BlackjackGame.hit("T", env, "cb", CHAT, USER, 7);

  assert.ok(answerTexts().some((t) => t.includes("没有进行中的牌局")));
  db.close();
});

// ==========================================
// 并发 / 连点（结算必须先原子抢占，否则会重复发奖）
// ==========================================

test("连点：同一局「停牌」点两次只结算一次", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  // 玩家 18 打庄家 17，第一次必赢
  seedSession(db, { bet: 50, player: ["10♠", "8♥"], dealer: ["9♣", "8♦"] });

  await BlackjackGame.stand("T", env, "cb1", CHAT, USER, 7);
  const afterFirst = await getUserPoints(env, USER);
  assert.equal(afterFirst, 1050, "第一次正常结算");

  // 连点的第二次：会话已经被抢走，不能再发一次奖
  resetCalls();
  await BlackjackGame.stand("T", env, "cb2", CHAT, USER, 7);
  await BlackjackGame.hit("T", env, "cb3", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), afterFirst, "第二次绝不能重复发奖");
  assert.equal(db.count("points_log", "user_key = ?", USER), 1, "流水也只该有一条");
  db.close();
});

test("并发抢结算权：会话被另一个请求删掉后，本请求不再发奖", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 50, player: ["10♠", "8♥"], dealer: ["9♣", "8♦"] });

  // 模拟「另一个并发请求刚刚执行完原子抢占（DELETE ... WHERE status='playing'）」
  db.exec("DELETE FROM blackjack_sessions WHERE status = 'playing'");
  resetCalls();

  await BlackjackGame.stand("T", env, "cb", CHAT, USER, 7);

  assert.equal(await getUserPoints(env, USER), 950, "本金照旧扣着，但这一局不该再发奖");
  assert.ok(answerTexts().some((t) => t.includes("没有进行中的牌局")), "要明确告诉用户这局已经没了");
  db.close();
});

test("并发双击「确认下注」：插不进去的那一份本金必须退回", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);

  // 构造「两个请求同时读到没有牌局」的那一瞬间：
  // 库里有一条**已过 30 分钟有效期**的会话 —— loadSession 看不见它（所以不会提前返回），
  // 但主键还在，insertSession 必然冲突失败。
  seedSession(db, { bet: 50, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"] });
  db.exec("UPDATE blackjack_sessions SET updated_at = datetime('now','-31 minutes')");
  assert.equal(await getUserPoints(env, USER), 950, "seed 时已扣掉第一份本金");

  resetCalls();
  await BlackjackGame.start("T", env, "cb", CHAT, USER, 7, 100);

  assert.equal(await getUserPoints(env, USER), 950, "第二份 100 必须退回来，不能扣了分却没有牌局");
  const log = db.get("SELECT reason FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT 1", USER);
  assert.match(String(log.reason), /重复开局退款/);
  db.close();
});

test("牌局卡片：进行中不显示总点数，避免泄漏暗牌", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { player: ["10♠", "7♥"], dealer: ["9♣", "8♦"] });
  resetCalls();

  await BlackjackGame.renderMain("T", env, CHAT, USER, 7);

  const text = lastEdited();
  assert.ok(text.includes("🎴"), "庄家暗牌要盖住");
  assert.ok(/庄家：<\/b> 9♣ 🎴\n/.test(text), "庄家那一行只能有明牌，不能出现点数合计");
  db.close();
});

test("超时退款：30 分钟没动作的牌局退还本金并删除", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 80, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"] });
  assert.equal(await getUserPoints(env, USER), 920, "开局已扣本金");

  db.exec("UPDATE blackjack_sessions SET updated_at = datetime('now','-31 minutes')");
  const res = await cleanupStaleData(env);

  assert.equal(res.blackjackRefunded, 1);
  assert.equal(res.blackjackSessions, 1);
  assert.equal(await getUserPoints(env, USER), 1000, "本金必须退回");
  assert.equal(db.count("blackjack_sessions"), 0);
  // 流水要留痕，方便对账
  const log = db.get("SELECT reason FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT 1", USER);
  assert.match(String(log.reason), /21 点牌局超时退款/);
  db.close();
});

test("超时退款：还没到 30 分钟的牌局不能被清掉", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  seedSession(db, { bet: 80, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"] });

  const res = await cleanupStaleData(env);

  assert.equal(res.blackjackSessions, 0);
  assert.equal(db.count("blackjack_sessions"), 1);
  assert.equal(await getUserPoints(env, USER), 920);
  db.close();
});

// ==========================================
// AI 台词
// ==========================================

test("AI 台词：没有 AI 绑定时回退内置台词", async () => {
  const line = await dealerLine({ DB: {} }, { player: ["10♠"], dealer: ["9♣"], bet: 10, outcome: "win", reason: "x" });
  assert.ok((FALLBACK_LINES.win || []).includes(line));
});

test("AI 台词：模型报错时回退，不抛异常", async () => {
  const env = {
    DB: {},
    AI: { run: async () => { throw new Error("model down"); } }
  };
  const line = await dealerLine(env, { player: ["10♠"], dealer: ["9♣"], bet: 10, outcome: "lose", reason: "x" });
  assert.ok((FALLBACK_LINES.lose || []).includes(line));
});

test("AI 台词：清洗掉 HTML 与换行，并限制长度", async () => {
  const env = {
    DB: {},
    AI: { run: async () => ({ response: "  <b>嚣张</b>\n的  一句话\n\n要不要再来一局？  " }) }
  };
  const line = await dealerLine(env, { player: ["10♠"], dealer: ["9♣"], bet: 10, outcome: "lose", reason: "x" });
  assert.equal(line, "嚣张 的 一句话 要不要再来一局？");
  assert.ok(!line.includes("<"), "标签必须被清掉");
  assert.ok(!line.includes("\n"));
});

test("AI 台词：只剥「整句被一对引号包住」的情况，句中引用保持原样", () => {
  assert.equal(sanitizeLine('“赢定了”'), "赢定了");
  assert.equal(sanitizeLine("「再来一局」"), "再来一局");
  assert.equal(sanitizeLine('"你输了"'), "你输了");
  assert.equal(sanitizeLine('嚣张地说了句“你输了”'), '嚣张地说了句“你输了”');
  assert.equal(sanitizeLine("“只有半边"), "“只有半边");
  assert.equal(sanitizeLine(""), "");
  assert.equal(sanitizeLine("a".repeat(200)).length, 60, "超长要截断");
});

test("AI 台词：内置台词按结果分类，不会是空的", () => {
  for (const outcome of ["win", "lose", "push", "blackjack", "未知"]) {
    const line = pickFallbackLine(outcome);
    assert.equal(typeof line, "string");
    assert.ok(line.length > 0);
  }
});

test("结算卡片：模型台词里的尖括号会被转义，不会发坏 HTML", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db, {
    AI: { run: async () => ({ response: "21 点不大于 22 < 你懂吗" }) }
  });
  seedSession(db, { bet: 50, player: ["10♠", "7♥"], dealer: ["9♣", "8♦"], deck: ["2♥", "K♠"] });
  resetCalls();

  await BlackjackGame.stand("T", env, "cb", CHAT, USER, 7);

  const text = lastEdited();
  assert.ok(text.includes("&lt;"), "尖括号必须转义成 &lt;");
  db.close();
});

// ==========================================
// 大厅集成与排版
// ==========================================

test("游戏大厅：包含 21 点入口，且排版符合约定", async () => {
  const keyboard = getGameCenterKeyboard();
  const rows = keyboard.inline_keyboard;
  assert.ok(rows.length <= 8, "整个菜单不超过 8 行");
  for (const row of rows) {
    assert.ok(row.length <= 2, "单行最多 2 个按钮");
    for (const btn of row) {
      assert.ok(btn.text.length <= 32, `按钮文案过长：${btn.text}`);
      assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64, `callback_data 过长：${btn.callback_data}`);
    }
  }
  const flat = rows.flat();
  assert.ok(flat.some((b) => b.callback_data === "game_bj_main"), "要有 21 点入口");

  resetCalls();
  await renderGameCenter("T", "1", 7);
  assert.ok(lastEdited().includes("21 点"), "大厅文案要介绍 21 点");
});

test("牌局内键盘：只有首两张、且没双倍过时才给「双倍下注」按钮", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);

  const buttonsOf = () => {
    const kb = apiCalls.filter((c) => c.method === "editMessageText").at(-1)?.body?.reply_markup;
    return (kb?.inline_keyboard || []).flat().map((b) => b.callback_data);
  };

  seedSession(db, { player: ["5♠", "6♥"], dealer: ["9♣", "8♦"] });
  resetCalls();
  await BlackjackGame.renderMain("T", env, CHAT, USER, 7);
  const withDouble = buttonsOf();
  assert.ok(withDouble.includes("game_bj_hit") && withDouble.includes("game_bj_stand"));
  assert.ok(withDouble.includes("game_bj_double"), "首两张可以双倍");

  seedSession(db, { player: ["5♠", "6♥", "2♦"], dealer: ["9♣", "8♦"] });
  resetCalls();
  await BlackjackGame.renderMain("T", env, CHAT, USER, 7);
  assert.ok(!buttonsOf().includes("game_bj_double"), "已经三张牌就不能双倍了");
  db.close();
});
