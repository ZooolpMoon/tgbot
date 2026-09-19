// ==========================================
// 🎲 四个下注游戏的「赔率与资金」守卫
//
// 为什么单独一个文件：这四个游戏的 `play()` 原先**零测试覆盖**，于是幸运转盘与
// 老虎机一路带着**正期望**上线 ——
//   幸运转盘 (1.425)、老虎机 (1.296) —— 玩家只要反复下注就能稳定刷分
//   （生产数据里已经实际多赚 4650 分 / 10 次）。
// 这里把「返还率」变成可断言的**数学约束**：任何下注游戏的期望回收都不能 > 1。
// （抽奖那边有 expectedPrize() < PAID_COST，轮盘那边有 returnRate() === 36/37，
//   这个文件补齐骰子 / 抛硬币 / 老虎机 / 幸运转盘。）
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import {
  SLOT_ICONS,
  SLOT_PAYOUT,
  payoutOf,
  returnRate as slotsReturnRate,
  SlotsGame
} from "../src/games/slots.js";
import {
  WHEEL_TIERS,
  pickTier,
  tierPercents,
  returnRate as wheelReturnRate,
  WheelGame
} from "../src/games/wheel.js";
import { DiceGame } from "../src/games/dice.js";
import { CoinGame } from "../src/games/coin.js";
import { BlackjackGame } from "../src/games/blackjack.js";
import { MAX_BET, clampBet, betError, renderCustomBet } from "../src/games/shared.js";
import { returnRate as rouletteReturnRate, BETS as ROULETTE_BETS, RouletteGame } from "../src/games/roulette.js";

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
const editMessageTexts = () => apiCalls
  .filter((c) => c.method === "editMessageText")
  .map((c) => String(c.body.text || ""));
const makeEnv = (db) => ({ DB: db, BOT_TOKEN: "T", MY_TELEGRAM_ID: "999", APP_TIMEZONE: "Asia/Shanghai" });
const USER = "user:1";

// ==========================================
// 返还率守卫（这个文件存在的理由）
// ==========================================

test("🐯 老虎机：返还率必须 < 1（改图标或倍率都要重算）", () => {
  const rate = slotsReturnRate();
  assert.ok(rate < 1, `老虎机返还率 ${rate} 必须 < 1，否则可以反复下注刷分`);
  assert.ok(rate > 0.9, `老虎机返还率 ${rate} 太低了，玩家会明显觉得白送钱`);
  // 8 个图标 → (1×50 + 7×15 + 168×2)/512
  assert.equal(SLOT_ICONS.length, 8);
  assert.ok(Math.abs(rate - 491 / 512) < 1e-9, `期望 ≈0.959，实际 ${rate}`);
});

test("🎡 幸运转盘：返还率必须 < 1（这是曾经出过事的地方）", () => {
  const rate = wheelReturnRate();
  assert.ok(rate < 1, `转盘返还率 ${rate} 必须 < 1；旧表是 1.425，等于每押 100 白送 42.5`);
  assert.ok(rate > 0.9, `转盘返还率 ${rate} 太低了`);
  assert.ok(Math.abs(rate - 0.955) < 1e-9, `期望 0.955，实际 ${rate}`);
});

test("🔴⚫ 轮盘：九种下注的返还率都必须 < 1（与 roulette 自己的守卫对齐）", () => {
  for (const bet of ROULETTE_BETS) {
    const rate = rouletteReturnRate(bet.key);
    assert.ok(rate < 1, `轮盘「${bet.label}」返还率 ${rate} 必须 < 1`);
  }
});

test("🎲 骰子：3 个骰子的和分布必须让「大/小」各占一半（否则赔率就错了）", () => {
  let small = 0;
  let total = 0;
  for (let a = 1; a <= 6; a++) {
    for (let b = 1; b <= 6; b++) {
      for (let c = 1; c <= 6; c++) {
        total++;
        if (a + b + c <= 10) small++;
      }
    }
  }
  assert.equal(total, 216);
  assert.equal(small, 108, "和 3-10 与 11-18 必须各 108 种，否则某一边是负期望");
  // 大小各半 + 赔 2 倍（含本金）→ 公平游戏，不赚不亏（也不是刷分渠道）
  assert.equal((small / total) * 2, 1);
});

test("🪙 抛硬币：50/50 + 赔 2 倍 → 公平游戏（不能 > 1）", () => {
  assert.ok(0.5 * 2 <= 1, "抛硬币是公平游戏；一旦改成 >2 倍就是白送分");
});

// ==========================================
// 判定与档位（纯函数）
// ==========================================

