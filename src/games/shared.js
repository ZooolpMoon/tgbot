// ==========================================
// 🎮 游戏共享：自定义下注面板
// 四个游戏共用同一套「±10 / ±100 / 最小 / 全押」调整逻辑，
// 回调格式：game_c_<游戏>_<动作>_<当前金额>
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";

/** 下注金额调整键盘（纯函数，便于排版测试） */
export function getCustomBetKeyboard(game, amt) {
  return {
    inline_keyboard: [
      [
        { text: "-100", callback_data: `game_c_${game}_-100_${amt}` },
        { text: "-10", callback_data: `game_c_${game}_-10_${amt}` }
      ],
      [
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
}

/**
 * 游戏主界面键盘：常用金额 + 自定义 + 返回（两列网格）。
 * @param {string} game 游戏键（dice / slots / coin / wheel）
 * @param {string} [verb] 按钮动词，例如「下注 / 拉 / 转」
 */
export function getGameMainKeyboard(game, verb = "下注") {
  return {
    inline_keyboard: [
      [
        { text: `${verb} 10 🪙`, callback_data: `game_${game}_bet_10` },
        { text: `${verb} 50 🪙`, callback_data: `game_${game}_bet_50` }
      ],
      [
        { text: `${verb} 100 🪙`, callback_data: `game_${game}_bet_100` },
        { text: "🎛️ 自定义", callback_data: `game_c_${game}_show_10` }
      ],
      [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
    ]
  };
}

/** 「重选金额 / 确认下注」这类二级界面的返回行 */
export function getBackToGameMainRow(game) {
  return [{ text: "🔙 重选金额", callback_data: `game_${game}_main` }];
}

/** 渲染自定义下注面板；金额会被收敛到 [1, 当前积分] */
export async function renderCustomBet(token, env, chatId, userKey, messageId, game, currentAmount) {
  const pts = await getUserPoints(env, userKey);
  const safePts = Number.isFinite(pts) ? pts : 0;

  let amt = Math.floor(Number(currentAmount) || 0);
  if (!Number.isFinite(amt) || amt < 1) amt = 1;
  if (safePts > 0 && amt > safePts) amt = safePts;

  const text =
    `🎛️ <b>自定义下注金额</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `💰 <b>当前余额：</b> <code>${safePts}</code> 🪙\n` +
    `💵 <b>当前设定：</b> <code>${amt}</code> 🪙\n\n` +
    (safePts <= 0 ? `⚠️ 你当前没有可用积分。\n\n` : ``) +
    `请使用下方按钮调整下注金额，完成后点击确认：`;

  return editMessageText(token, chatId, messageId, text, getCustomBetKeyboard(game, amt), "HTML");
}
