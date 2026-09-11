// ==========================================
// 🎮 游戏共享：自定义下注面板
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";

export async function renderCustomBet(token, env, chatId, userKey, messageId, game, currentAmount) {
  const pts = await getUserPoints(env, userKey);
  const safePts = Number.isFinite(pts) ? pts : 0;

  let amt = Math.floor(Number(currentAmount) || 0);
  if (!Number.isFinite(amt) || amt < 1) amt = 1;
  if (safePts > 0 && amt > safePts) amt = safePts;

  const text =
    `🎛️ <b>自定义下注金额</b>\n` +
    `-------------------------\n` +
    `💰 <b>当前余额：</b> <code>${safePts}</code> 🪙\n` +
    `💵 <b>当前设定：</b> <code>${amt}</code> 🪙\n\n` +
    (safePts <= 0 ? `⚠️ 你当前没有可用积分。\n\n` : ``) +
    `请使用下方按钮调整下注金额，完成后点击确认：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "-100", callback_data: `game_c_${game}_-100_${amt}` },
        { text: "-10", callback_data: `game_c_${game}_-10_${amt}` },
        { text: "+10", callback_data: `game_c_${game}_10_${amt}` },
        { text: "+100", callback_data: `game_c_${game}_100_${amt}` }
      ],
      [
        { text: "🔽 最小值", callback_data: `game_c_${game}_min_0` },
        { text: "🔥 ALL IN (全押)", callback_data: `game_c_${game}_all_0` }
      ],
      [{ text: `✅ 确认下注: ${amt} 🪙`, callback_data: `game_${game}_bet_${amt}` }],
      [{ text: "🔙 返回上一级", callback_data: `game_${game}_main` }]
    ]
  };

  return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
}