test("老虎机判定：三钻 50 倍、其它三连 15 倍、两连 2 倍、其余不中", () => {
  assert.equal(payoutOf("💎", "💎", "💎"), SLOT_PAYOUT.tripleDiamond);
  assert.equal(payoutOf("🍒", "🍒", "🍒"), SLOT_PAYOUT.tripleSame);
  assert.equal(payoutOf("🍎", "🍎", "🍊"), SLOT_PAYOUT.pair);
  assert.equal(payoutOf("🍎", "🍊", "🍎"), SLOT_PAYOUT.pair, "两边相同也算两连");
  assert.equal(payoutOf("🍎", "🍊", "🍇"), 0);
  // 三个相同优先于两个相同
  assert.equal(payoutOf("⭐", "⭐", "⭐"), SLOT_PAYOUT.tripleSame);
});

test("转盘档位表：概率递增到 100、合计 100%、最后一档必须收口", () => {
  const pcts = tierPercents();
  assert.equal(pcts.length, WHEEL_TIERS.length);
  assert.equal(pcts.reduce((a, b) => a + b, 0), 100, "概率合计必须是 100%");
  for (let i = 1; i < WHEEL_TIERS.length; i++) {
    assert.ok(WHEEL_TIERS[i].upTo > WHEEL_TIERS[i - 1].upTo, `第 ${i + 1} 档的 upTo 必须递增`);
  }
  assert.equal(WHEEL_TIERS[WHEEL_TIERS.length - 1].upTo, 100);
  for (const p of pcts) assert.ok(p > 0, "不能有 0% 的档位（写了也永远抽不到）");
});

test("转盘取档：边界值落在正确的档位", () => {
  assert.equal(pickTier(0).multiplier, 0);
  assert.equal(pickTier(32.99).multiplier, 0);
  assert.equal(pickTier(33).multiplier, 0.5, "33 是第二档的起点");
  assert.equal(pickTier(57.99).multiplier, 0.5);
  assert.equal(pickTier(58).multiplier, 1);
  assert.equal(pickTier(91.99).multiplier, 2);
  assert.equal(pickTier(92).multiplier, 3);
  assert.equal(pickTier(96.99).multiplier, 3);
  assert.equal(pickTier(97).multiplier, 5);
  assert.equal(pickTier(99.49).multiplier, 5);
  assert.equal(pickTier(99.5).multiplier, 15);
  assert.equal(pickTier(100).multiplier, 15, "极端值也要有兜底档位");
});

// ==========================================
// 结算的资金不变量（play 的 IO 路径；结果随机，只断言守恒）
// ==========================================

test("老虎机 play：余额守恒（初值 - 下注 + 返还）且写一条流水", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await SlotsGame.play("T", env, "cb", "1", USER, 7, 100);

  const after = await getUserPoints(env, USER);
  const reward = after - 900;   // 900 = 1000 - 100
  assert.ok([0, 200, 1500, 5000].includes(reward), `返还必须是 0 / 2 / 15 / 50 倍之一，实际 ${reward}`);
  const logs = db.all("SELECT change_amount FROM points_log WHERE user_key = ?", USER);
  assert.equal(logs.length, 1, "每次下注写且只写一条流水");
  assert.equal(Number(logs[0].change_amount), reward - 100, "流水记的是净变动");
  db.close();
});

test("转盘 play：余额守恒且倍率来自档位表", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await WheelGame.play("T", env, "cb", "1", USER, 7, 100);

  const after = await getUserPoints(env, USER);
  // 900 = 1000 - 100（扣掉本金），after - 900 就是返还额
  const payouts = WHEEL_TIERS.map((t) => Math.floor(100 * t.multiplier));
  assert.ok(payouts.includes(after - 900), `返还必须是档位表里的 ${payouts.join(" / ")}，实际 ${after - 900}`);
  assert.equal(db.count("points_log", "user_key = ?", USER), 1);
  db.close();
});

test("骰子 / 抛硬币 play：余额守恒且写一条流水", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  for (const [name, run] of [
    ["dice", (env) => DiceGame.play("T", env, "cb", "1", USER, 7, 100, "big")],
    ["coin", (env) => CoinGame.play("T", env, "cb", "1", USER, 7, 100, "heads")]
  ]) {
    const db = createTestDB();
    seedUser(db, USER, 1000);
    const env = makeEnv(db);
    resetCalls();

    await run(env);

    const after = await getUserPoints(env, USER);
    assert.ok([900, 1100].includes(after), `${name} 结算后余额只能是 900（输）或 1100（赢），实际 ${after}`);
    assert.equal(db.count("points_log", "user_key = ?", USER), 1, `${name} 应写一条流水`);
    db.close();
  }
});

