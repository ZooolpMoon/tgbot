// ==========================================
// 🧹 自动反垃圾（v3.10.0）
//
// 与「群规执法」（services/guard.js）的分工：
//   • 执法   = 管理员发现了违规，用 /ban /mute 下指令，理由必须校验通过
//   • 反垃圾 = 机器人自己按**行为特征**兜一层，把明显刷屏先按住
//
// 三条底线（照抄 guard 踩过的坑）：
//   1. **不猜语义**：只看「频率 / 重复 / 新成员发链接」这类客观特征，
//      绝不解析内容含义 —— 「封禁」「拉黑」在日常聊天里太常见。
//   2. **不碰自己人**：群主、本群管理员、机器人管理员 / 执法员一律豁免。
//      自动禁言一个管理员可能把后台访问权限一起锁掉。
//   3. **不越权下重手**：默认只删消息 + 群内提示；禁言只在违规累计到第 2 次、
//      且管理员把动作配成「禁言」时才执行，而且**有期限**（ESCALATE_MINUTES）。
//
// 计数只在 Worker 内存里滚动（isolate 级滑动窗口），**只有真正触发动作时才写
// automod_events** —— D1 的写入量等于违规次数，与群消息量无关。
// 多 isolate 会让计数分片（实际阈值比配置宽松），这是可接受的：
// 反垃圾要拦的是「持续刷屏」，不是精确计费，而所有动作本身都幂等。
// ==========================================

import { AUTOMOD } from "../config/constants.js";
import { buildGroupScopeKey } from "../core/context.js";
import { logError, logInfo } from "../core/logger.js";
import { deleteMessage, getChatMember, restrictChatMember } from "../telegram/api.js";
import { sendAutoDelete } from "../telegram/auto-delete.js";
import { escapeHtml } from "../utils/html.js";
import { getAdminRole } from "./admins.js";
import { cacheClear, cacheGet, cacheSet } from "./cache.js";
import { isFeatureEnabled } from "./features.js";
import { countUsage, METRIC } from "./usage.js";

const PREFIX = "automod.";
/** 配置缓存：每条群消息都要读配置，30 秒 TTL 把 D1 往返降成内存读 */
const CONFIG_CACHE_NS = "automod_config";
const CONFIG_CACHE_TTL_MS = 30 * 1000;
/** 「是不是新成员」的结果缓存：入群时间不会变，缓存到沙盒期结束即可 */
const NEWCOMER_CACHE_NS = "automod_newcomer";
const NEWCOMER_CACHE_TTL_MS = AUTOMOD.NEWBIE_MINUTES * 60 * 1000;

/** 反垃圾的群级默认配置（写进 scene_settings 覆盖） */
export const AUTOMOD_DEFAULTS = {
  // 三条规则各自可关
  flood: true,     // 刷屏 / 超长
  repeat: true,    // 重复刷同一句
  link: true,      // 新成员发链接、转发
  // 触发后的动作：delete = 只删消息；mute = 第 2 次起递进禁言
  action: "delete",
  // 是否在群里发一条提示（默认发，让当事人知道消息被删了）
  notice: true
};

export const AUTOMOD_ACTIONS = ["delete", "mute"];

/**
 * isolate 级滑动窗口。
 * key = `${chatId}:${userId}`，value = { msgs: [{ t, text }], lastActionAt }
 */
const windows = new Map();

/** 清空窗口（测试用；线上不需要） */
export function resetAutoModWindows() {
  windows.clear();
}

function windowOf(key) {
  let win = windows.get(key);
  if (!win) {
    // 超过上限就整体清空：反垃圾的计数丢了只是「这一次不拦」，
    // 比 isolate 内存无限增长安全得多。
    if (windows.size >= AUTOMOD.WINDOW_MAX_KEYS) windows.clear();
    win = { msgs: [], lastActionAt: 0 };
    windows.set(key, win);
  }
  return win;
}

/** 丢掉窗口里过期的记录，只保留最长的那个窗口（一分钟） */
function trimWindow(win, now) {
  const keepMs = Math.max(AUTOMOD.FLOOD_WINDOW_SEC, AUTOMOD.REPEAT_WINDOW_SEC) * 1000;
  const cutoff = now - keepMs;
  while (win.msgs.length > 0 && win.msgs[0].t < cutoff) win.msgs.shift();
  // 再兜一道条数上限，防止有人用极短消息灌爆内存
  if (win.msgs.length > 200) win.msgs.splice(0, win.msgs.length - 200);
}

