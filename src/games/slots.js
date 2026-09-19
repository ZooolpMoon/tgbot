// ==========================================
// 🎰 游戏：欢乐老虎机
//
// 三个相同 = 15 倍（💎💎💎 = 50 倍），任意两个相同 = 2 倍。
//
// ⚠️ **赔率表的数学约束**：返还率 = 期望回收 / 下注必须 < 1，否则用户可以靠
// 「反复下注」稳定刷分（大数定律下每次净赚一截），把积分体系冲垮。
// 原来 6 个图标时是 `(1×50 + 5×10 + 90×2)/216 ≈ 1.296` —— **正期望**（每押 100
// 平均回收 130），2026-09-19 的代码审查发现并修掉。
// 现在 8 个图标：`(1×50 + 7×15 + 168×2)/512 ≈ 0.959`。
// **改图标数量或倍率都要跑 `test/slots.test.mjs` 里的返还率守卫。**
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { randomInt } from "../utils/random.js";
import { getGameMainKeyboard, betError } from "./shared.js";

/** 转轮图标（8 个；数量决定「三个相同」的概率，改动请重算返还率） */
export const SLOT_ICONS = ["🍎", "🍊", "🍇", "🍒", "🔔", "💎", "⭐", "🍋"];
/** 中奖倍率（含本金） */
export const SLOT_PAYOUT = { tripleDiamond: 50, tripleSame: 15, pair: 2 };

/**
 * 返还率（期望回收 / 下注）。必须 < 1。
 * 概率来自三个转轮独立均匀取图标：三个相同 n/总、恰好两个相同 3n(n-1)/总。
 */
export function returnRate() {
  const n = SLOT_ICONS.length;
  const total = n ** 3;
  const diamond = 1;
  const triple = n - 1;
  const pair = 3 * n * (n - 1);
  return (
    diamond * SLOT_PAYOUT.tripleDiamond +
    triple * SLOT_PAYOUT.tripleSame +
    pair * SLOT_PAYOUT.pair
  ) / total;
}

/** 从三个图标算中奖倍率（纯函数，便于测试与守卫） */
export function payoutOf(r1, r2, r3) {
  if (r1 === r2 && r2 === r3) {
    return r1 === "💎" ? SLOT_PAYOUT.tripleDiamond : SLOT_PAYOUT.tripleSame;
  }
  if (r1 === r2 || r2 === r3 || r1 === r3) return SLOT_PAYOUT.pair;
  return 0;
}

export const SlotsGame = {
  /** 游戏主界面：选下注金额（点下注后立即开奖） */
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🎰 <b>欢乐老虎机</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>赔率说明：</b>\n` +
      `• 💎💎💎 (三个钻石大奖)：<b>${SLOT_PAYOUT.tripleDiamond} 倍</b>\n` +
      `• 🍒🍒🍒 (其它三个相同)：<b>${SLOT_PAYOUT.tripleSame} 倍</b>\n` +
      `• 🍒🍒❔ (任意两个相同)：<b>${SLOT_PAYOUT.pair} 倍</b>\n` +
      `• 其他组合：未中奖\n\n` +
      `请选择下注金额（下注后直接开奖）：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("slots", "拉"), "HTML");
  },

  /** 开奖：先扣分再摇奖，中奖按倍率返还 */
  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, sceneKey = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);
    const badBet = betError(betAmount);
    if (badBet) return answerCallback(token, callbackId, badBet, true);

    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    let currentBalance = afterDeduct;
    const icons = SLOT_ICONS;
    const r1 = icons[randomInt(icons.length)];
    const r2 = icons[randomInt(icons.length)];
    const r3 = icons[randomInt(icons.length)];
    const slotsStr = `[ ${r1} | ${r2} | ${r3} ]`;

    let multiplier = payoutOf(r1, r2, r3);

    let reward = 0;
    if (multiplier > 0) {
      reward = betAmount * multiplier;
      const nb = await adjustPoints(env, userKey, reward);
      currentBalance = nb ?? currentBalance;
      await logPointChange(env, userKey, reward - betAmount, currentBalance, `老虎机中奖 ${multiplier}倍 (下注 ${betAmount})`);
    } else {
      await logPointChange(env, userKey, -betAmount, currentBalance, `老虎机未中奖 (下注 ${betAmount})`);
    }

    const resultMsg =
      `🎰 <b>老虎机开奖</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🎰 <b>结果：</b> <b>${slotsStr}</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🏆 <b>倍率：</b> ${multiplier > 0 ? `🎉 ${multiplier} 倍奖励！` : "💸 未中奖"}\n` +
      `💰 <b>变动：</b> ${multiplier > 0 ? `+${reward}` : `-${betAmount}`}\n` +
      `🪙 <b>余额：</b> <b>${currentBalance}</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🎰 相同金额再拉一次", callback_data: `game_slots_play_${betAmount}` },
          { text: "💵 更改金额", callback_data: "game_slots_main" }
        ],
        [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
      ]
    };

    await Promise.all([
      answerCallback(token, callbackId, multiplier > 0 ? `🎉 中大奖啦！赢取了 ${reward} 积分！` : `💸 没中，再试一次吧！`),
      editMessageText(token, chatId, messageId, resultMsg, keyboard, "HTML")
    ]);
  }
};
