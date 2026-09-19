// ==========================================
// 🔴⚫ 游戏：轮盘赌（欧洲轮盘，单零 37 格）
//
// 号码 0-36：0 是绿色，1-36 里红黑各 18 个。
// 下注类型（第一版只做「外围注」，全部返还率 36/37 ≈ 97.3%）：
//   • 红 / 黑、单 / 双、小(1-18) / 大(19-36) —— 18 个号，赔 1:1
//   • 一打 1-12 / 二打 13-24 / 三打 25-36  —— 12 个号，赔 2:1
//
// **庄家优势来自「0 通杀外围注」**：37 格里只有 36 格算外围，
// 所以返还率 = 36/37 ≈ 0.973（1:1 的 18/37×2、2:1 的 12/37×3 都是这个数）。
// 这是数学自带的抽水，不需要像老虎机那样自己调权重 —— 但也意味着
// **改赔率表时必须重算**，test/roulette.test.mjs 里有返还率守卫盯着。
//
// 为什么不做单号 35:1：37 个数字放不进 Telegram 键盘（项目约定整个菜单 ≤ 8 行、
// 每行 ≤ 2 个按钮），而且 1/37 的中奖率下「点三次选号还没中」的体验很差。
// 想要的话可以再做一个分页选号或引导式输入。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { getSetting, setSetting } from "../services/settings.js";
import { LAYOUT } from "../utils/layout.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { randomInt } from "../utils/random.js";
import { logWarn } from "../core/logger.js";
import { getGameMainKeyboard } from "./shared.js";

/** 欧洲轮盘的红色号码（其余 1-36 为黑色，0 为绿色） */
export const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];

/**
 * 下注类型表。
 * payout = 命中时返还的**含本金倍率**（1:1 → 2 倍，2:1 → 3 倍）。
 * 改这里必须同步看 `returnRate()` 与测试里的返还率守卫。
 */
export const BETS = [
  { key: "red", label: "🔴 红", odds: "1:1", payout: 2, kind: "color", value: "red" },
  { key: "black", label: "⚫ 黑", odds: "1:1", payout: 2, kind: "color", value: "black" },
  { key: "odd", label: "单数", odds: "1:1", payout: 2, kind: "parity", value: "odd" },
  { key: "even", label: "双数", odds: "1:1", payout: 2, kind: "parity", value: "even" },
  { key: "small", label: "小 1-18", odds: "1:1", payout: 2, kind: "size", value: "small" },
  { key: "big", label: "大 19-36", odds: "1:1", payout: 2, kind: "size", value: "big" },
  { key: "dozen1", label: "1-12", odds: "2:1", payout: 3, kind: "dozen", value: 1 },
  { key: "dozen2", label: "13-24", odds: "2:1", payout: 3, kind: "dozen", value: 2 },
  { key: "dozen3", label: "25-36", odds: "2:1", payout: 3, kind: "dozen", value: 3 }
];

const BET_MAP = new Map(BETS.map((b) => [b.key, b]));

/** 历史记录（全局共享一份「最近开奖」，只影响展示） */
const HISTORY_KEY = "roulette.history";
export const HISTORY_MAX = 10;

// ==========================================
// 🧮 纯逻辑（无 IO，便于测试）
// ==========================================

/** 号码颜色：0 绿、红号红、其余黑 */
export function colorOf(number) {
  const n = Number(number);
  if (n === 0) return "green";
  return RED_NUMBERS.includes(n) ? "red" : "black";
}

export function colorDot(number) {
  const color = colorOf(number);
  return color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢";
}

/** 转一次：0-36 均匀分布（用加密随机源） */
export function spin() {
  return randomInt(37);
}

/** 号码的结构化描述；0 不属于任何外围注，所以那些字段是 null */
export function describeNumber(number) {
  const n = Number(number);
  const color = colorOf(n);
  if (n === 0) return { number: 0, color, parity: null, size: null, dozen: null };
  return {
    number: n,
    color,
    parity: n % 2 === 1 ? "odd" : "even",
    size: n <= 18 ? "small" : "big",
    dozen: Math.ceil(n / 12)
  };
}