/** 判重用的归一化：去空白、统一小写、砍掉长度差异 */
function normalize(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase().slice(0, 200);
}

const LINK_RE = /(?:https?:\/\/|t\.me\/|telegram\.me\/|www\.[a-z0-9-]+\.[a-z]{2,})/i;

/** 消息里是否带链接（正文明链 + Telegram 的 text_link 实体都要看） */
export function hasLink(message) {
  const text = String(message?.text || "");
  if (LINK_RE.test(text)) return true;
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  return entities.some((e) => e?.type === "text_link" || e?.type === "url");
}

/** 是否是转发消息（新旧字段都认，Telegram 换过字段名） */
export function isForwarded(message) {
  return Boolean(
    message?.forward_origin
    || message?.forward_from
    || message?.forward_from_chat
    || message?.forward_sender_name
  );
}

/**
 * 只靠内存就能判定的违规（不查库）：刷屏、超长、重复。
 * 纯函数，方便测试直接构造窗口做断言。
 * @returns {{rule:string, detail:string}|null}
 */
export function detectBehaviorViolation({ msgs, text, now, config }) {
  const list = Array.isArray(msgs) ? msgs : [];
  const body = String(text || "");

  if (config?.flood) {
    const cutoff = now - AUTOMOD.FLOOD_WINDOW_SEC * 1000;
    const recent = list.filter((m) => m.t >= cutoff).length;
    if (recent >= AUTOMOD.FLOOD_MAX_MESSAGES) {
      return { rule: "flood", detail: `${AUTOMOD.FLOOD_WINDOW_SEC} 秒内 ${recent + 1} 条` };
    }
    if (body.length > AUTOMOD.MAX_MESSAGE_CHARS) {
      return { rule: "flood", detail: `单条消息 ${body.length} 字` };
    }
  }

  if (config?.repeat && body.trim()) {
    const cutoff = now - AUTOMOD.REPEAT_WINDOW_SEC * 1000;
    const key = normalize(body);
    const same = list.filter((m) => m.t >= cutoff && normalize(m.text) === key).length;
    if (key.length >= 2 && same >= AUTOMOD.REPEAT_MAX) {
      return { rule: "repeat", detail: `同一内容重复 ${same + 1} 次` };
    }
  }

  return null;
}

/** 新成员沙盒：入群初期不准发链接 / 转发 */
export function detectNewcomerViolation({ message }) {
  if (hasLink(message)) return { rule: "link", detail: "新成员发链接" };
  if (isForwarded(message)) return { rule: "link", detail: "新成员转发消息" };
  return null;
}

// ==========================================
// ⚙️ 群级配置（scene_settings，群作用域）
// ==========================================

export async function getAutoModConfig(env, chatId) {
  const fallback = { ...AUTOMOD_DEFAULTS };
  if (!env?.DB || !chatId) return fallback;

  const cached = cacheGet(CONFIG_CACHE_NS, String(chatId), env.DB);
  if (cached) return cached;

  try {
    const { results } = await env.DB.prepare(
      "SELECT name, value FROM scene_settings WHERE scene_key = ? AND name LIKE ?"
    ).bind(buildGroupScopeKey(chatId), `${PREFIX}%`).all();

    const out = { ...fallback };
    for (const row of results || []) {
      const key = String(row.name || "").slice(PREFIX.length);
      const val = String(row.value || "");
      if (key === "action") {
        out.action = AUTOMOD_ACTIONS.includes(val) ? val : fallback.action;
      } else if (key in out) {
        out[key] = val !== "off";
      }
    }
    return cacheSet(CONFIG_CACHE_NS, String(chatId), out, CONFIG_CACHE_TTL_MS, env.DB);
  } catch (e) {
    logError("读取自动反垃圾配置失败：", e);
    return fallback;
  }
}

export async function setAutoModConfig(env, chatId, fields = {}) {
  if (!env?.DB || !chatId) return false;
  const current = await getAutoModConfig(env, chatId);
  const next = { ...current };

  for (const key of ["flood", "repeat", "link", "notice"]) {
    if (fields[key] !== undefined) next[key] = Boolean(fields[key]);
  }
  if (fields.action !== undefined && AUTOMOD_ACTIONS.includes(String(fields.action))) {
    next.action = String(fields.action);
  }

  const scopeKey = buildGroupScopeKey(chatId);
  const stmts = Object.entries(next).map(([key, value]) => env.DB.prepare(`
    INSERT INTO scene_settings (scene_key, name, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scene_key, name) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `).bind(
    scopeKey,
    `${PREFIX}${key}`,
    key === "action" ? value : (value ? "on" : "off")
  ));

  await env.DB.batch(stmts);
  cacheClear(CONFIG_CACHE_NS);
  return true;
}

