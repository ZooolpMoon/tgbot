// ==========================================
// 🪙 游戏：抛硬币
// 猜正反面，猜中 2 倍（含本金）返还，胜率 50%。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { completeTask } from "../services/tasks.js";
import { randomInt } from "../utils/random.js";
import { getGameMainKeyboard, getBackToGameMainRow } from "./shared.js";

export const CoinGame = {
  /** 游戏主界面：选下注金额 */
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🪙 <b>抛硬币</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>规则说明：</b>\n` +
      `• 猜硬币正反面，猜中赢 <b>2 倍</b>，猜错失去本金。\n` +
      `• 赔率公平（50% vs 50%）。\n\n` +
      `请先选择下注金额：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("coin"), "HTML");
  },

  /** 二级界面：猜正面 / 反面 */
  async renderChoice(token, env, chatId, userKey, messageId, betAmount) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🪙 <b>抛硬币</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n` +
      `💵 <b>已选下注：</b> <code>${betAmount}</code> 积分\n\n` +
      `请选择你要猜的面：`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "👑 正面", callback_data: `game_coin_play_${betAmount}_heads` },
          { text: "🌵 反面", callback_data: `game_coin_play_${betAmount}_tails` }
        ],
        getBackToGameMainRow("coin")
      ]
    };
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  },

  /** 开奖：先扣分再抛硬币，猜中 2 倍返还 */
  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, choice, sceneKey = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);
    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    await completeTask(env, userKey, "game", { sceneKey, chatId, token });

    let currentBalance = afterDeduct;
    const result = randomInt(2) === 0 ? "heads" : "tails";
    const isWin = result === choice;
    const resultText = result === "heads" ? "👑 正面" : "🌵 反面";
    const choiceText = choice === "heads" ? "👑 正面" : "🌵 反面";

    let reward = 0;
    if (isWin) {
      reward = betAmount * 2;
      const nb = await adjustPoints(env, userKey, reward);
      currentBalance = nb ?? currentBalance;
      await logPointChange(env, userKey, betAmount, currentBalance, `抛硬币获胜 (下注 ${betAmount})`);
    } else {
      await logPointChange(env, userKey, -betAmount, currentBalance, `抛硬币失败 (下注 ${betAmount})`);
    }

    const resultMsg =
      `🪙 <b>抛硬币开奖</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🎲 <b>结果：</b> <b>${resultText}</b>\n` +
      `💬 <b>你的选择：</b> ${choiceText}\n` +
      `${LAYOUT.DIVIDER}\n` +
      `🏆 <b>结算：</b> ${isWin ? "🎉 恭喜赢了！" : "💸 遗憾输了！"}\n` +
      `💰 <b>变动：</b> ${isWin ? `+${reward}` : `-${betAmount}`}\n` +
      `🪙 <b>余额：</b> <b>${currentBalance}</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔄 相同金额再来", callback_data: `game_coin_bet_${betAmount}` },
          { text: "💵 更改金额", callback_data: "game_coin_main" }
        ],
        [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
      ]
    };

    await Promise.all([
      answerCallback(token, callbackId, isWin ? `🎉 赢取了 ${reward} 积分！` : `💸 输掉了 ${betAmount} 积分`),
      editMessageText(token, chatId, messageId, resultMsg, keyboard, "HTML")
    ]);
  }
};
