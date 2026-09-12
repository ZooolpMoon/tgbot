// ==========================================
// 🛡️ 群规执法（Group Guard）
//
// 使用场景：管理员在群里 @ 机器人，自然语言下达处置指令，例如：
//   @Bot 封禁 @某人 发广告刷屏
//   @Bot 把 @某人 禁言 2 小时，辱骂他人
//   @Bot 踢出 @某人 发诈骗链接
//   @Bot 解封 @某人 已经改正
//
// 安全设计（这是「能自动执法」的关键）：
//   1. 必须给出**理由**，且理由要能对上「群规 / 违规类型」，否则拒绝执行；
//   2. 只允许「机器人管理员」或「本群管理员（creator/administrator）」发起；
//   3. 破坏性动作一律先弹**确认卡片**（可改处置方式），确认后才落地；
//   4. 全过程写入 group_punishments，可审计、可追溯。
//
// 两种处置通道：
//   • 机器人功能封禁 —— 写 users.blocked，机器人停止服务该用户（私聊 + 所有群）
//   • 群组处置      —— 走 Telegram：踢出（可重新加入）/ 群内封禁 / 限时禁言
// ==========================================

import {
  banChatMember, unbanChatMember, restrictChatMember, getChatMember, getMe
} from "../telegram/api.js";
import { buildUserKey } from "../core/context.js";
import { setUserBlocked } from "./users.js";
import { bigramScore, searchKnowledge } from "./knowledge.js";
import { logError } from "../core/logger.js";

// ==========================================
// 处置动作
// ==========================================

/** 动作定义：key → 文案、是否需要时长、是否破坏性 */
export const ACTIONS = {
  bot_ban: { label: "🚫 机器人封禁", short: "机器人封禁", needsDuration: false, destructive: true },
  kick: { label: "👢 踢出群组（可重新加入）", short: "踢出群组", needsDuration: false, destructive: true },
  group_ban: { label: "🔨 群内封禁（不可重新加入）", short: "群内封禁", needsDuration: false, destructive: true },
  mute: { label: "🔇 群内禁言", short: "群内禁言", needsDuration: true, destructive: true },
  unban: { label: "✅ 解除封禁（机器人 + 群）", short: "解除封禁", needsDuration: false, destructive: false },
  unmute: { label: "🔊 解除禁言", short: "解除禁言", needsDuration: false, destructive: false }
};

/** 动作关键词（顺序很重要：先判「解除」，再判具体处置） */
const ACTION_KEYWORDS = [
  { action: "unmute", words: ["解除禁言", "取消禁言", "解除群禁言", "解禁"] },
  { action: "unban", words: ["解封", "解除封禁", "取消封禁", "解除群封", "解除黑名单", "移出黑名单"] },
  { action: "mute", words: ["禁言", "闭嘴", "禁声", "消停", "禁麦"] },
  { action: "group_ban", words: ["群内封禁", "群里封禁", "群封", "永久踢出", "拉黑"] },
  { action: "kick", words: ["踢出", "踢掉", "踢了", "移除群", "移出群", "请出群", "清理出群", "飞出去"] },
  { action: "bot_ban", words: ["封禁", "封了", "ban", "黑名单"] }
];