// ==========================================
// 👋 新成员记录（与欢迎开关无关）
// ==========================================

/**
 * 记下入群时间。**不管「入群欢迎」开关是开是关都要记** ——
 * 反垃圾要靠它判断「是不是刚进群」，否则新成员沙盒永远不生效。
 */
export async function noteNewcomers(env, chatId, members = []) {
  if (!env?.DB || !chatId || !Array.isArray(members) || members.length === 0) return 0;
  const nowSec = Math.floor(Date.now() / 1000);

  const stmts = members
    .filter((m) => m?.id && !m?.is_bot)
    .map((m) => env.DB.prepare(`
      INSERT INTO group_newcomers (chat_id, user_id, joined_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET joined_at = EXCLUDED.joined_at
    `).bind(String(chatId), String(m.id), nowSec));

  if (stmts.length === 0) return 0;
  try {
    await env.DB.batch(stmts);
    // 入群时间变了，把「不是新成员」的负缓存清掉
    cacheClear(NEWCOMER_CACHE_NS);
    return stmts.length;
  } catch (e) {
    logError("记录新成员时间失败：", e);
    return 0;
  }
}

/** 这个人是不是「刚进群」（默认 30 分钟内） */
export async function isNewcomer(env, chatId, userId, minutes = AUTOMOD.NEWBIE_MINUTES) {
  if (!env?.DB || !chatId || !userId) return false;
  // 入群时间一旦写下来就不变，缓存到 isolate 里（含「不是新成员」的负结果），
  // 否则每条群消息都要为「新成员沙盒」多查一次 D1。
  const cacheKey = `${chatId}:${userId}`;
  const cached = cacheGet(NEWCOMER_CACHE_NS, cacheKey, env.DB);
  if (cached !== undefined) {
    const joinedSec = Number(cached) || 0;
    return joinedSec > 0 && (Date.now() / 1000 - joinedSec) <= minutes * 60;
  }

  try {
    const row = await env.DB.prepare(
      "SELECT joined_at FROM group_newcomers WHERE chat_id = ? AND user_id = ?"
    ).bind(String(chatId), String(userId)).first();
    const joinedSec = Number(row.joined_at) || 0;
    // -1 = 明确记下「查过、不是新成员」，避免每次消息都回查
    cacheSet(NEWCOMER_CACHE_NS, cacheKey, joinedSec > 0 ? joinedSec : -1, NEWCOMER_CACHE_TTL_MS, env.DB);
    if (!row) return false;
    return joinedSec > 0 && (Date.now() / 1000 - joinedSec) <= minutes * 60;
  } catch (e) {
    logError("读取新成员时间失败：", e);
    return false;
  }
}

// ==========================================
// 🛡️ 豁免名单
// ==========================================

/**
 * 该不该对这个人动手。
 * 群主 / 本群管理员 / 机器人管理员 / 执法员 / 机器人自己都豁免。
 * 这个检查只在**已经判定违规**之后才跑，所以 getChatMember 的调用量 = 违规次数。
 */
async function isProtectedMember({ env, token, chatId, userId, myId }) {
  if (myId && String(userId) === String(myId)) return true;

  const role = await getAdminRole(env, userId, { ownerId: myId });
  if (role) return true;

  try {
    const info = await getChatMember(token, chatId, userId);
    const status = String(info?.result?.status || "");
    return status === "creator" || status === "administrator";
  } catch (e) {
    // 查不到状态时**宁可放过**：反垃圾是兜底，不该因为一次 API 抖动就误伤
    return true;
  }
}

// ==========================================
// 📝 记录与递进
// ==========================================

