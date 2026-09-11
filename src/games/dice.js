// ==========================================
// 🎲 游戏：骰子猜大小
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";

export const DiceGame = {
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🎲 <b>骰子猜大小</b>\n` +
      `-------------------------\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>规则说明：</b>\n` +
      `• 3 个骰子点数和 3-10 为<b>【小】</b>，11-18 为<b>【大】</b>。\n` +
      `• 赔率为 <b>1 : 2</b>。\n\n` +
      `请先选择下注金额：`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "下注 10 🪙", callback_data: "game_dice_bet_10" },
          { text: "下注 50 🪙", callback_data: "game_dice_bet_50" },
          { text: "下注 100 🪙", callback_data: "game_dice_bet_100" }
        ],
        [{ text: "🎛️ 自定义下注", callback_data: "game_c_dice_show_10" }],
        [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
      ]
    };
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  },

  async renderBetChoice(token, env, chatId, userKey, messageId, betAmount) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🎲 <b>骰子猜大小</b>\n` +
      `-------------------------\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n` +
      `💵 <b>已选下注：</b> <code>${betAmount}</code> 积分\n\n` +
      `请选择你要买【大】还是买【小】：`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔴 猜【小】(3-10)", callback_data: `game_dice_play_${betAmount}_small` },
          { text: "🔵 猜【大】(11-18)", callback_data: `game_dice_play_${betAmount}_big` }
        ],
        [{ text: "🔙 重选金额", callback_data: "game_dice_main" }]
      ]
    };
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  },

  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, choice) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);

    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    let currentBalance = afterDeduct;
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const d3 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2 + d3;
    const icons = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
    const diceStr = `${icons[d1 - 1]} ${icons[d2 - 1]} ${icons[d3 - 1]}`;
    const actual = sum >= 11 ? "big" : "small";
    const actualText = actual === "big" ? "大 (11-18)" : "小 (3-10)";
    const isWin = choice === actual;
    let reward = 0;

    if (isWin) {
      reward = betAmount * 2;
      const nb = await adjustPoints(env, userKey, reward);
      currentBalance = nb ?? currentBalance;
      await logPointChange(env, userKey, betAmount, currentBalance, `骰子获胜 (下注 ${betAmount})`);
    } else {
      await logPointChange(env, userKey, -betAmount, currentBalance, `骰子失败 (下注 ${betAmount})`);
    }

    const resultMsg =
      `🎲 <b>骰子开奖结果</b>\n` +
      `-------------------------\n` +
      `🎲 <b>点数：</b> ${diceStr} (共 <b>${sum}</b> 点)\n` +
      `🎯 <b>结果：</b> <b>${actualText}</b>\n` +
      `💬 <b>您的选择：</b> ${choice === "big" ? "大" : "小"}\n` +
      `-------------------------\n` +
      `🏆 <b>结算：</b> ${isWin ? "🎉 恭喜赢了！" : "💸 遗憾输了！"}\n` +
      `💰 <b>变动：</b> ${isWin ? `+${reward}` : `-${betAmount}`}\n` +
      `🪙 <b>余额：</b> <b>${currentBalance}</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔄 相同金额再来一把", callback_data: `game_dice_bet_${betAmount}` },
          { text: "💵 更改金额", callback_data: "game_dice_main" }
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