/** 内置违规类型：群规没写清楚时的兜底判定 */
export const VIOLATION_RULES = [
  { key: "ad", label: "广告 / 推广引流", keywords: ["广告", "推广", "引流", "拉人", "拉群", "私加", "加我", "微商", "刷单", "带货"] },
  { key: "spam", label: "刷屏 / 灌水", keywords: ["刷屏", "刷广告", "灌水", "重复发", "刷表情", "连续发", "霸屏", "刷图"] },
  { key: "abuse", label: "辱骂 / 人身攻击", keywords: ["辱骂", "骂人", "人身攻击", "攻击", "侮辱", "诅咒", "地域黑", "歧视"] },
  { key: "harass", label: "骚扰 / 私聊骚扰", keywords: ["骚扰", "私聊骚扰", "纠缠", "威胁", "恐吓", "跟踪"] },
  { key: "porn", label: "色情 / 低俗内容", keywords: ["色情", "涉黄", "低俗", "裸露", "开车", "黄图", "擦边"] },
  { key: "scam", label: "诈骗 / 赌博 / 违法", keywords: ["诈骗", "骗子", "骗钱", "赌博", "博彩", "洗钱", "违法", "外挂", "代练", "刷分"] },
  { key: "link", label: "违规链接 / 不明文件", keywords: ["链接", "外链", "不明文件", "木马", "病毒", "盗号", "钓鱼"] },
  { key: "leak", label: "泄露隐私 / 人肉", keywords: ["隐私", "人肉", "开盒", "手机号", "身份证", "住址", "截图他人"] },
  { key: "politics", label: "政治敏感 / 暴恐", keywords: ["政治", "敏感", "暴恐", "极端", "煽动", "分裂"] },
  { key: "vip", label: "恶意刷群权益 / 打扰管理", keywords: ["恶意@", "@全体", "at全体", "捣乱", "不服从管理", "顶撞管理", "挑衅管理"] }
];

// ==========================================
// 解析「处置指令」
// ==========================================

/** 时长表达式 → 分钟（0 表示永久） */
const DURATION_RE = /(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|时|天|日|周|月)/g;
const PERMANENT_WORDS = ["永久", "永远", "长期", "无限期", "一直"];

/**
 * 从文本里提取禁言时长（分钟）。
 * @returns {{minutes:number, matched:boolean}} minutes = 0 且 matched = true 表示「永久」
 */
export function parseDuration(text) {
  const src = String(text || "");
  let minutes = 0;
  let matched = false;

  for (const m of src.matchAll(DURATION_RE)) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    matched = true;
    const unit = m[2];
    const factor = unit === "秒" ? 1 / 60
      : unit === "分钟" || unit === "分" ? 1
        : unit === "小时" || unit === "时" ? 60
          : unit === "天" || unit === "日" ? 60 * 24
            : unit === "周" ? 60 * 24 * 7
              : 60 * 24 * 30;
    minutes += value * factor;
  }

  if (!matched && PERMANENT_WORDS.some((w) => src.includes(w))) {
    return { minutes: 0, matched: true };
  }
  return { minutes: Math.round(minutes), matched };
}

/** 把时长格式化成中文文案 */
export function formatDuration(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  if (n <= 0) return "永久";
  if (n < 60) return `${n} 分钟`;
  if (n % (60 * 24) === 0) return `${n / (60 * 24)} 天`;
  if (n % 60 === 0) return `${n / 60} 小时`;
  return `${Math.floor(n / 60)} 小时 ${n % 60} 分钟`;
}

/** 识别动作；没有明显动作词时返回 null */
export function detectAction(text) {
  const src = String(text || "").toLowerCase();
  for (const item of ACTION_KEYWORDS) {
    if (item.words.some((w) => src.includes(w.toLowerCase()))) return item.action;
  }
  return null;
}

/** 是不是一条「处置指令」（用于判断要不要拦截这条消息） */
export function looksLikeGuardCommand(text) {
  return detectAction(text) !== null;
}

