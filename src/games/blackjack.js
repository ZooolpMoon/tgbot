// ==========================================
// 🃏 游戏：21 点（AI 庄家）
//
// 规则（第一版）：
//   • 单副 52 张，每局重新洗牌；**牌堆落库**，跨多次点击不会换牌
//   • A 可当 1 或 11（自动取不爆的最大值）
//   • 首两张 21 点 = Blackjack，赔 3:2（双方都 Blackjack 则平局退本金）
//   • 庄家 <17 必须继续要牌、≥17 停牌（soft 17 也停，规则简单可预期）
//   • 玩家操作：要牌 / 停牌 / 双倍（首两张时加倍本金，只再补一张后自动停牌）
//
// AI 在哪：**判定完全走上面的规则**（公平、可验证、不拖慢牌局），
// 模型只负责在结算时说一句台词（见 blackjack-ai.js）。让模型决定要不要牌的话，
// 它可能 20 点还要牌，用户只会觉得机器人在乱来或者作弊。
//
// 资金流：开局先扣本金 → 结算时按输赢返还（赢连本带利、平局退本、输归庄家）。
// 牌局 30 分钟没有动作就作废，由定时任务**退还本金**——不能让用户因为没点完就丢分。
// ==========================================

import { editMessageText, answerCallback } from "../telegram/api.js";
import { getUserPoints } from "../services/users.js";
import { LAYOUT } from "../utils/layout.js";
import { escapeHtml } from "../utils/html.js";
import { logPointChange, tryDeductPoints, adjustPoints, refundPoint } from "../services/points.js";
import { randomInt } from "../utils/random.js";
import { logWarn } from "../core/logger.js";
import { dealerLine } from "./blackjack-ai.js";
import { getGameMainKeyboard, betError } from "./shared.js";

/** 牌局多久没动作算作废（与读取、清理两处的 SQL 保持一致） */
export const SESSION_MINUTES = 30;
const TABLE = "blackjack_sessions";

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
/** 暗牌占位符 */
const HIDDEN = "🎴";

// ==========================================
// 🧮 纯逻辑（无 IO，便于测试）
// ==========================================

/** 洗一副新牌（52 张，形如 "A♠" / "10♥"），Fisher-Yates 洗牌 */
export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(`${rank}${suit}`);
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/** 单张牌的基础点数：A 记 11，J/Q/K 记 10 */
export function cardPoints(card) {
  const rank = String(card).slice(0, -1);
  if (rank === "A") return 11;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  const n = Number(rank);
  return Number.isFinite(n) ? n : 0;
}

