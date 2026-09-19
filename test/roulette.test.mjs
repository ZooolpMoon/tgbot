// ==========================================
// 🔴⚫ 轮盘赌测试
//
// 覆盖：红黑绿号码表、命中判定（含 0 通杀）、**返还率守卫**、
//       结算金额、开奖扣分与流水、历史记录、键盘排版、大厅集成。
//
// 最重要的那条是「返还率」：所有下注必须 < 1（36/37 ≈ 0.973），
// 否则游戏会变成刷分渠道，把整个积分体系冲垮。
// ==========================================
import test from "node:test";
import assert from "node:assert/strict";
import { createTestDB, hasSqlite, seedUser } from "../test-helpers/d1.mjs";
import { getUserPoints } from "../src/services/users.js";
import {
  BETS,
  RED_NUMBERS,
  HISTORY_MAX,
  colorOf,
  colorDot,
  describeNumber,
  isWinner,
  coverCount,
  returnRate,
  settleRoulette,
  formatHistory,
  getRouletteBetKeyboard,
  getRouletteResultKeyboard,
  RouletteGame
} from "../src/games/roulette.js";
import { getGameCenterKeyboard, renderGameCenter } from "../src/games/index.js";
import { validateKeyboard } from "../src/utils/layout.js";

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

const play = (env, bet, pickKey, number) =>
  RouletteGame.play("T", env, "cb", CHAT, USER, 7, bet, pickKey, null, number);

// ==========================================
// 号码表与判定
// ==========================================

test("号码表：红黑各 18 个，0 是绿色", () => {
  assert.equal(RED_NUMBERS.length, 18, "红色必须是 18 个");
  assert.equal(new Set(RED_NUMBERS).size, 18, "红色不能有重复");
  assert.equal(colorOf(0), "green");
  assert.equal(colorOf(1), "red");
  assert.equal(colorOf(2), "black");
  assert.equal(colorOf(19), "red");
  assert.equal(colorOf(17), "black");

  // 1-36 里红 + 黑正好铺满，且不重叠
  let red = 0, black = 0;
  for (let n = 1; n <= 36; n++) {
    if (colorOf(n) === "red") red++;
    else if (colorOf(n) === "black") black++;
  }
  assert.equal(red, 18);
  assert.equal(black, 18);
  assert.equal(colorDot(0), "🟢");
  assert.equal(colorDot(36), "🔴");
});

test("命中判定：颜色 / 单双 / 大小 / 三打", () => {
  // 颜色
  assert.equal(isWinner("red", 19), true);
  assert.equal(isWinner("red", 17), false);
  assert.equal(isWinner("black", 17), true);
  assert.equal(isWinner("black", 19), false);
  // 单双
  assert.equal(isWinner("odd", 17), true);
  assert.equal(isWinner("even", 17), false);
  assert.equal(isWinner("even", 18), true);
  // 大小（1-18 小 / 19-36 大）
  assert.equal(isWinner("small", 18), true);
  assert.equal(isWinner("small", 19), false);
  assert.equal(isWinner("big", 19), true);
  assert.equal(isWinner("big", 18), false);
  // 三打（每 12 个一组）
  assert.equal(isWinner("dozen1", 1), true);
  assert.equal(isWinner("dozen1", 12), true);
  assert.equal(isWinner("dozen1", 13), false);
  assert.equal(isWinner("dozen2", 13), true);
  assert.equal(isWinner("dozen2", 24), true);
  assert.equal(isWinner("dozen3", 25), true);
  assert.equal(isWinner("dozen3", 36), true);
  // 未知下注一律不算中
  assert.equal(isWinner("nope", 17), false);
});

test("0 通杀所有外围注（庄家优势的来源）", () => {
  for (const bet of BETS) {
    assert.equal(isWinner(bet.key, 0), false, `开 0 时「${bet.label}」不该中`);
  }
});