/** 去掉理由里的噪声词：机器人 @、动作词、时长、标点与常见语气词 */
function cleanReason(text, { botUsername, targetMention }) {
  let out = String(text || "");
  if (botUsername) out = out.replace(new RegExp(`@${botUsername}`, "gi"), " ");
  out = out.replace(/^\/\w+(@\w+)?/i, " ");
  if (targetMention) out = out.split(targetMention).join(" ");
  for (const item of ACTION_KEYWORDS) {
    for (const w of item.words) out = out.split(w).join(" ");
  }
  out = out.replace(DURATION_RE, " ");
  for (const w of PERMANENT_WORDS) out = out.split(w).join(" ");
  out = out.replace(/[，,。；;：:！!？?、"'“”‘’（）()【】\[\]<>《》~～]/g, " ");
  for (const w of ["请", "麻烦", "帮我", "给他", "给她", "该用户", "这个用户", "那个用户", "此用户", "用户", "因为", "由于", "理由", "原因", "一下", "已经", "再次", "处理", "处置", "执行"]) {
    out = out.split(w).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 解析处置指令，找出「处置谁、什么动作、什么理由、多久」。
 *
 * @param {{env:object, text:string, message:object, botUsername?:string, defaultAction?:string, defaultMuteMinutes?:number}} params
 * @returns {Promise<{ok:boolean, error?:string, action?:string, userId?:string, userLabel?:string, reason?:string, durationMin?:number}>}
 */
export async function parsePunishmentRequest({
  env, text, message, botUsername = "", defaultAction = "bot_ban", defaultMuteMinutes = 60,
  forcedAction = null
}) {
  const src = String(text || "");
  // 指令形式（/kick 等）由调用方直接指定动作，不必再靠关键词猜
  const action = forcedAction || detectAction(src);
  if (!action) return { ok: false, error: "没听懂要做什么（可用：封禁 / 踢出 / 禁言 / 解封 / 解除禁言）" };

  // ---------- 找目标用户 ----------
  let userId = null;
  let userLabel = "";
  let targetMention = "";

  // 1) 回复某人的消息：最可靠
  const replied = message?.reply_to_message?.from;
  if (replied?.id && !replied.is_bot) {
    userId = String(replied.id);
    userLabel = replied.username ? `@${replied.username}` : (replied.first_name || String(replied.id));
  }

  // 2) 文本提及（text_mention 带用户对象，mention 只有用户名）
  if (!userId) {
    const entities = Array.isArray(message?.entities) ? message.entities : [];
    for (const e of entities) {
      // 实体长度偶尔会带上尾部空格，统一 trim 后再比对
      const chunk = src.slice(e.offset || 0, (e.offset || 0) + (e.length || 0)).trim();
      if (botUsername && chunk.replace(/^@/, "").toLowerCase() === botUsername.toLowerCase()) continue;

      if (e.type === "text_mention" && e.user?.id && !e.user.is_bot) {
        userId = String(e.user.id);
        userLabel = e.user.username ? `@${e.user.username}` : (e.user.first_name || e.user.id);
        targetMention = chunk;
        break;
      }
      if (e.type === "mention" && chunk.startsWith("@")) {
        const username = chunk.slice(1);
        const target = await findUserByUsername(env, username);
        if (target) {
          userId = String(target.user_id);
          userLabel = `@${username}`;
          targetMention = chunk;
          break;
        }
        return {
          ok: false,
          error: `没找到 ${chunk} 对应的用户（对方得先和机器人聊过天我才能查到 ID）。\n可以改用「回复对方消息」的方式下达指令。`
        };
      }
    }
  }

  // 3) 直接写数字 ID
  if (!userId) {
    const byId = src.match(/(?:^|\s)(\d{5,})/);
    if (byId) {
      userId = byId[1];
      userLabel = byId[1];
      targetMention = byId[1];
    }
  }

  if (!userId) {
    return {
      ok: false,
      error: "没找到要处置的用户。\n• 可以<b>回复对方的消息</b>并 @我 说「封禁 原因」\n• 或写 @用户名 / 用户ID"
    };
  }

  // ---------- 时长 ----------
  const duration = parseDuration(src);
  const durationMin = action === "mute"
    ? (duration.matched ? duration.minutes : defaultMuteMinutes)
    : 0;

  const reason = cleanReason(src, { botUsername, targetMention });
  return { ok: true, action, userId, userLabel, reason, durationMin };
}

/** 按用户名在库里找人（群成员 or 私聊用户） */
export async function findUserByUsername(env, username) {
  if (!env?.DB) return null;
  const name = String(username || "").replace(/^@/, "").trim();
  if (!name) return null;
  return env.DB.prepare(
    `SELECT user_key, user_id, first_name FROM user_scenes
     WHERE LOWER(username) = LOWER(?) AND user_id IS NOT NULL AND user_id <> ''
     ORDER BY updated_at DESC LIMIT 1`
  ).bind(name).first();
}

// ==========================================
// 理由校验（核心：理由必须对得上群规/违规类型）
// ==========================================

/**
 * 校验处置理由是否成立。
 * 判定顺序：内置违规类型关键词 → 群规文本相似度 → 群知识库检索。
 *
 * @returns {Promise<{ok:boolean, matchedRule:string, how:string, error?:string}>}
 */
export async function validateReason({ env, reason, rules = "", chatId = null, minScore = 0.30 }) {
  const text = String(reason || "").trim();
  if (text.length < 2) {
    return { ok: false, matchedRule: "", how: "", error: "没有说明理由" };
  }

  // 1) 内置违规类型
  for (const rule of VIOLATION_RULES) {
    const hit = rule.keywords.find((k) => text.includes(k));
    if (hit) return { ok: true, matchedRule: rule.label, how: `违规类型「${hit}」` };
  }

  // 2) 与本群群规文本比对（逐条句子算二元组相似度）
  const ruleText = String(rules || "").trim();
  if (ruleText) {
    const sentences = ruleText
      .split(/[\n。；;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 4);
    for (const sentence of sentences) {
      if (bigramScore(text, sentence) >= minScore) {
        return { ok: true, matchedRule: sentence.slice(0, 40), how: "匹配到本群群规" };
      }
    }
    if (bigramScore(text, ruleText) >= minScore) {
      return { ok: true, matchedRule: ruleText.slice(0, 40), how: "匹配到本群群规" };
    }
  }

  // 3) 本群知识库（群规常常是上传的文档）
  if (env?.DB && chatId) {
    try {
      const hits = await searchKnowledge(env, `group:${chatId}`, text, { topK: 1 });
      if (hits.length > 0) {
        return { ok: true, matchedRule: hits[0].title, how: "匹配到本群知识库" };
      }
    } catch (e) {
      logError("群规校验检索失败：", e);
    }
  }

  return {
    ok: false,
    matchedRule: "",
    how: "",
    error: "理由不符合群规：请说明对方违反了哪条规则"
  };
}

/** 生成「理由不成立」时给管理员的提示（列出可用违规类型 + 本群群规摘要） */
export function reasonRejectHint(rules = "") {
  const labels = VIOLATION_RULES.map((r) => r.label).join("、");
  let text = `⚠️ <b>没有执行</b>：理由必须能对应到违规现象。\n\n`;
  text += `📌 <b>可识别的违规类型：</b>\n${labels}\n`;
  const ruleText = String(rules || "").trim();
  if (ruleText) text += `\n📜 <b>本群群规：</b>\n${ruleText.slice(0, 300)}`;
  else text += `\n💡 本群还没设置群规，可用 <code>/setrules 群规正文</code> 添加，或把群规文档上传到「📚 知识库」。`;
  return text;
}

// ==========================================
// 群配置
// ==========================================

/** 读取群执法配置（没有就用默认值） */
export async function getGroupGuard(env, chatId) {
  const fallback = { chat_id: String(chatId), rules: "", default_action: "bot_ban", default_mute_minutes: 60, enabled: 1 };
  if (!env?.DB || !chatId) return fallback;
  const row = await env.DB.prepare("SELECT * FROM group_guard WHERE chat_id = ?").bind(String(chatId)).first();
  return row ? { ...fallback, ...row } : fallback;
}

/** 写入 / 更新群执法配置 */
export async function setGroupGuard(env, chatId, fields = {}) {
  if (!env?.DB || !chatId) return false;
  const current = await getGroupGuard(env, chatId);
  const rules = fields.rules !== undefined ? String(fields.rules).slice(0, 2000) : current.rules;
  const action = fields.defaultAction !== undefined ? String(fields.defaultAction) : current.default_action;
  const mute = fields.defaultMuteMinutes !== undefined ? Number(fields.defaultMuteMinutes) : current.default_mute_minutes;
  const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : current.enabled;

  await env.DB.prepare(`
    INSERT INTO group_guard (chat_id, rules, default_action, default_mute_minutes, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      rules = EXCLUDED.rules,
      default_action = EXCLUDED.default_action,
      default_mute_minutes = EXCLUDED.default_mute_minutes,
      enabled = EXCLUDED.enabled,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(chatId), rules, action, Math.max(0, Math.floor(mute) || 0), enabled).run();
  return true;
}

// ==========================================
// 权限检查
// ==========================================

let cachedBotId = null;

/** 机器人自己的用户 ID（用于查询自身群权限） */
export async function resolveBotId(token) {
  if (cachedBotId) return cachedBotId;
  const json = await getMe(token);
  cachedBotId = json?.ok && json.result?.id ? String(json.result.id) : null;
  return cachedBotId;
}

/** 机器人是否具备群管理能力 */
export async function getBotGroupRights(token, chatId) {
  const botId = await resolveBotId(token);
  if (!botId) return { isAdmin: false, canRestrict: false, status: "unknown" };
  const json = await getChatMember(token, chatId, botId);
  const member = json?.ok ? json.result : null;
  const isAdmin = member?.status === "administrator" || member?.status === "creator";
  return {
    isAdmin,
    canRestrict: Boolean(member?.can_restrict_members) || member?.status === "creator",
    status: member?.status || "unknown"
  };
}

/** 某个用户是不是本群管理员（creator / administrator） */
export async function isGroupAdmin(token, chatId, userId) {
  const json = await getChatMember(token, chatId, userId);
  const member = json?.ok ? json.result : null;
  return member?.status === "creator" || member?.status === "administrator";
}

// ==========================================
// 处置记录
// ==========================================

/** 新建一条「待确认」记录 */
export async function createPendingPunishment(env, {
  chatId, userId, userLabel = "", action, reason = "", matchedRule = "",
  durationMin = 0, operatorId = "", detail = ""
}) {
  if (!env?.DB) return null;
  const res = await env.DB.prepare(`
    INSERT INTO group_punishments
      (chat_id, user_id, user_label, action, reason, matched_rule, duration_min, operator_id, status, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    String(chatId), String(userId), String(userLabel || ""), String(action),
    String(reason || ""), String(matchedRule || ""), Math.max(0, Math.floor(durationMin) || 0),
    String(operatorId || ""), String(detail || "")
  ).run();
  const id = Number(res?.meta?.last_row_id);
  return id ? { id } : null;
}

/** 读取单条处置记录 */
export async function getPunishment(env, id) {
  if (!env?.DB) return null;
  return env.DB.prepare("SELECT * FROM group_punishments WHERE id = ?").bind(id).first();
}

/** 更新处置状态 */
export async function updatePunishmentStatus(env, id, status, detail = "") {
  if (!env?.DB) return false;
  await env.DB.prepare(
    "UPDATE group_punishments SET status = ?, detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).bind(String(status), String(detail || ""), id).run();
  return true;
}

/** 某个用户在当前群是否还有生效中的处置（用于展示与去重） */
export async function getActivePunishment(env, chatId, userId) {
  if (!env?.DB) return null;
  return env.DB.prepare(
    `SELECT * FROM group_punishments
     WHERE chat_id = ? AND user_id = ? AND status = 'done'
     ORDER BY id DESC LIMIT 1`
  ).bind(String(chatId), String(userId)).first();
}

/** 把已到期的临时禁言标记为过期（定时任务调用） */
export async function expirePunishments(env) {
  if (!env?.DB) return 0;
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    "UPDATE group_punishments SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'done' AND until_at > 0 AND until_at <= ?"
  ).bind(now).run();
  return Number(res?.meta?.changes) || 0;
}

// ==========================================
// 执行处置
// ==========================================

/**
 * 执行处置动作。
 * @param {object} record group_punishments 行（至少含 chat_id / user_id）
 * @param {string} action bot_ban / kick / group_ban / mute / unban / unmute
 * @param {number} durationMin 禁言时长（分钟），0 = 永久
 * @returns {Promise<{ok:boolean, error?:string, untilAt?:number, detail?:string}>}
 */
export async function executePunishment({ env, token, record, action, durationMin }) {
  if (!env?.DB || !record) return { ok: false, error: "缺少参数" };

  const chatId = String(record.chat_id);
  const userId = String(record.user_id);
  const finalAction = action || record.action;
  const duration = Math.max(0, Math.floor(durationMin ?? record.duration_min) || 0);
  const now = Math.floor(Date.now() / 1000);
  const untilAt = duration > 0 ? now + duration * 60 : 0;

  try {
    if (finalAction === "bot_ban") {
      await setUserBlocked(env, buildUserKey(userId), true);
      return { ok: true, untilAt: 0, detail: "已写入机器人封禁名单" };
    }

    if (finalAction === "unban") {
      await setUserBlocked(env, buildUserKey(userId), false);
      await unbanChatMember(token, chatId, userId, false);
      return { ok: true, untilAt: 0, detail: "已解除机器人封禁与群封禁" };
    }

    if (finalAction === "unmute") {
      const res = await restrictChatMember(token, chatId, userId, { mute: false });
      return res?.ok
        ? { ok: true, untilAt: 0, detail: "已解除禁言" }
        : { ok: false, error: res?.description || "解除禁言失败（机器人需要群管理员权限）" };
    }

    if (finalAction === "mute") {
      const res = await restrictChatMember(token, chatId, userId, { mute: true, untilDate: untilAt });
      return res?.ok
        ? { ok: true, untilAt, detail: `已禁言 ${formatDuration(duration)}` }
        : { ok: false, error: res?.description || "禁言失败（机器人需要群管理员权限）" };
    }

    if (finalAction === "kick") {
      // 先封禁再解封 = 踢出（对方可以重新加入）
      const res = await banChatMember(token, chatId, userId);
      if (!res?.ok) return { ok: false, error: res?.description || "踢出失败（机器人需要群管理员权限）" };
      await unbanChatMember(token, chatId, userId);
      return { ok: true, untilAt: 0, detail: "已踢出群组（可重新加入）" };
    }

    if (finalAction === "group_ban") {
      const res = await banChatMember(token, chatId, userId, untilAt, true);
      return res?.ok
        ? { ok: true, untilAt, detail: duration > 0 ? `已在群内封禁 ${formatDuration(duration)}` : "已在群内永久封禁" }
        : { ok: false, error: res?.description || "群内封禁失败（机器人需要群管理员权限）" };
    }

    return { ok: false, error: `未知处置动作：${finalAction}` };
  } catch (e) {
    logError("执行群规处置失败：", e);
    return { ok: false, error: String(e?.message || e) };
  }
}

/** 生成处置结果的群内公告文案 */
export function buildPunishmentNotice({ record, action, durationMin, untilAt, byWhom = "管理员" }) {
  const label = ACTIONS[action]?.label || action;
  const name = record.user_label || record.user_id;
  let text = `🛡️ <b>群规处置</b>\n-------------------------\n`;
  text += `👤 <b>对象：</b> ${name}\n`;
  text += `⚖️ <b>处置：</b> ${label}${action === "mute" || (action === "group_ban" && durationMin > 0) ? `（${formatDuration(durationMin)}）` : ""}\n`;
  if (record.reason) text += `📌 <b>理由：</b> ${record.reason}\n`;
  if (record.matched_rule) text += `📜 <b>依据：</b> ${record.matched_rule}\n`;
  text += `👑 <b>执行：</b> ${byWhom}\n`;
  if (untilAt > 0) {
    const untilText = new Date(untilAt * 1000).toISOString().replace("T", " ").slice(0, 16);
    text += `⏰ <b>到期：</b> ${untilText} UTC\n`;
  }
  return text;
}