/** 手牌点数：A 先按 11 算，爆了就逐张降为 1，取不爆的最大值 */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards || []) {
    total += cardPoints(card);
    if (String(card).slice(0, -1) === "A") aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

/** 手里是否还有「当 11 用的 A」（软牌），仅用于文案展示 */
export function isSoft(cards) {
  const list = cards || [];
  const aces = list.filter((c) => String(c).slice(0, -1) === "A").length;
  if (aces === 0) return false;
  const hard = list.reduce(
    (sum, c) => sum + (String(c).slice(0, -1) === "A" ? 1 : cardPoints(c)),
    0
  );
  return hard + 10 <= 21;
}

/** 首两张 21 点（Blackjack） */
export function isBlackjack(cards) {
  return (cards || []).length === 2 && handValue(cards) === 21;
}

export function isBust(cards) {
  return handValue(cards) > 21;
}

/** 庄家是否必须继续要牌：<17 要牌，≥17 停（soft 17 也停） */
export function dealerShouldHit(cards) {
  return handValue(cards) < 17;
}

/**
 * 结算一局：返回结果与「应返还的积分」（含本金）。
 * payout = 0 表示本金归庄家；= bet 表示平局；= bet*2 表示赢；Blackjack 赔 3:2。
 */
export function settleRound({ player, dealer, bet }) {
  const amount = Math.max(0, Math.floor(Number(bet) || 0));
  const playerTotal = handValue(player);
  const dealerTotal = handValue(dealer);
  const playerBJ = isBlackjack(player);
  const dealerBJ = isBlackjack(dealer);

  if (playerTotal > 21) {
    return { outcome: "lose", payout: 0, playerTotal, dealerTotal, reason: "爆牌" };
  }
  if (playerBJ && dealerBJ) {
    return { outcome: "push", payout: amount, playerTotal, dealerTotal, reason: "双方 Blackjack" };
  }
  if (playerBJ) {
    // 3:2 赔付 = 本金 + 1.5 倍。下注为奇数时向下取整，避免出现小数积分
    return {
      outcome: "blackjack",
      payout: amount + Math.floor(amount * 1.5),
      playerTotal,
      dealerTotal,
      reason: "Blackjack"
    };
  }
  if (dealerBJ) {
    return { outcome: "lose", payout: 0, playerTotal, dealerTotal, reason: "庄家 Blackjack" };
  }
  if (dealerTotal > 21) {
    return { outcome: "win", payout: amount * 2, playerTotal, dealerTotal, reason: "庄家爆牌" };
  }
  if (playerTotal > dealerTotal) {
    return { outcome: "win", payout: amount * 2, playerTotal, dealerTotal, reason: "点数更大" };
  }
  if (playerTotal === dealerTotal) {
    return { outcome: "push", payout: amount, playerTotal, dealerTotal, reason: "点数相同" };
  }
  return { outcome: "lose", payout: 0, playerTotal, dealerTotal, reason: "点数更小" };
}

/** 手牌展示："9♠ 10♥"；hideSecond 时第 2 张显示为暗牌 */
export function formatHand(cards, { hideSecond = false } = {}) {
  return (cards || [])
    .map((card, index) => (hideSecond && index === 1 ? HIDDEN : card))
    .join(" ");
}

/** 手牌文案：加总点数；爆牌加 💥；软牌标注（A 当 11） */
export function handText(cards, { hideSecond = false } = {}) {
  const shown = formatHand(cards, { hideSecond });
  if (hideSecond) return shown;
  const total = handValue(cards);
  const suffix = total > 21 ? " 💥" : isSoft(cards) ? "（软）" : "";
  return `${shown} = <b>${total}</b>${suffix}`;
}

const OUTCOME_TEXT = {
  win: "🎉 <b>你赢了！</b>",
  blackjack: "🃏 <b>Blackjack！</b>",
  push: "🤝 <b>平局，退回本金</b>",
  lose: "💸 <b>你输了</b>"
};

/** 净变动文案（本金是开局就扣掉的，这里只显示本局净收益） */
function netText(outcome, bet) {
  if (outcome === "win") return `+${bet}`;
  if (outcome === "blackjack") return `+${Math.floor(bet * 1.5)}`;
  if (outcome === "push") return "±0";
  return `-${bet}`;
}

// ==========================================
// 💾 牌局状态（一个会话里一人一局）
// ==========================================

/** 读进行中的牌局；超过 30 分钟的记录视为无效（定时任务会退款并删除） */
async function loadSession(env, chatId, userKey) {
  if (!env?.DB) return null;
  return await env.DB.prepare(
    `SELECT * FROM ${TABLE}
      WHERE chat_id = ? AND user_key = ? AND status = 'playing'
        AND updated_at >= datetime('now', '-${SESSION_MINUTES} minutes')`
  ).bind(String(chatId), String(userKey)).first();
}

/**
 * 建局：**只插入、不覆盖**。
 * 并发双击「确认下注」时只有一个能插入成功，另一个据此把本金退回去——
 * 否则会出现「扣了分但没有牌局」，而超时退款扫的是牌局表，那笔分就永远找不回来。
 * @returns {Promise<boolean>} 是否成功建局
 */
async function insertSession(env, chatId, userKey, state) {
  const res = await env.DB.prepare(
    `INSERT INTO ${TABLE} (chat_id, user_key, bet, player, dealer, deck, doubled, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'playing', CURRENT_TIMESTAMP)
     ON CONFLICT(chat_id, user_key) DO NOTHING`
  ).bind(
    String(chatId), String(userKey), state.bet,
    JSON.stringify(state.player), JSON.stringify(state.dealer), JSON.stringify(state.deck),
    state.doubled ? 1 : 0
  ).run();
  return Number(res?.meta?.changes) === 1;
}

/**
 * 更新牌局：只更新「仍是 playing」的那一行。
 * **绝不能写成 INSERT/upsert**：结算用的是原子 DELETE，如果一个慢请求在结算之后
 * 才落库，就会把这一局「写活」，用户可以拿同一局反复结算。
 * @returns {Promise<boolean>} false = 这局已经被结算掉了
 */
async function updateSession(env, chatId, userKey, state) {
  const res = await env.DB.prepare(
    `UPDATE ${TABLE}
        SET bet = ?, player = ?, dealer = ?, deck = ?, doubled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE chat_id = ? AND user_key = ? AND status = 'playing'`
  ).bind(
    state.bet, JSON.stringify(state.player), JSON.stringify(state.dealer),
    JSON.stringify(state.deck), state.doubled ? 1 : 0,
    String(chatId), String(userKey)
  ).run();
  return Number(res?.meta?.changes) === 1;
}

/**
 * 原子抢「结算权」：删掉 playing 的那一行，只有 changes === 1 的请求有权发奖。
 *
 * 为什么必须这么做：Telegram 的回调会被连点、也会重推。没有这一层，
 * 两个请求会各自读到同一局并各发一次奖 —— 而结算里还有一次最长 8 秒的
 * AI 台词调用，窗口大到用户随便点两下就能撞上。
 */
async function claimSettlement(env, chatId, userKey) {
  const res = await env.DB.prepare(
    `DELETE FROM ${TABLE} WHERE chat_id = ? AND user_key = ? AND status = 'playing'`
  ).bind(String(chatId), String(userKey)).run();
  return Number(res?.meta?.changes) === 1;
}

async function dropSession(env, chatId, userKey) {
  await env.DB.prepare(`DELETE FROM ${TABLE} WHERE chat_id = ? AND user_key = ?`)
    .bind(String(chatId), String(userKey)).run();
}

/** 把库里的行还原成内存状态（坏数据一律当无效，避免后续崩在 JSON.parse 上） */
function parseSession(row) {
  try {
    const player = JSON.parse(row.player);
    const dealer = JSON.parse(row.dealer);
    const deck = JSON.parse(row.deck);
    if (!Array.isArray(player) || !Array.isArray(dealer) || !Array.isArray(deck)) return null;
    const bet = Math.floor(Number(row.bet) || 0);
    if (bet < 1) return null;
    return { bet, player, dealer, deck, doubled: Number(row.doubled) === 1 };
  } catch (e) {
    logWarn("21 点牌局数据损坏，按无效处理：", e?.message || e);
    return null;
  }
}

/** 抽一张牌；牌堆见底就补一副新的（单副牌正常打不到这一步） */
function draw(state) {
  if (state.deck.length === 0) state.deck = buildDeck();
  return state.deck.pop();
}

// ==========================================
// 🖼️ 界面
// ==========================================

function tableText({ player, dealer, bet, doubled, balance, reveal = false }) {
  const lines = [
    `🃏 <b>21 点</b> · AI 庄家`,
    LAYOUT.DIVIDER,
    `💰 <b>当前积分：</b> <code>${balance}</code>`,
    `💵 <b>本局下注：</b> <code>${bet}</code>${doubled ? "（已双倍）" : ""}`,
    ``,
    `🤖 <b>庄家：</b> ${handText(dealer, { hideSecond: !reveal })}`,
    `🙋 <b>你：</b> ${handText(player)}`
  ];
  return lines.join("\n");
}

function playingKeyboard(state) {
  const rows = [
    [
      { text: "🃏 要牌", callback_data: "game_bj_hit" },
      { text: "✋ 停牌", callback_data: "game_bj_stand" }
    ]
  ];
  // 双倍只在「首两张」且没用过时可选，避免点下去才发现不合法
  if (state.player.length === 2 && !state.doubled) {
    rows.push([{ text: "💰 双倍下注", callback_data: "game_bj_double" }]);
  }
  rows.push([{ text: "🔙 返回大厅", callback_data: "game_hub" }]);
  return { inline_keyboard: rows };
}

function resultKeyboard(bet) {
  return {
    inline_keyboard: [
      [
        { text: `🔄 再来一把 (${bet})`, callback_data: `game_bj_bet_${bet}` },
        { text: "💵 改金额", callback_data: "game_bj_main" }
      ],
      [{ text: "🔙 返回大厅", callback_data: "game_hub" }]
    ]
  };
}

function resultText({ player, dealer, bet, balance, settled, line }) {
  const { outcome, playerTotal, dealerTotal, reason } = settled;
  return [
    `🃏 <b>21 点</b> · 结算`,
    LAYOUT.DIVIDER,
    `🤖 <b>庄家：</b> ${formatHand(dealer)} = <b>${dealerTotal}</b>${dealerTotal > 21 ? " 💥" : ""}`,
    `🙋 <b>你：</b> ${formatHand(player)} = <b>${playerTotal}</b>${playerTotal > 21 ? " 💥" : ""}`,
    ``,
    OUTCOME_TEXT[outcome] || OUTCOME_TEXT.lose,
    `📋 <b>依据：</b> ${reason}`,
    `💰 <b>变动：</b> ${netText(outcome, bet)}`,
    `🪙 <b>余额：</b> <b>${balance}</b>`,
    ``,
    `🤖 <i>${escapeHtml(line)}</i>`
  ].join("\n");
}

/** 展示一张「进行中」的牌桌（返回大厅后再进来、或开局后刷新） */
async function renderTable(token, chatId, messageId, state, balance) {
  const text = tableText({ ...state, balance }) + `\n\n请选择操作：`;
  return editMessageText(token, chatId, messageId, text, playingKeyboard(state), "HTML");
}

/**
 * 结算并落库：发奖 / 记流水 / 要一句 AI 台词 / 出结算卡片。
 * @param {object} opts
 * @param {string} opts.callbackId 用于先回执，避免 Telegram 转圈
 * @param {string} [opts.toast] 覆盖回执文案
 */
async function finishRound(token, env, { callbackId, chatId, userKey, messageId, state, revealDealer = true }) {
  // 先抢结算权：连点「停牌」或 Telegram 重推回调时，只有第一次能继续往下发奖
  const claimed = await claimSettlement(env, chatId, userKey);
  if (!claimed) {
    if (callbackId) return answerCallback(token, callbackId, "这局已经结算了", true);
    return;
  }

  if (callbackId) {
    await answerCallback(token, callbackId, revealDealer ? "庄家正在摊牌…" : "结算中…");
  }

  const settled = settleRound({ player: state.player, dealer: state.dealer, bet: state.bet });
  let balance = await getUserPoints(env, userKey);

  if (settled.payout > 0) {
    const after = await adjustPoints(env, userKey, settled.payout);
    if (after !== null && after !== undefined) balance = after;
  }
  const net = settled.payout - state.bet;
  await logPointChange(
    env, userKey, net, balance,
    `21 点${settled.reason} (下注 ${state.bet})`
  );

  // 台词是锦上添花：拿不到就用内置的，绝不因为模型失败卡住结算
  const line = await dealerLine(env, {
    player: state.player,
    dealer: state.dealer,
    bet: state.bet,
    outcome: settled.outcome,
    reason: settled.reason
  });

  // 会话已在 claimSettlement 里删掉，这里不用再删
  return editMessageText(
    token, chatId, messageId,
    resultText({ player: state.player, dealer: state.dealer, bet: state.bet, balance, settled, line }),
    resultKeyboard(state.bet),
    "HTML"
  );
}

// ==========================================
// 🎮 对外入口
// ==========================================

export const BlackjackGame = {
  /** 主界面：有没打完的牌局就续上，否则选下注金额 */
  async renderMain(token, env, chatId, userKey, messageId) {
    const row = await loadSession(env, chatId, userKey);
    if (row) {
      const state = parseSession(row);
      if (state) {
        const balance = await getUserPoints(env, userKey);
        return renderTable(token, chatId, messageId, state, balance);
      }
      // 数据坏了就清掉，别让用户卡在一个打不开的牌局上
      await dropSession(env, chatId, userKey);
    }

    const pts = await getUserPoints(env, userKey);
    const text =
      `🃏 <b>21 点</b> · AI 庄家\n` +
      `${LAYOUT.DIVIDER}\n` +
      `💰 <b>当前积分：</b> <code>${pts}</code>\n\n` +
      `<b>规则说明：</b>\n` +
      `• 目标：点数比庄家更接近 21 且不超过。\n` +
      `• A 可当 1 或 11；J / Q / K 记 10 点。\n` +
      `• 首两张 21 点 = <b>Blackjack</b>，赔 <b>3:2</b>。\n` +
      `• 庄家 <b>不足 17 点必须继续要牌</b>，到 17 点停牌。\n` +
      `• 首两张时可用「<b>双倍下注</b>」：本金翻倍，只再补一张牌。\n` +
      `• 平局退回本金。\n\n` +
      `庄家由 AI 充当，牌局判定走上面的固定规则 —— 它只负责说话。\n\n` +
      `请先选择下注金额：`;
    return editMessageText(token, chatId, messageId, text, getGameMainKeyboard("bj", "下注"), "HTML");
  },

  /**
   * 开局：扣本金 → 发牌 → 首两张 21 点直接结算，否则进入牌桌。
   * @param {string[]} [deckOverride] 仅测试用：塞一副固定牌堆，让发牌结果可预期
   */
  async start(token, env, callbackId, chatId, userKey, messageId, betAmount, deckOverride = null) {
    if (!env.DB) return answerCallback(token, callbackId, "❌ 未绑定数据库！", true);

    const badBet = betError(betAmount);
    if (badBet) return answerCallback(token, callbackId, badBet, true);
    const bet = Math.floor(Number(betAmount) || 0);

    // 已经有没打完的牌局：不重复扣分，把当前牌桌再显示一遍
    const existingRow = await loadSession(env, chatId, userKey);
    if (existingRow) {
      const existing = parseSession(existingRow);
      if (existing) {
        await answerCallback(token, callbackId, "你还有一局没打完", true);
        const balance = await getUserPoints(env, userKey);
        return renderTable(token, chatId, messageId, existing, balance);
      }
      await dropSession(env, chatId, userKey);
    }

    const afterDeduct = await tryDeductPoints(env, userKey, bet);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法下注！", true);

    const deck = Array.isArray(deckOverride) && deckOverride.length >= 4
      ? [...deckOverride]
      : buildDeck();
    const state = {
      bet,
      player: [deck.pop(), deck.pop()],
      dealer: [deck.pop(), deck.pop()],
      deck,
      doubled: false
    };

    // 先把这一局落库：插入成功的那次请求才「拥有」它。
    // 并发双击「确认下注」时另一方插不进去，据此把刚扣的本金退回去
    // （否则就是「扣了分却没有牌局」，而超时退款扫的是牌局表，那笔分找不回来）。
    const created = await insertSession(env, chatId, userKey, state);
    if (!created) {
      await refundPoint(env, userKey, bet, "21 点重复开局退款");
      await answerCallback(token, callbackId, "你还有一局没打完", true);
      const fresh = await loadSession(env, chatId, userKey);
      const parsed = fresh ? parseSession(fresh) : null;
      if (parsed) {
        return renderTable(token, chatId, messageId, parsed, await getUserPoints(env, userKey));
      }
      return;
    }

    // 首两张 21 点：不用等玩家操作，直接摊牌结算（庄家也是 Blackjack 就平局）
    if (isBlackjack(state.player)) {
      return finishRound(token, env, { callbackId, chatId, userKey, messageId, state });
    }

    await answerCallback(token, callbackId, `已下注 ${bet}，牌已发好`);
    return renderTable(token, chatId, messageId, state, afterDeduct);
  },

  /** 要牌 */
  async hit(token, env, callbackId, chatId, userKey, messageId) {
    const state = await requireSession(env, chatId, userKey);
    if (!state.ok) return answerCallback(token, callbackId, state.message, true);

    state.session.player.push(draw(state.session));

    if (isBust(state.session.player)) {
      return finishRound(token, env, {
        callbackId, chatId, userKey, messageId, state: state.session
      });
    }

    // 更新失败说明这一局已经被另一个请求结算掉了（连点），别再继续往下走
    const saved = await updateSession(env, chatId, userKey, state.session);
    if (!saved) return answerCallback(token, callbackId, "这局已经结算了", true);

    await answerCallback(token, callbackId, `要了一张，现在 ${handValue(state.session.player)} 点`);
    return renderTable(token, chatId, messageId, state.session, await getUserPoints(env, userKey));
  },

  /** 停牌：庄家按规则补牌后结算 */
  async stand(token, env, callbackId, chatId, userKey, messageId) {
    const state = await requireSession(env, chatId, userKey);
    if (!state.ok) return answerCallback(token, callbackId, state.message, true);

    while (dealerShouldHit(state.session.dealer)) {
      state.session.dealer.push(draw(state.session));
    }
    return finishRound(token, env, {
      callbackId, chatId, userKey, messageId, state: state.session
    });
  },

  /**
   * 双倍下注：本金翻倍 + 只补一张牌后自动停牌。
   * 重复点击要靠原子条件拦住，否则会重复扣本金。
   */
  async double(token, env, callbackId, chatId, userKey, messageId) {
    const state = await requireSession(env, chatId, userKey);
    if (!state.ok) return answerCallback(token, callbackId, state.message, true);

    const session = state.session;
    if (session.doubled) {
      return answerCallback(token, callbackId, "本局已经双倍过了", true);
    }
    if (session.player.length !== 2) {
      return answerCallback(token, callbackId, "只能在发完首两张牌时双倍", true);
    }

    const afterDeduct = await tryDeductPoints(env, userKey, session.bet);
    if (afterDeduct === null) return answerCallback(token, callbackId, "❌ 积分不足，无法双倍下注！", true);

    // 原子占用「双倍」名额：并发的第二次点击会更新 0 行，把它扣掉的那份退回去
    const res = await env.DB.prepare(
      `UPDATE ${TABLE} SET bet = bet * 2, doubled = 1, updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ? AND user_key = ? AND status = 'playing' AND doubled = 0`
    ).bind(String(chatId), String(userKey)).run();

    if (Number(res?.meta?.changes) !== 1) {
      await refundPoint(env, userKey, session.bet, "21 点双倍下注重复点击退款");
      const fresh = await loadSession(env, chatId, userKey);
      const parsed = fresh ? parseSession(fresh) : null;
      if (parsed) {
        await answerCallback(token, callbackId, "本局已经双倍过了", true);
        return renderTable(token, chatId, messageId, parsed, await getUserPoints(env, userKey));
      }
      return answerCallback(token, callbackId, "本局已结束", true);
    }

    session.bet *= 2;
    session.doubled = true;
    session.player.push(draw(session));

    if (isBust(session.player)) {
      return finishRound(token, env, { callbackId, chatId, userKey, messageId, state: session });
    }

    // 双倍后不再询问，直接走完庄家回合
    while (dealerShouldHit(session.dealer)) {
      session.dealer.push(draw(session));
    }
    return finishRound(token, env, { callbackId, chatId, userKey, messageId, state: session });
  }
};

/** 取进行中的牌局；没有就返回一句可直接回执的提示 */
async function requireSession(env, chatId, userKey) {
  if (!env?.DB) return { ok: false, message: "❌ 未绑定数据库！" };
  const row = await loadSession(env, chatId, userKey);
  if (!row) return { ok: false, message: "没有进行中的牌局，请重新下注" };
  const session = parseSession(row);
  if (!session) {
    await dropSession(env, chatId, userKey);
    return { ok: false, message: "牌局数据异常，已为你作废（本金会在定时任务里退回）" };
  }
  return { ok: true, session };
}

/** 供定时任务使用：过期的牌局要退还本金 */
export { loadSession as loadBlackjackSession, dropSession as dropBlackjackSession };