/** 违规次数 +1，返回新的次数（原子自增，并发下也不会互相覆盖） */
async function bumpStrikes(env, chatId, userId) {
  try {
    const row = await env.DB.prepare(`
      INSERT INTO automod_strikes (chat_id, user_id, strikes, last_at)
      VALUES (?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        strikes = strikes + 1,
        last_at = CURRENT_TIMESTAMP
      RETURNING strikes
    `).bind(String(chatId), String(userId)).first();
    return Number(row?.strikes) || 1;
  } catch (e) {
    // RETURNING 在个别环境不支持时退回「写入 + 读取」，最坏情况是次数偏小，
    // 影响的是处罚档位，不会造成误伤
    try {
      await env.DB.prepare(`
        INSERT INTO automod_strikes (chat_id, user_id, strikes, last_at)
        VALUES (?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(chat_id, user_id) DO UPDATE SET
          strikes = strikes + 1, last_at = CURRENT_TIMESTAMP
      `).bind(String(chatId), String(userId)).run();
      const row = await env.DB.prepare(
        "SELECT strikes FROM automod_strikes WHERE chat_id = ? AND user_id = ?"
      ).bind(String(chatId), String(userId)).first();
      return Number(row?.strikes) || 1;
    } catch (e2) {
      logError("累计违规次数失败：", e2);
      return 1;
    }
  }
}

/** 当前违规次数（面板展示用） */
export async function getStrikes(env, chatId, userId) {
  if (!env?.DB) return 0;
  const row = await env.DB.prepare(
    "SELECT strikes FROM automod_strikes WHERE chat_id = ? AND user_id = ?"
  ).bind(String(chatId), String(userId)).first();
  return Number(row?.strikes) || 0;
}

export async function clearStrikes(env, chatId, userId) {
  if (!env?.DB) return 0;
  const res = await env.DB.prepare(
    "DELETE FROM automod_strikes WHERE chat_id = ? AND user_id = ?"
  ).bind(String(chatId), String(userId)).run();
  return Number(res.meta?.changes) || 0;
}

