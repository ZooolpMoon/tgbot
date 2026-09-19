// ==========================================
// 🤖 21 点：AI 庄家的台词
//
// 只做一件事：把这一局的情况交给模型，换一句 15~40 字的吐槽 / 解说。
//
// 为什么不让它决定要不要牌：庄家的判定必须公平、可验证（见 blackjack.js 的
// dealerShouldHit）。模型决策既慢（每次要牌都要调一次）又可能乱来
// （20 点还要牌），用户只会觉得机器人在作弊。
//
// 失败策略：台词是锦上添花，**调用失败 / 超时一律回退内置台词**，绝不让牌局卡住。
// 只调主模型、不跑整条回退链：为一句吐槽多等 2~4 秒不值得
// （对比 handlers/ai.js 的 runAIWithFallback，那是 AI 对话的主路径，才需要整链回退）。
// ==========================================

import { AI_MODELS } from "../config/constants.js";
import { randomInt } from "../utils/random.js";
import { logWarn } from "../core/logger.js";

const TIMEOUT_MS = 8000;
const MAX_LINE_CHARS = 60;

/** 模型不可用时的内置台词（按结果分，随机取一条） */
export const FALLBACK_LINES = {
  win: [
    "这把你赢了，下一把可没这么好运。",
    "手气不错。要不要再来一局，把它还回来？",
    "行，算你走运。我记住你了。"
  ],
  blackjack: [
    "21 点，漂亮。这副牌归你了。",
    "开门就是 Blackjack？有点东西。",
    "首两张就 21 点……我认。"
  ],
  lose: [
    "承让了。庄家的位置不是白坐的。",
    "感谢惠顾，欢迎再来送积分。",
    "爆了。要牌之前先想想，别贪。"
  ],
  push: [
    "平局。谁也没占到便宜，再来？",
    "点数一样，这把算打个照面。"
  ]
};

/** 随机取一条内置台词 */
export function pickFallbackLine(outcome) {
  const lines = FALLBACK_LINES[outcome] || FALLBACK_LINES.lose;
  return lines[randomInt(lines.length)];
}

/** 主模型：env.AI_MODELS 的第一项优先，否则用内置主模型 */
export function pickDealerModel(env) {
  const raw = env?.AI_MODELS ? String(env.AI_MODELS) : "";
  const custom = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return custom.length > 0 ? custom[0] : AI_MODELS[0];
}

/** 兼容不同模型的返回结构 */
export function extractLine(res) {
  const text = res?.response || res?.choices?.[0]?.message?.content || res?.result?.response || "";
  return typeof text === "string" ? text : "";
}

/** 成对的引号；只剥「整句被一对引号包住」的情况，句中引用不动 */
const QUOTE_PAIRS = [
  ['"', '"'], ["'", "'"], ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"]
];

function stripWrappingQuotes(text) {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length > open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim();
    }
  }
  return text;
}

/**
 * 清洗模型输出：
 * 去掉标签与换行、压成一句、剥掉包裹整句的引号，并限制长度。
 * （返回值还要由渲染层过一遍 escapeHtml，这里只做「别把格式搞乱」。）
 */
export function sanitizeLine(raw) {
  let text = String(raw || "").replace(/<[^>]*>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  text = stripWrappingQuotes(text);
  if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS - 1) + "…";
  return text;
}

const SYSTEM_PROMPT =
  "你是 Telegram 里 21 点游戏的庄家，正在和玩家对赌。玩家刚打完一局，" +
  "你来说一句点评：可以得意、可以自嘲、可以激他再来一局，但不要侮辱人、" +
  "不要脏话、不要提 AI 或模型。只用中文输出这一句话本身，" +
  "不要引号、不要 emoji、不要换行、不要任何解释，长度 15~40 字。";

function buildPrompt({ player, dealer, bet, outcome, reason }) {
  const label = {
    win: "玩家赢了",
    blackjack: "玩家拿到 Blackjack 赢了三倍本金的一半",
    push: "平局退了本金",
    lose: "玩家输了"
  }[outcome] || "玩家输了";
  return [
    `玩家手牌：${player.join(" ")}`,
    `你的手牌：${dealer.join(" ")}`,
    `下注：${bet} 积分`,
    `结算依据：${reason}`,
    `结果：${label}`,
    ``,
    `请说一句${outcome === "lose" ? "安抚里带点得意" : "回应这个结果"}的话。`
  ].join("\n");
}

/** 给 Promise 套一个超时；超时返回 null（原请求会被 Worker 回收，不影响结算） */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 生成庄家台词。**永远不会抛异常**：拿不到就用内置台词。
 * @param {object} env
 * @param {{player:string[], dealer:string[], bet:number, outcome:string, reason:string}} info
 * @returns {Promise<string>}
 */
export async function dealerLine(env, info) {
  const fallback = pickFallbackLine(info?.outcome);
  if (!env?.AI) return fallback;

  const model = pickDealerModel(env);
  if (!model) return fallback;

  try {
    const res = await withTimeout(
      env.AI.run(model, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(info) }
        ],
        max_tokens: 80
      }),
      TIMEOUT_MS
    );
    const line = sanitizeLine(extractLine(res));
    return line || fallback;
  } catch (e) {
    logWarn("21 点 AI 台词生成失败，改用内置台词：", e?.message || e);
    return fallback;
  }
}
