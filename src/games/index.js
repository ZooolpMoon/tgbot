// ==========================================
// 🎮 游戏注册表与分发器
//
// 每个游戏对外暴露两个入口：
//   renderMain     —— 游戏主界面（选下注金额）
//   onBetConfirm   —— 确认下注后的下一步（直接开奖 / 选择买大买小）
// ==========================================

import { editMessageText, sendMessageWithKeyboard, answerCallback, deleteMessage } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { grid, LAYOUT } from "../utils/layout.js";
import { renderCustomBet } from "./shared.js";
import { DiceGame } from "./dice.js";
import { SlotsGame } from "./slots.js";
import { CoinGame } from "./coin.js";
import { WheelGame } from "./wheel.js";
import { BlackjackGame } from "./blackjack.js";
import { RouletteGame } from "./roulette.js";
import { logWarn, logError } from "../core/logger.js";

/** 游戏大厅键盘：2×2 网格 + 独立关闭按钮 */
export function getGameCenterKeyboard() {
  return {
    inline_keyboard: [
      ...grid([
        { text: "🎲 骰子猜大小", callback_data: "game_dice_main" },
        { text: "🎰 欢乐老虎机", callback_data: "game_slots_main" },
        { text: "🪙 抛硬币", callback_data: "game_coin_main" },
        { text: "🎡 幸运转盘", callback_data: "game_wheel_main" },
        { text: "🃏 21 点（AI 庄家）", callback_data: "game_bj_main" },
        { text: "🔴⚫ 轮盘赌", callback_data: "game_roulette_main" }
      ]),
      [{ text: "❌ 关闭", callback_data: "game_close" }]
    ]
  };
}

/** 渲染游戏大厅（新发或原地刷新） */
export async function renderGameCenter(token, chatId, messageId = null) {
  const text =
    `🎮 <b>游戏</b>\n` +
    `${LAYOUT.DIVIDER}\n` +
    `欢迎来到游戏中心！请选择你想玩的游戏：\n\n` +
    `🎲 <b>骰子猜大小</b>：下注猜大小，1:2 赔率\n` +
    `🎰 <b>欢乐老虎机</b>：最高赢取 50 倍大奖\n` +
    `🪙 <b>抛硬币</b>：猜正反面，赢了 2 倍\n` +
    `🎡 <b>幸运转盘</b>：转盘抽倍率，最高 15 倍\n` +
    `🃏 <b>21 点</b>：跟 AI 庄家对赌，要牌 / 停牌 / 双倍，Blackjack 赔 3:2\n` +
    `🔴⚫ <b>轮盘赌</b>：押红黑 / 单双 / 大小 / 三打，最高 2:1`;

  const keyboard = getGameCenterKeyboard();

  if (messageId) return editMessageText(token, chatId, messageId, text, keyboard, "HTML");
  return sendMessageWithKeyboard(token, chatId, text, keyboard, "HTML");
}

/** 游戏键 → 处理函数；新增游戏只需在这里加一条 */
const GAME_REGISTRY = {
  dice: {
    renderMain: (t, e, c, u, m) => DiceGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => DiceGame.renderBetChoice(t, e, c, u, m, amt)
  },
  slots: {
    renderMain: (t, e, c, u, m) => SlotsGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt, sceneKey) => SlotsGame.play(t, e, cbId, c, u, m, amt, sceneKey)
  },
  coin: {
    renderMain: (t, e, c, u, m) => CoinGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => CoinGame.renderChoice(t, e, c, u, m, amt)
  },
  wheel: {
    renderMain: (t, e, c, u, m) => WheelGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt, sceneKey) => WheelGame.play(t, e, cbId, c, u, m, amt, sceneKey)
  },
  // 21 点是多轮牌局：onBetConfirm 只负责开局，后续由 game_bj_* 回调驱动
  bj: {
    renderMain: (t, e, c, u, m) => BlackjackGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => BlackjackGame.start(t, e, cbId, c, u, m, amt)
  },
  // 轮盘赌：选金额后先选下注类型（红/黑…），点下注类型才开奖
  roulette: {
    renderMain: (t, e, c, u, m) => RouletteGame.renderMain(t, e, c, u, m),
    onBetConfirm: (t, e, cbId, c, u, m, amt) => RouletteGame.renderBetChoice(t, e, c, u, m, amt)
  }
};

/**
 * 游戏类回调统一入口。
 * 所有异常都会转成 alert 提示，避免 Telegram 端一直转圈。
 */
export async function handleGameCallbacks(token, env, callback, chatId, userKey, messageId, fromId, data, sceneKey = null) {
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
        return await reg.onBetConfirm(token, env, callback.id, chatId, userKey, messageId, betAmount, sceneKey);
      }
      return answerCallback(token, callback.id, `⚠️ 无效下注`, true);
    }

    if (data.startsWith("game_dice_play_")) {
      const parts = data.replace("game_dice_play_", "").split("_");
      const betAmount = parseInt(parts[0], 10);
      const choice = parts[1];
      if (Number.isFinite(betAmount) && betAmount > 0 && (choice === "big" || choice === "small")) {
        return DiceGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, choice, sceneKey);
      }
    }

    if (data.startsWith("game_coin_play_")) {
      const parts = data.replace("game_coin_play_", "").split("_");
      const betAmount = parseInt(parts[0], 10);
      const choice = parts[1];
      if (Number.isFinite(betAmount) && betAmount > 0 && (choice === "heads" || choice === "tails")) {
        return CoinGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, choice, sceneKey);
      }
    }

    if (data.startsWith("game_slots_play_")) {
      const betAmount = parseInt(data.replace("game_slots_play_", ""), 10);
      if (Number.isFinite(betAmount) && betAmount > 0) {
        return SlotsGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, sceneKey);
      }
    }

    if (data.startsWith("game_wheel_play_")) {
      const betAmount = parseInt(data.replace("game_wheel_play_", ""), 10);
      if (Number.isFinite(betAmount) && betAmount > 0) {
        return WheelGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, sceneKey);
      }
    }

    // 轮盘赌：game_roulette_play_<金额>_<下注类型>，点下即开奖
    if (data.startsWith("game_roulette_play_")) {
      const parts = data.replace("game_roulette_play_", "").split("_");
      const betAmount = parseInt(parts[0], 10);
      const pickKey = parts[1];
      if (Number.isFinite(betAmount) && betAmount > 0 && pickKey) {
        return RouletteGame.play(token, env, callback.id, chatId, userKey, messageId, betAmount, pickKey, sceneKey);
      }
      return answerCallback(token, callback.id, "⚠️ 无效下注", true);
    }

    // 21 点的牌局内操作（要牌 / 停牌 / 双倍），状态在 blackjack_sessions 里
    if (data === "game_bj_hit" || data === "game_bj_stand" || data === "game_bj_double") {
      const action = data.slice("game_bj_".length);
      return BlackjackGame[action](token, env, callback.id, chatId, userKey, messageId);
    }

    logWarn("未匹配的 game 回调:", data);
    return answerCallback(token, callback.id, `⚠️ 未识别的游戏操作`, true);
  } catch (err) {
    logError("handleGameCallbacks 异常:", err);
    try {
      return await answerCallback(token, callback.id, `❌ 游戏异常: ${err.message || err}`, true);
    } catch (_) {
      return;
    }
  }
}
