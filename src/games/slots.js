// ==========================================
// 🎰 游戏：欢乐老虎机
// 三个相同 = 10 倍（💎💎💎 = 50 倍），任意两个相同 = 2 倍。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";
import { logPointChange, tryDeductPoints, adjustPoints } from "../services/points.js";
import { completeTask } from "../services/tasks.js";
import { randomInt } from "../utils/random.js";
import { getGameMainKeyboard } from "./shared.js";

export const SlotsGame = {
  /** 游戏主界面：选下注金额（点下注后立即开奖） */
  async renderMain(token, env, chatId, userKey, messageId) {
    const pts = await getUserPoints(env, userKey);
    const text =
      `🎰 <b>欢乐老虎机</b>\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>赔率说明：</b>\n` +
      `• 🍒🍒🍒 (任意三个相同)：<b>10 倍</b>\n` +
      `• 💎💎💎 (三个钻石大奖)：<b>50 倍</b>\n` +
      `• 🍒🍒❔ (任意两个相同)：<b>2 倍</b>\n` +
      `• 其他组合：未中奖\n\n` +
      `请选择下注金额（下注后直接开奖）：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("slots", "拉"), "HTML");
  },

  /** 开奖：先扣分再摇奖，中奖按倍率返还 */
  async play(token, env, callbackId, chatId, userKey, messageId, betAmount, sceneKey = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);
    const afterDeduct = await tryDeductPoints(env, userKey, betAmount);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    await completeTask(env, userKey, "game", { sceneKey, chatId, token });

    let currentBalance = afterDeduct;
    const icons = ["🍎", "🍊", "🍇", "🍒", "🔔", "💎"];
    const r1 = icons[randomInt(icons.length)];
    const r2 = icons[randomInt(icons.length)];
    const r3 = icons[randomInt(icons.length)];
    const slotsStr = `[ ${r1} | ${r2} | ${r3} ]`;

    let multiplier = 0;
    if (r1 === r2 && r2 === r3) multiplier = (r1 === "💎") ? 50 : 10;
    else if (r1 === r2 || r2 === r3 || r1 === r3) multiplier = 2;

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