async function recordEvent(env, { chatId, userId, userLabel, rule, action, detail, msgId }) {
  try {
    await env.DB.prepare(`
      INSERT INTO automod_events (chat_id, user_id, user_label, rule, action, detail, msg_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(chatId), String(userId), String(userLabel || "").slice(0, 60),
      String(rule), String(action), String(detail || "").slice(0, 120),
      Number(msgId) || 0
    ).run();
  } catch (e) {
    logError("写入反垃圾记录失败：", e);
  }
}

/** 最近的自动反垃圾记录（面板用） */
export async function listAutoModEvents(env, chatId, limit = 20) {
  if (!env?.DB || !chatId) return [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM automod_events WHERE chat_id = ? ORDER BY id DESC LIMIT ?"
    ).bind(String(chatId), Math.max(1, Math.min(50, Number(limit) || 20))).all();
    return results || [];
  } catch (e) {
    logError("读取反垃圾记录失败：", e);
    return [];
  }
}

/** 某个群今天被自动处理了多少次（群报用） */
export async function countAutoModToday(env, chatId, dateStr) {
  if (!env?.DB || !chatId) return 0;
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM automod_events WHERE chat_id = ? AND created_at >= ? AND created_at < ?"
    ).bind(String(chatId), `${dateStr} 00:00:00`, `${dateStr} 23:59:59`).first();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

// ==========================================
// 🚦 主入口
// ==========================================

const RULE_LABEL = { flood: "刷屏", repeat: "重复发言", link: "新成员发链接" };

/** 规则 → 中文标签（面板与提示文案共用） */
export function ruleLabel(rule) {
  return RULE_LABEL[rule] || rule;
}

/** 第 N 次违规该禁言多久（分钟） */
export function escalateMinutes(strikes) {
  const table = AUTOMOD.ESCALATE_MINUTES || [];
  if (table.length === 0) return 60;
  const idx = Math.min(Math.max(1, Number(strikes) || 1) - 1, table.length - 1);
  return table[idx];
}

/**
 * 决定这次该做什么（纯函数，方便测试）。
 * 默认只删消息；只有管理员选了「禁言」且已经是第 2 次及以上才升级。
 */
export function decideAction(config, strikes) {
  if (config?.action === "mute" && Number(strikes) >= 2) return "mute";
  return "delete";
}

/**
 * 群消息的反垃圾入口。命中并处置返回 true，否则 false。
 *
 * 调用位置在 message.js 的群聊分支，**所有群消息都要过**（包括 @ 机器人的），
 * 但以 `/` 开头的指令跳过 —— 管理员执行 /ban 时不该被当成刷屏。
 */
export async function handleAutoMod({ env, token, ctx = null, chatId, uctx, message, myId }) {
  if (!env?.DB || !chatId || !uctx?.userId) return false;
  if (!message || message.from?.is_bot) return false;

  const text = String(message.text || message.caption || "");
  // 指令不参与反垃圾：管理员连发几条执法指令是正常工作流
  if (text.trim().startsWith("/")) return false;
  if (!text.trim()) return false;

  const groupKey = buildGroupScopeKey(chatId);
  try {
    if (!(await isFeatureEnabled(env, groupKey, "automod"))) return false;
  } catch (e) {
    logError("读取反垃圾开关失败：", e);
    return false;
  }

  const config = await getAutoModConfig(env, chatId);
  const now = Date.now();
  const key = `${chatId}:${uctx.userId}`;
  const win = windowOf(key);

  // 第一步：纯内存判定（绝大多数消息到这里就结束了，零 D1 往返）
  let hit = detectBehaviorViolation({ msgs: win.msgs, text, now, config });

  // 第二步：只有「新成员沙盒」需要查库，且只在前面没命中时才查
  const isNewbie = hit ? false : await isNewcomer(env, chatId, uctx.userId);
  if (!hit && config.link && isNewbie) {
    hit = detectNewcomerViolation({ message });
  }

  // 不管有没有违规，窗口都要滚动
  win.msgs.push({ t: now, text });
  trimWindow(win, now);

  if (!hit) return false;

  // 一次刷屏只处理一次：否则连发 20 条会刷出十几条记录与十几条提示
  if (now - win.lastActionAt < AUTOMOD.COOLDOWN_SEC * 1000) return false;
  win.lastActionAt = now;

  // 已经判定违规，才值得花一次 getChatMember 去确认「是不是自己人」
  if (await isProtectedMember({ env, token, chatId, userId: uctx.userId, myId })) return false;

  const strikes = await bumpStrikes(env, chatId, uctx.userId);
  const action = decideAction(config, strikes);
  const msgId = Number(message.message_id) || 0;
  const label = uctx.username ? `@${uctx.username}` : (uctx.firstName || String(uctx.userId));

  // 1) 删消息（删不掉不算失败：可能机器人没有 can_delete_messages）
  if (msgId) {
    try {
      await deleteMessage(token, chatId, msgId);
    } catch (e) {
      logError("反垃圾删除消息失败（可能缺少删除权限）：", e?.message || e);
    }
  }

  // 2) 升级为禁言（有期限，且是递进的）
  let muteMinutes = 0;
  if (action === "mute") {
    muteMinutes = escalateMinutes(strikes);
    try {
      await restrictChatMember(token, chatId, uctx.userId, {
        mute: true,
        untilDate: Math.floor(Date.now() / 1000) + muteMinutes * 60
      });
    } catch (e) {
      muteMinutes = 0;
      logError("反垃圾禁言失败（可能缺少限制成员权限）：", e?.message || e);
    }
  }

  const finalAction = muteMinutes > 0 ? "mute" : "delete";
  countUsage(env, METRIC.AUTOMOD);

  await recordEvent(env, {
    chatId,
    userId: uctx.userId,
    userLabel: label,
    rule: hit.rule,
    action: finalAction,
    detail: hit.detail,
    msgId
  });

  // 3) 群内提示：说清「为什么被删」，但不公开点名羞辱（@ 只用于禁言告知）
  if (config.notice) {
    const head = `🧹 <b>自动反垃圾</b>：${escapeHtml(ruleLabel(hit.rule))}`;
    const tail = muteMinutes > 0
      ? `\n${escapeHtml(label)} 已被禁言 ${muteMinutes} 分钟（第 ${strikes} 次）。`
      : "";
    try {
      await sendAutoDelete(
        token, chatId,
        `${head}${tail}\n如有误判请管理员用 /automod 查看记录。`,
        "HTML", true, ctx,
        { kind: "guard", env, sceneKey: groupKey }
      );
    } catch (e) {
      logError("反垃圾提示发送失败：", e);
    }
  }

  logInfo(`自动反垃圾：群 ${chatId} 用户 ${uctx.userId} 触发 ${hit.rule} → ${finalAction}`);
  return true;
}

/** 定时清理：反垃圾记录保留 30 天，新成员记录只留 7 天 */
export async function cleanupAutoMod(env) {
  if (!env?.DB) return { events: 0, newcomers: 0 };
  const [events, newcomers] = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM automod_events WHERE created_at <= datetime('now', ?)"
    ).bind(`-${AUTOMOD.EVENT_KEEP_DAYS} days`),
    env.DB.prepare(
      "DELETE FROM group_newcomers WHERE joined_at <= ?"
    ).bind(Math.floor(Date.now() / 1000) - 7 * 24 * 3600)
  ]);
  return {
    events: Number(events.meta?.changes) || 0,
    newcomers: Number(newcomers.meta?.changes) || 0
  };
}
