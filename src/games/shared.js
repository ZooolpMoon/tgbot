// ==========================================
// 🎮 游戏共享：自定义下注面板
// 四个游戏共用同一套「±10 / ±100 / 最小 / 全押」调整逻辑，
// 回调格式：game_c_<游戏>_<动作>_<当前金额>
// ==========================================

import { editMessageText } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";

/**
 * 单局下注上限。
 *
 * 为什么要有：以前下注只受「余额」约束，配合面板上的「ALL IN」+ 无限重复，
 * 一次手抖就能把全部身家清零（生产数据里出现过一笔 110918 分的全押），
 * 而且大额梭哈会让积分经济瞬间失真。
 * 1000 大致相当于「签到 50~200 天」的量级，既有梭哈的爽感又不至于毁号。
 */
export const MAX_BET = 1000;

/** 把下注金额收敛到 `[1, min(余额, MAX_BET)]` */
export function clampBet(amount, points) {
  const pointsNum = Math.max(0, Math.floor(Number(points) || 0));
  const max = Math.max(1, Math.min(pointsNum, MAX_BET));
  let amt = Math.floor(Number(amount) || 0);
  if (!Number.isFinite(amt) || amt < 1) amt = 1;
  return Math.min(amt, max);
}

/**
 * 校验单局下注额。
 * @returns {string|null} null = 合法；否则是可直接回执的错误文案
 */
export function betError(amount) {
  const bet = Math.floor(Number(amount) || 0);
  if (!Number.isFinite(bet) || bet < 1) return "❌ 下注金额无效！";
  if (bet > MAX_BET) return `❌ 单局下注上限 ${MAX_BET} 积分`;
  return null;
}

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
        { text: `🔥 押上限 ${MAX_BET}`, callback_data: `game_c_${game}_all_0` }
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

/** 渲染自定义下注面板；金额会被收敛到 `[1, min(余额, MAX_BET)]` */
export async function renderCustomBet(token, env, chatId, userKey, messageId, game, currentAmount) {
  const pts = await getUserPoints(env, userKey);
  const safePts = Number.isFinite(pts) ? pts : 0;
  const amt = clampBet(currentAmount, safePts);

  const text =
    `🎛️ <b>自定义下注金额</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `💰 <b>当前余额：</b> <code>${safePts}</code> 🪙\n` +
    `💵 <b>当前设定：</b> <code>${amt}</code> 🪙\n` +
    `📏 <b>单局上限：</b> <code>${MAX_BET}</code> 🪙\n\n` +
    (safePts <= 0 ? `⚠️ 你当前没有可用积分。\n\n` : ``) +
    `请使用下方按钮调整下注金额，完成后点击确认：`;

  return editMessageText(token, chatId, messageId, text, getCustomBetKeyboard(game, amt), "HTML");
}
