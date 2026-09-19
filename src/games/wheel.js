// ==========================================
// 🎡 游戏：幸运转盘
//
// 倍率分布见 `WHEEL_TIERS`（33% ×0 / 25% ×0.5 / 20% ×1 / 14% ×2 / 5% ×3 /
// 2.5% ×5 / 0.5% ×15），返还率 ≈ 0.955。
//
// ⚠️ **赔率表的数学约束**：返还率必须 < 1，否则用户可以靠「反复下注」稳定刷分。
// 原来的分布（30%×0 / 25%×0.5 / 20%×1 / 15%×2 / 8%×5 / 1.5%×10 / 0.5%×50）
// 算出来是 **1.425** —— 每押 100 平均回收 142.5，属于正期望漏洞，
// 2026-09-19 的代码审查发现并修掉（生产数据里已实际多赚了 4650 分）。
// **改档位就要跑 `test/wheel.test.mjs` 里的返还率守卫。**
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { randomFloat } from "../utils/random.js";
import { getGameMainKeyboard, betError } from "./shared.js";

/**
 * 转盘档位：`upTo` 是累计概率上界（百分比），命中的第一个档位生效。
 * 最后一档必须是 100，且整体返还率 < 1（见 returnRate）。
 */
export const WHEEL_TIERS = [
  { upTo: 33, multiplier: 0, emoji: "💀", label: "失去本金" },
  { upTo: 58, multiplier: 0.5, emoji: "😐", label: "拿回一半" },
  { upTo: 78, multiplier: 1, emoji: "🙂", label: "保本" },
  { upTo: 92, multiplier: 2, emoji: "😀", label: "翻倍" },
  { upTo: 97, multiplier: 3, emoji: "🤩", label: "3 倍" },
  { upTo: 99.5, multiplier: 5, emoji: "🤑", label: "5 倍" },
  { upTo: 100, multiplier: 15, emoji: "👑", label: "15 倍大奖" }
];

/** 按 0~100 的随机数取档位 */
export function pickTier(roll) {
  for (const tier of WHEEL_TIERS) {
    if (roll < tier.upTo) return tier;
  }
  return WHEEL_TIERS[WHEEL_TIERS.length - 1];
}

/** 各档位的概率（百分比），用于展示与校验 */
export function tierPercents() {
  let prev = 0;
  return WHEEL_TIERS.map((t) => {
    const pct = t.upTo - prev;
    prev = t.upTo;
    return pct;
  });
}

/** 返还率 = 期望回收 / 下注。必须 < 1。 */
export function returnRate() {
  return tierPercents().reduce(
    (sum, pct, i) => sum + (pct / 100) * WHEEL_TIERS[i].multiplier,
    0
  );
}

export const WheelGame = {
  /** 游戏主界面：选下注金额（点下注后立即开奖） */
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const pcts = tierPercents();
    const lines = WHEEL_TIERS.map(
      (t, i) => `• ${t.emoji} ×${t.multiplier} —— ${pcts[i]}%`
    ).join("\n");
    const text =
      `🎡 <b>幸运转盘</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>转盘赔率分布：</b>\n` +
      `${lines}\n\n` +
      `请选择下注金额（下注后直接开奖）：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("wheel", "转"), "HTML");
  },

  /** 开奖：先扣分再转盘，按倍率结算（不足 1 分的部分向下取整） */
  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, sceneKey = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);
    const badBet = betError(betAmount);
    if (badBet) return answerCallback(token, callbackId, badBet, true);

    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    let currentBalance = afterDeduct;
    const tier = pickTier(randomFloat() * 100);
    const multiplier = tier.multiplier;
    const emoji = tier.emoji;
    const label = tier.label;

    const payout = Math.floor(betAmount * multiplier);
    const netChange = payout - betAmount;

    if (payout > 0) {
      const nb = await adjustPoints(env, userKey, payout);
      currentBalance = nb ?? currentBalance;
    }
    await logPointChange(env, userKey, netChange, currentBalance, `幸运转盘 ${multiplier}x (下注 ${betAmount})`);

    const resultMsg =
      `🎡 <b>幸运转盘开奖</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🎰 <b>结果：</b> ${emoji} <b>${multiplier}x</b> —— ${label}\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🏆 <b>结算：</b> ${multiplier >= 2 ? "🎉 恭喜赢了！" : multiplier === 1 ? "🙂 保本" : multiplier === 0 ? "💸 未中奖" : "😐 部分退还"}\n` +
      `💰 <b>变动：</b> ${netChange >= 0 ? `+${netChange}` : `${netChange}`}\n` +
      `🪙 <b>余额：</b> <b>${currentBalance}</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🎡 相同金额再转一次", callback_data: `game_wheel_play_${betAmount}` },
          { text: "💵 更改金额", callback_data: "game_wheel_main" }
        ],
        [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
      ]
    };

    await Promise.all([
      answerCallback(
        token, callbackId,
        multiplier >= 2 ? `🎉 获得 ${netChange} 积分！` : multiplier === 1 ? `🙂 保本` : multiplier === 0 ? `💸 输掉了 ${betAmount} 积分` : `😐 退还部分`
      ),
      editMessageText(token, chatId, messageId, resultMsg, keyboard, "HTML")
    ]);
  }
};