/** 这个下注是否命中该号码 */
export function isWinner(pickKey, number) {
  const bet = BET_MAP.get(String(pickKey));
  if (!bet) return false;
  const n = Number(number);
  // 0 通杀所有外围注 —— 庄家优势就来自这里
  if (n === 0) return false;
  if (bet.kind === "color") return colorOf(n) === bet.value;
  if (bet.kind === "parity") return (n % 2 === 1) === (bet.value === "odd");
  if (bet.kind === "size") return (n <= 18) === (bet.value === "small");
  if (bet.kind === "dozen") return Math.ceil(n / 12) === bet.value;
  return false;
}

/** 该下注覆盖多少个号码（用于算返还率） */
export function coverCount(pickKey) {
  const bet = BET_MAP.get(String(pickKey));
  if (!bet) return 0;
  if (bet.kind === "color" || bet.kind === "parity" || bet.kind === "size") return 18;
  if (bet.kind === "dozen") return 12;
  return 0;
}

/**
 * 返还率 = 覆盖号码数 / 37 × 含本金倍率。
 * 所有下注都应是 36/37 ≈ 0.973（< 1 才有抽水，不能变成刷分渠道）。
 */
export function returnRate(pickKey) {
  const bet = BET_MAP.get(String(pickKey));
  if (!bet) return 0;
  return (coverCount(pickKey) / 37) * bet.payout;
}

/**
 * 结算：返回是否命中、含本金赔付与净变动。
 * @param {{bet:number, pickKey:string, number:number}} opts
 */
export function settleRoulette({ bet, pickKey, number }) {
  const amount = Math.max(0, Math.floor(Number(bet) || 0));
  const table = BET_MAP.get(String(pickKey));
  const win = isWinner(pickKey, number);
  const payout = win ? amount * (table ? table.payout : 0) : 0;
  return {
    win,
    payout,
    net: payout - amount,
    label: table ? table.label : String(pickKey),
    odds: table ? table.odds : "-"
  };
}

/** 最近开奖的展示文案 */
export function formatHistory(numbers) {
  const list = (numbers || []).filter((n) => Number.isInteger(n) && n >= 0 && n <= 36);
  if (list.length === 0) return "（还没有记录）";
  return list.map((n) => `${colorDot(n)}${n}`).join(" ");
}

/** 选注键盘（纯函数，方便排版测试） */
export function getRouletteBetKeyboard(bet) {
  const amt = Math.max(1, Math.floor(Number(bet) || 1));
  const btn = (key) => {
    const b = BET_MAP.get(key);
    return { text: `${b.label} ${b.odds}`, callback_data: `game_roulette_play_${amt}_${key}` };
  };
  return {
    inline_keyboard: [
      [btn("red"), btn("black")],
      [btn("odd"), btn("even")],
      [btn("small"), btn("big")],
      [btn("dozen1"), btn("dozen2")],
      [btn("dozen3"), { text: "🔙 重选金额", callback_data: "game_roulette_main" }],
      [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
    ]
  };
}

/** 开奖后的键盘 */
export function getRouletteResultKeyboard(bet, pickKey) {
  const amt = Math.max(1, Math.floor(Number(bet) || 1));
  const table = BET_MAP.get(String(pickKey));
  const again = table ? `🔄 再押 ${table.label}` : "🔄 再来一把";
  return {
    inline_keyboard: [
      [
        { text: again, callback_data: `game_roulette_play_${amt}_${pickKey}` },
        { text: "🎯 换个押法", callback_data: `game_roulette_bet_${amt}` }
      ],
      [{ text: "💵 改金额", callback_data: "game_roulette_main" }],
      [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
    ]
  };
}

// ==========================================
// 🕘 最近开奖（全局共享，只用于展示）
// ==========================================

async function readHistory(env) {
  try {
    const arr = JSON.parse((await getSetting(env, HISTORY_KEY, "")) || "[]");
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n) && n >= 0 && n <= 36) : [];
  } catch {
    return [];
  }
}

/** 把新号码插到最前，只留最近 HISTORY_MAX 期；失败不影响结算 */
async function pushHistory(env, number) {
  try {
    const list = await readHistory(env);
    await setSetting(env, HISTORY_KEY, JSON.stringify([number, ...list].slice(0, HISTORY_MAX)));
  } catch (e) {
    logWarn("轮盘历史写入失败：", e?.message || e);
  }
}

// ==========================================
// 🎮 对外入口
// ==========================================