test("返还率守卫：每种下注都必须小于 1，且正好是 36/37", () => {
  const expected = 36 / 37;
  for (const bet of BETS) {
    const rate = returnRate(bet.key);
    assert.ok(rate < 1, `「${bet.label}」返还率 ${rate} 不能 ≥ 1，否则会变成刷分渠道`);
    assert.ok(
      Math.abs(rate - expected) < 1e-9,
      `「${bet.label}」返还率应为 ${expected}，实际 ${rate}（改赔率后要同步核对覆盖数）`
    );
    assert.equal(coverCount(bet.key), bet.kind === "dozen" ? 12 : 18);
  }
  // 覆盖数 + 赔率算出来必须与「37 格里有 1 格通杀」一致
  assert.equal(BETS.length, 9);
});

test("号码描述：0 不属于单双 / 大小 / 任何一打", () => {
  assert.deepEqual(describeNumber(0), { number: 0, color: "green", parity: null, size: null, dozen: null });
  const n17 = describeNumber(17);
  assert.equal(n17.parity, "odd");
  assert.equal(n17.size, "small", "17 ≤ 18，算小");
  assert.equal(n17.dozen, 2, "17 落在 13-24 这一打");
  const n24 = describeNumber(24);
  assert.equal(n24.color, "black");
  assert.equal(n24.parity, "even");
  assert.equal(n24.size, "big");
  assert.equal(n24.dozen, 2);
});

test("结算金额：1:1 返还 2 倍、2:1 返还 3 倍、未中归零", () => {
  assert.deepEqual(
    (({ win, payout, net }) => ({ win, payout, net }))(settleRoulette({ bet: 100, pickKey: "red", number: 19 })),
    { win: true, payout: 200, net: 100 }
  );
  assert.deepEqual(
    (({ win, payout, net }) => ({ win, payout, net }))(settleRoulette({ bet: 100, pickKey: "dozen1", number: 5 })),
    { win: true, payout: 300, net: 200 }
  );
  assert.deepEqual(
    (({ win, payout, net }) => ({ win, payout, net }))(settleRoulette({ bet: 100, pickKey: "red", number: 17 })),
    { win: false, payout: 0, net: -100 }
  );
  // 开 0：押什么都输
  assert.equal(settleRoulette({ bet: 100, pickKey: "dozen1", number: 0 }).net, -100);
});

// ==========================================
// 开奖流程
// ==========================================

test("开奖：先扣分再转，中了连本带利返还并写流水", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await play(env, 100, "red", 19);   // 19 是红

  assert.equal(await getUserPoints(env, USER), 1100, "1000 - 100 + 200 = 1100");
  const log = db.get("SELECT change_amount, reason FROM points_log WHERE user_key = ? ORDER BY id DESC LIMIT 1", USER);
  assert.equal(Number(log.change_amount), 100, "流水记的是净变动");
  assert.match(String(log.reason), /轮盘.*命中.*19/);

  const text = lastEdited();
  assert.ok(text.includes("19"), "结果卡片要显示中奖号码");
  assert.ok(text.includes("恭喜赢了"));
  assert.ok(text.includes("1100"), "要显示结算后余额");
  assert.ok(answerTexts().some((t) => t.includes("赢")), "回执要报喜");
  db.close();
});

test("开奖：没中就只扣本金，0 通杀也走同一条路", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);

  // 押红开黑
  resetCalls();
  await play(env, 100, "red", 17);
  assert.equal(await getUserPoints(env, USER), 900);
  assert.ok(lastEdited().includes("遗憾未中"));

  // 押红开 0（绿色通杀）
  resetCalls();
  await play(env, 100, "red", 0);
  assert.equal(await getUserPoints(env, USER), 800);
  assert.ok(lastEdited().includes("通杀"), "0 要在卡片里说明是通杀");
  db.close();
});

test("开奖：2:1 的三打按 3 倍本金返还", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);

  await play(env, 50, "dozen3", 30);   // 25-36

  assert.equal(await getUserPoints(env, USER), 1100, "1000 - 50 + 150 = 1100");
  db.close();
});

test("开奖：积分不足直接拒绝，不扣分也不转", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 10);
  const env = makeEnv(db);
  resetCalls();

  await play(env, 50, "red", 19);

  assert.equal(await getUserPoints(env, USER), 10);
  assert.ok(answerTexts().some((t) => t.includes("积分不足")));
  assert.equal(db.count("points_log", "user_key = ?", USER), 0, "拒绝时不该写流水");
  db.close();
});