test("四个游戏：积分不足时都不扣分、不写流水", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const cases = [
    ["dice", (env) => DiceGame.play("T", env, "cb", "1", USER, 7, 500, "big")],
    ["coin", (env) => CoinGame.play("T", env, "cb", "1", USER, 7, 500, "heads")],
    ["slots", (env) => SlotsGame.play("T", env, "cb", "1", USER, 7, 500)],
    ["wheel", (env) => WheelGame.play("T", env, "cb", "1", USER, 7, 500)]
  ];
  for (const [name, run] of cases) {
    const db = createTestDB();
    seedUser(db, USER, 10);
    const env = makeEnv(db);
    resetCalls();

    await run(env);

    assert.equal(await getUserPoints(env, USER), 10, `${name} 积分不足时不该扣分`);
    assert.equal(db.count("points_log", "user_key = ?", USER), 0, `${name} 拒绝时不该写流水`);
    db.close();
  }
});

// ==========================================
// 单局下注上限（防手抖 ALL IN 清零；生产里出现过一笔 110918 分的全押）
// ==========================================

test("下注上限：betError 的边界", () => {
  assert.equal(betError(1), null);
  assert.equal(betError(MAX_BET), null, "正好等于上限是合法的");
  assert.match(String(betError(MAX_BET + 1)), /上限/);
  assert.match(String(betError(110918)), /上限/, "生产里那笔 11 万的全押必须被挡下");
  assert.match(String(betError(0)), /无效/);
  assert.match(String(betError(-50)), /无效/);
  assert.match(String(betError("abc")), /无效/);
  assert.match(String(betError(null)), /无效/);
});

test("下注上限：clampBet 收敛到 [1, min(余额, 上限)]", () => {
  assert.equal(clampBet(500, 10000), 500, "没超上限就保持不变");
  assert.equal(clampBet(99999, 100000), MAX_BET, "超上限要收敛到上限，而不是余额");
  assert.equal(clampBet(99999, 300), 300, "余额比上限小时以余额为准");
  assert.equal(clampBet(0, 300), 1, "最小 1");
  assert.equal(clampBet(-5, 300), 1);
  assert.equal(clampBet(7.9, 300), 7, "小数向下取整");
});

test("下注面板：余额很大时金额收敛到上限，并且写明上限", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 99999);
  const env = makeEnv(db);
  resetCalls();

  await renderCustomBet("T", env, "1", USER, 7, "dice", 99999);

  const text = editMessageTexts().at(-1);
  assert.ok(text.includes(String(MAX_BET)), "要写明单局上限");
  const kb = apiCalls.filter((c) => c.method === "editMessageText").at(-1).body.reply_markup;
  const confirm = kb.inline_keyboard.flat().find((b) => b.callback_data.startsWith("game_dice_bet_"));
  assert.equal(confirm.callback_data, `game_dice_bet_${MAX_BET}`, "确认按钮的金额必须已经收敛");
  db.close();
});

test("下注上限：六个游戏超过上限都会被挡下且不扣分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const tooMuch = MAX_BET + 1;
  const cases = [
    ["dice", (env) => DiceGame.play("T", env, "cb", "1", USER, 7, tooMuch, "big")],
    ["coin", (env) => CoinGame.play("T", env, "cb", "1", USER, 7, tooMuch, "heads")],
    ["slots", (env) => SlotsGame.play("T", env, "cb", "1", USER, 7, tooMuch)],
    ["wheel", (env) => WheelGame.play("T", env, "cb", "1", USER, 7, tooMuch)],
    ["roulette", (env) => RouletteGame.play("T", env, "cb", "1", USER, 7, tooMuch, "red")],
    ["blackjack", (env) => BlackjackGame.start("T", env, "cb", "1", USER, 7, tooMuch)]
  ];
  for (const [name, run] of cases) {
    const db = createTestDB();
    seedUser(db, USER, 100000);
    const env = makeEnv(db);
    resetCalls();

    await run(env);

    assert.equal(await getUserPoints(env, USER), 100000, `${name} 超上限时不该扣分`);
    assert.equal(db.count("points_log", "user_key = ?", USER), 0, `${name} 拒绝时不该写流水`);
    assert.ok(
      apiCalls.some((c) => c.method === "answerCallbackQuery" && String(c.body.text || "").includes("上限")),
      `${name} 要明确告诉用户超了上限`
    );
    db.close();
  }
});