export const RouletteGame = {
  /** 主界面：选下注金额 */
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const history = await readHistory(env);
    const text =
      `🔴⚫ <b>轮盘赌</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n` +
      `🕘 <b>近 ${HISTORY_MAX} 期：</b> ${formatHistory(history)}\n\n` +
      `<b>规则说明（欧洲轮盘，0-36 共 37 格）：</b>\n` +
      `• 押 <b>红 / 黑</b>、<b>单 / 双</b>、<b>小(1-18) / 大(19-36)</b>：中了赔 <b>1:1</b>。\n` +
      `• 押 <b>1-12 / 13-24 / 25-36</b>：中了赔 <b>2:1</b>。\n` +
      `• 🟢 <b>0 通杀所有外围注</b>，这就是庄家优势。\n` +
      `• 整体返还率 <b>97.3%</b>。\n\n` +
      `请先选择下注金额：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("roulette", "下注"), "HTML");
  },

  /** 二级界面：选下注类型（下注后立即开奖） */
  async renderBetChoice(token, env, chatId, userKey, messageId, betAmount) {
    const pts = await getUserPoints(env, userKey);
    const history = await readHistory(env);
    const text =
      `🔴⚫ <b>轮盘赌</b> · 选下注\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n` +
      `💵 <b>已选下注：</b> <code>${betAmount}</code>\n` +
      `🕘 <b>近 ${HISTORY_MAX} 期：</b> ${formatHistory(history)}\n\n` +
      `请选择下注类型（<b>点下即开奖</b>）：`;
    return editMessageText(token, chatId, messageId, text, getRouletteBetKeyboard(betAmount), "HTML");
  },

  /**
   * 开奖：先扣分再转盘 —— 扣分失败不会转，保证「不扣钱不开奖」。
   * @param {number} [numberOverride] 仅测试用：直接指定中奖号码
   */
  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, pickKey, sceneKey = null, numberOverride = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);

    const bet = Math.floor(Number(betAmount) || 0);
    if (bet < 1) return answerCallback(token, callbackId, "❌ 下注金额无效！", true);
    if (!BET_MAP.has(String(pickKey))) return answerCallback(token, callbackId, "❌ 未知的下注类型", true);

    const afterDeduct = await tryDeductPoints(env, userKey, bet);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    let balance = afterDeduct;
    const number = Number.isInteger(numberOverride) && numberOverride >= 0 && numberOverride <= 36
      ? numberOverride
      : spin();
    const settled = settleRoulette({ bet, pickKey, number });
    const info = describeNumber(number);

    if (settled.payout > 0) {
      const after = await adjustPoints(env, userKey, settled.payout);
      if (after !== null && after !== undefined) balance = after;
    }
    await logPointChange(
      env, userKey, settled.net, balance,
      `轮盘 ${settled.label} ${settled.win ? "命中" : "未中"} ${colorDot(number)}${number} (下注 ${bet})`
    );
    await pushHistory(env, number);

    const history = await readHistory(env);
    const traits = [
      info.parity === "odd" ? "单" : info.parity === "even" ? "双" : null,
      info.size === "small" ? "小" : info.size === "big" ? "大" : null,
      info.dozen ? `${info.dozen * 12 - 11}-${info.dozen * 12}` : null
    ].filter(Boolean).join(" · ");

    const resultMsg =
      `🔴⚫ <b>轮盘开奖</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🎯 <b>中奖号码：</b> ${colorDot(number)} <b>${number}</b>${traits ? `（${traits}）` : "（绿色，通杀）"}\n` +
      `💬 <b>你的下注：</b> ${settled.label}（${settled.odds}）\n` +
      `🕘 <b>近 ${HISTORY_MAX} 期：</b> ${formatHistory(history)}\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🏆 <b>结算：</b> ${settled.win ? "🎉 恭喜赢了！" : "💸 遗憾未中"}\n` +
      `💰 <b>变动：</b> ${settled.net > 0 ? `+${settled.net}` : settled.net}\n` +
      `🪙 <b>余额：</b> <b>${balance}</b>`;

    await Promise.all([
      answerCallback(
        token, callbackId,
        settled.win ? `🎉 中了 ${colorDot(number)}${number}，赢 ${settled.net} 积分！` : `💸 ${colorDot(number)}${number}，没中`
      ),
      editMessageText(token, chatId, messageId, resultMsg, getRouletteResultKeyboard(bet, pickKey), "HTML")
    ]);
  }
};
