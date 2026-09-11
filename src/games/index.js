// ==========================================
// 🎮 游戏注册表与分发器
// ==========================================

import { editMessageText, sendMessageWithKeyboard, answerCallback, deleteMessage } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { renderCustomBet } from "./shared.js";
import { DiceGame } from "./dice.js";
import { SlotsGame } from "./slots.js";
import { CoinGame } from "./coin.js";
import { WheelGame } from "./wheel.js";
import { logWarn } from "../core/logger.js";

export async function renderGameCenter(token, chatId, messageId = null) {
  const text =
    `🎮 <b>游戏</b>\n` +
    `-------------------------\n` +
    `欢迎来到游戏中心！请选择你想玩的游戏：\n\n` +
    `🎲 <b>骰子猜大小</b>：下注猜大小，1:2 赔率\n` +
    `🎰 <b>欢乐老虎机</b>：最高赢取 50 倍大奖\n` +
    `🪙 <b>抛硬币</b>：猜正反面，赢了 2 倍\n` +
    `🎡 <b>幸运转盘</b>：转盘抽倍率，最高 50 倍`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🎲 骰子猜大小", callback_data: "game_dice_main" }],
      [{ text: "🎰 欢乐老虎机", callback_data: "game_slots_main" }],
      [{ text: "🪙 抛硬币", callback_data: "game_coin_main" }],
      [{ text: "🎡 幸运转盘", callback_data: "game_wheel_main" }],
      [{ text: "❌ 关闭", callback_data: "game_close" }]
    ]
  };

  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

const GAME_REGISTRY = {
  dice: {
    renderMain: (t, e, c, u, m) => DiceGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => DiceGame.renderBetChoice(t, e, c, u, m, amt)
  },
  slots: {
    renderMain: (t, e, c, u, m) => SlotsGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => SlotsGame.play(t, e, cbId, c, u, m, amt)
  },
  coin: {
    renderMain: (t, e, c, u, m) => CoinGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => CoinGame.renderChoice(t, e, c, u, m, amt)
  },
  wheel: {
    renderMain: (t, e, c, u, m) => WheelGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => WheelGame.play(t, e, cbId, c, u, m, amt)
  }
};

export async function handleGameCallbacks(token, env, callback, chatId, userKey, messageId, fromId, data) {
  try {
    if (data === "game_hub") {
      await renderGameCenter(token, chatId, messageId);
      return answerCallback(token, callback.id, "返回游戏大厅");
    }
    if (data === "game_close") {
      await deleteMessage(token, chatId, messageId);
      return answerCallback(token, callback.id, "游戏已关闭");
    }

    if (data.startsWith("game_c_")) {
      const parts = data.split("_");
      const game = parts[2];
      const action = parts[3];
      const currentAmt = parseInt(parts[4]) || 0;
      let newAmt = currentAmt;

      if (action === "show") newAmt = currentAmt || 10;
      else if (action === "all") newAmt = await getUserPoints(env, userKey);
      else if (action === "min") newAmt = 1;
      else {
        const delta = parseInt(action, 10) || 0;
        newAmt = currentAmt + delta;
        if (!Number.isFinite(newAmt) || newAmt < 1) newAmt = 1;
      }

      await renderCustomBet(token, env, chatId, userKey, messageId, game, newAmt);
      return answerCallback(token, callback.id, "下注金额已更新");
    }

    if (data.startsWith("game_") && data.endsWith("_main")) {
      const game = data.slice(5, -5);
      const reg = GAME_REGISTRY[game];
      if (reg) {
        await reg.renderMain(token, env, chatId, userKey, messageId);
        return answerCallback(token, callback.id, `加载${game}`);
      }
    }

    if (data.startsWith("game_") && data.includes("_bet_")) {
      const parts = data.split("_");
      const game = parts[1];
      const betAmount = parseInt(parts[3], 10);
      const reg = GAME_REGISTRY[game];
      if (reg && reg.onBetConfirm && Number.isFinite(betAmount) && betAmount > 0) {
        return await reg.onBetConfirm(token, env, callback.id, chatId, userKey, messageId, betAmount);
      }
      return answerCallback(token, callback.id, `⚠️ 无效下注`, true);
    }

    if (data.startsWith("game_dice_play_")) {
      const parts = data.replace("game_dice_play_", "").split("_");
      const betAmount = parseInt(parts[0], 10);
      const choice = parts[1];
      if (Number.isFinite(betAmount) && betAmount > 0 && (choice === "big" || choice === "small")) {
        return DiceGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, choice);
      }
    }

    if (data.startsWith("game_coin_play_")) {
      const parts = data.replace("game_coin_play_", "").split("_");
      const betAmount = parseInt(parts[0], 10);
      const choice = parts[1];
      if (Number.isFinite(betAmount) && betAmount > 0 && (choice === "heads" || choice === "tails")) {
        return CoinGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, choice);
      }
    }

    if (data.startsWith("game_slots_play_")) {
      const betAmount = parseInt(data.replace("game_slots_play_", ""), 10);
      if (Number.isFinite(betAmount) && betAmount > 0) {
        return SlotsGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount);
      }
    }

    if (data.startsWith("game_wheel_play_")) {
      const betAmount = parseInt(data.replace("game_wheel_play_", ""), 10);
      if (Number.isFinite(betAmount) && betAmount > 0) {
        return WheelGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount);
      }
    }

    logWarn("未匹配的 game 回调:", data);
    return answerCallback(token, callback.id, `⚠️ 未识别的游戏操作`, true);
  } catch (err) {
    console.error("handleGameCallbacks 异常:", err);
    try {
      return await answerCallback(token, callback.id, `❌ 游戏异常: ${err.message || err}`, true);
    } catch (_) {
      return;
    }
  }
}