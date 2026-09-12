// ==========================================
// 🎁 /lottery 抽奖
//   每天 1 次免费；也可以花积分抽（金额见 LOTTERY.PAID_COST）
// ==========================================

import { sendMessage, sendMessageWithKeyboard } from "../../telegram/api.js";
import { LAYOUT } from "../../utils/layout.js";
import { LOTTERY } from "../../config/constants.js";
import { escapeHtml } from "../../utils/html.js";
import { getUserPoints } from "../../services/users.js";
import { draw, expectedPrize, getTodayDrawStats } from "../../services/lottery.js";

/** 抽奖面板键盘（纯函数，便于排版测试） */
export function getLotteryKeyboard(freeAvailable) {
  return {
    inline_keyboard: [
      [{
        text: freeAvailable ? "🎁 免费抽一次" : "🎁 今日免费已用",
        callback_data: "lottery_draw_free"
      }],
      [{
        text: `💰 花 ${LOTTERY.PAID_COST} 积分抽一次`,
        callback_data: "lottery_draw_paid"
      }],
      [{ text: "🔙 关闭", callback_data: "lottery_close" }]
    ]
  };
}

/** 奖池文案 */
export function buildPrizeText() {
  const total = LOTTERY.PRIZES.reduce((sum, p) => sum + Number(p.weight), 0);
  return LOTTERY.PRIZES.map((p) => {
    const chance = ((Number(p.weight) / total) * 100).toFixed(1).replace(/\.0$/, "");
    return `🪙 <b>${p.points}</b> 积分 · ${chance}%`;
  }).join("\n");
}

/** 渲染抽奖面板（新发或原地刷新） */
export async function renderLottery(token, env, chatId, userKey, messageId = null, extra = "") {
  const stats = await getTodayDrawStats(env, userKey);
  const pts = await getUserPoints(env, userKey);
  const freeAvailable = !stats.free;

  let text = `🎁 <b>每日抽奖</b>\n`;
  text += `${LAYOUT.DIVIDER}\n`;
  text += `🪙 <b>我的积分：</b> <b>${pts}</b>\n`;
  text += `🎫 <b>今日免费：</b> ${freeAvailable ? "✅ 还没用" : "🚫 已用完"}\n`;
  if (stats.paidCount > 0 || stats.gained > 0) {
    text += `📊 <b>今日战绩：</b> 抽了 ${stats.paidCount + (stats.free ? 1 : 0)} 次 · 共得 ${stats.gained} 积分\n`;
  }
  text += `\n<b>奖池：</b>\n${buildPrizeText()}\n`;
  text += `\n<i>付费抽奖每次 ${LOTTERY.PAID_COST} 积分，奖池期望约 ${expectedPrize().toFixed(1)} 分（别指望靠它发财 😉）</i>`;
  if (extra) text += `\n\n${extra}`;

  const keyboard = getLotteryKeyboard(freeAvailable);
  if (messageId) {
    const { editMessageText } = await import("../../telegram/api.js");
    return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  }
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** /lottery：打开抽奖面板 */
export async function cmdLottery({ env, token, chatId, userKey }) {
  if (!env.DB) return sendMessage(token, chatId, "❌ 未绑定数据库，抽奖不可用。");
  return renderLottery(token, env, chatId, userKey);
}

/** 抽奖按钮回调 */
export async function handleLotteryCallback({ env, token, callback, chatId, userKey, messageId, data }) {
  const { answerCallback, editMessageText, deleteMessage } = await import("../../telegram/api.js");

  if (data === "lottery_close") {
    await deleteMessage(token, chatId, messageId);
    return answerCallback(token, callback.id, "已关闭");
  }

  const source = data === "lottery_draw_paid" ? "paid" : "free";
  const result = await draw(env, userKey, source);

  if (!result.ok) {
    return answerCallback(token, callback.id, `⚠️ ${result.error}`, true);
  }

  const icon = result.prize >= 20 ? "🎉🎉" : result.prize >= 8 ? "🎉" : "🎁";
  const extra =
    `${icon} <b>抽到 ${result.prize} 积分！</b>\n` +
    (source === "paid" ? `💸 本次消耗 ${result.cost} 积分\n` : ``) +
    `🪙 当前积分：<b>${result.balance}</b>`;

  await answerCallback(token, callback.id, `${icon} +${result.prize} 积分`);
  return renderLottery(token, env, chatId, userKey, messageId, extra);
}
