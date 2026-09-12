// ==========================================
// 🎡 游戏：幸运转盘
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { completeTask } from "../services/tasks.js";
import { randomFloat } from "../utils/random.js";

export const WheelGame = {
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🎡 <b>幸运转盘</b>\n` +
      `-------------------------\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>转盘赔率分布：</b>\n` +
      `• 💀 ×0   —— 30%\n` +
      `• 😐 ×0.5 —— 25%\n` +
      `• 🙂 ×1   —— 20%\n` +
      `• 😀 ×2   —— 15%\n` +
      `• 🤩 ×5   —— 8%\n` +
      `• 🤑 ×10  —— 1.5%\n` +
      `• 👑 ×50  —— 0.5%\n\n` +
      `请选择下注金额（下注后直接开奖）：`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "转 10 🪙", callback_data: "game_wheel_play_10" },
          { text: "转 50 🪙", callback_data: "game_wheel_play_50" },
          { text: "转 100 🪙", callback_data: "game_wheel_play_100" }
        ],
        [{ text: "🎛️ 自定义下注", callback_data: "game_c_wheel_show_10" }],
        [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
      ]
    };
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  },

  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, sceneKey = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);
    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    await completeTask(env, userKey, "game", { sceneKey, chatId, token });

    let currentBalance = afterDeduct;
    const roll = randomFloat() * 100;
    let multiplier, emoji, label;
    if (roll < 30) { multiplier = 0; emoji = "💀"; label = "失去本金"; }
    else if (roll < 55) { multiplier = 0.5; emoji = "😐"; label = "拿回一半"; }
    else if (roll < 75) { multiplier = 1; emoji = "🙂"; label = "保本"; }
    else if (roll < 90) { multiplier = 2; emoji = "😀"; label = "翻倍"; }
    else if (roll < 98) { multiplier = 5; emoji = "🤩"; label = "5 倍"; }
    else if (roll < 99.5) { multiplier = 10; emoji = "🤑"; label = "10 倍"; }
    else { multiplier = 50; emoji = "👑"; label = "50 倍大奖"; }

    const payout = Math.floor(betAmount * multiplier);
    const netChange = payout - betAmount;

    if (payout > 0) {
      const nb = await adjustPoints(env, userKey, payout);
      currentBalance = nb ?? currentBalance;
    }
    await logPointChange(env, userKey, netChange, currentBalance, `幸运转盘 ${multiplier}x (下注 ${betAmount})`);

    const resultMsg =
      `🎡 <b>幸运转盘开奖</b>\n` +
      `-------------------------\n` +
      `🎰 <b>结果：</b> ${emoji} <b>${multiplier}x</b> —— ${label}\n` +
      `-------------------------\n` +
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