test("开奖：未知下注类型被挡下，不扣分", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 1000);
  const env = makeEnv(db);
  resetCalls();

  await play(env, 100, "lucky", 19);

  assert.equal(await getUserPoints(env, USER), 1000);
  assert.ok(answerTexts().some((t) => t.includes("未知的下注类型")));
  db.close();
});

// ==========================================
// 历史记录
// ==========================================

test("最近开奖：最新的在最前，最多留 10 期", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 100000);
  const env = makeEnv(db);

  // 连开 12 期，号码 1..12
  for (let n = 1; n <= 12; n++) {
    await play(env, 1, "red", n);
  }

  const raw = db.get("SELECT value FROM scene_settings WHERE scene_key='global' AND name='roulette.history'");
  const history = JSON.parse(raw.value);
  assert.equal(history.length, HISTORY_MAX, `最多保留 ${HISTORY_MAX} 期`);
  assert.equal(history[0], 12, "最新的要在最前面");
  assert.equal(history[HISTORY_MAX - 1], 3, "最旧的被挤掉");
  db.close();
});

test("历史展示：带颜色圆点，空历史有兜底文案", () => {
  assert.equal(formatHistory([]), "（还没有记录）");
  assert.equal(formatHistory([0, 1, 2]), "🟢0 🔴1 ⚫2");
});

// ==========================================
// 界面与排版
// ==========================================

test("键盘排版：选注 / 结果 / 大厅都符合约定", () => {
  for (const kb of [
    getRouletteBetKeyboard(50),
    getRouletteResultKeyboard(50, "red"),
    getGameCenterKeyboard()
  ]) {
    assert.deepEqual(validateKeyboard(kb), [], `排版有问题：${JSON.stringify(validateKeyboard(kb))}`);
  }
});

test("选注键盘：9 种下注都在，且回调带对了金额与类型", () => {
  const flat = getRouletteBetKeyboard(50).inline_keyboard.flat();
  const datas = flat.map((b) => b.callback_data);
  for (const bet of BETS) {
    assert.ok(datas.includes(`game_roulette_play_50_${bet.key}`), `缺少「${bet.label}」按钮`);
  }
  assert.ok(datas.includes("game_roulette_main"), "要有重选金额");
  assert.ok(datas.includes("game_hub"), "要有返回大厅");
});

test("结果键盘：能原样再押一次，也能换押法", () => {
  const flat = getRouletteResultKeyboard(50, "dozen2").inline_keyboard.flat();
  const datas = flat.map((b) => b.callback_data);
  assert.ok(datas.includes("game_roulette_play_50_dozen2"), "再来一把要沿用同样的押法");
  assert.ok(datas.includes("game_roulette_bet_50"), "换押法要回到选注界面且保留金额");
  assert.ok(flat.some((b) => b.text.includes("13-24")), "按钮上要写明押的是什么");
});

test("二级界面：选金额后进入选注界面，卡片里带当前余额与历史", { skip: !hasSqlite && "需要 node:sqlite" }, async () => {
  const db = createTestDB();
  seedUser(db, USER, 777);
  const env = makeEnv(db);
  resetCalls();

  await RouletteGame.renderBetChoice("T", env, CHAT, USER, 7, 50);

  const text = lastEdited();
  assert.ok(text.includes("777"), "要显示余额");
  assert.ok(text.includes("选下注"), "要说明现在在选下注类型");
  assert.ok(text.includes("还没有记录"), "没开过奖时的历史兜底文案");
  db.close();
});

test("游戏大厅：包含轮盘赌入口，文案也介绍了它", async () => {
  const flat = getGameCenterKeyboard().inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === "game_roulette_main"), "大厅要有轮盘赌入口");

  resetCalls();
  await renderGameCenter("T", "1", 7);
  assert.ok(lastEdited().includes("轮盘赌"), "大厅文案要介绍轮盘赌");
});
