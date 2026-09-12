// ==========================================
// 🧭 命令注册表 + 统一分发（v2.0）
//
// 一条命令的全部信息集中在这里：
//   名称 / 别名 / 权限 / 是否仅私聊 / 归属功能开关 / 说明
// message.js 只负责解析消息与兜底，/help 也由这张表自动生成，
// 不会再出现「改了实现忘了改帮助」。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { ERR } from "../../config/messages.js";
import { featureLabel, isFeatureEnabled } from "../../services/features.js";
import { escapeHtml } from "../../utils/html.js";

import { cmdStart } from "./start.js";
import { cmdHelp } from "./help.js";
import { cmdCheckin } from "./checkin.js";
import { cmdProfile } from "./profile.js";
import { cmdSetLang } from "./setlang.js";
import { cmdSetPrompt } from "./setprompt.js";
import { cmdClear } from "./clear.js";
import { cmdGame } from "./game.js";
import { cmdPoints } from "./points.js";
import { cmdRank } from "./rank.js";
import { cmdTasks } from "./tasks.js";
import { cmdRedeem } from "./redeem.js";
import { cmdShop } from "./shop.js";
import { cmdOrders } from "./orders.js";
import { cmdCodeNew, cmdCodeList } from "./codes.js";
import { cmdClearMem } from "./clearmem.js";
import { cmdBroadcast } from "./broadcast.js";
import { cmdKb } from "./kb.js";
import {
  cmdBan, cmdUnban, cmdKick, cmdMute, cmdUnmute, cmdGroupBan, cmdRules, cmdSetRules
} from "./ban.js";
import { cmdGuard, cmdAppeal, cmdReport } from "./guard.js";
import { cmdSyncMenu } from "./system.js";
import { isGroupAdmin } from "../../services/guard.js";
import { cmdShopEdit } from "../../shop/edit.js";
import { startAddItem, cancelAddItem } from "../../shop/add.js";
import {
  cmdAdminRoot,
  cmdUsersPrivate,
  cmdUsersGroup,
  cmdStats,
  cmdAddPoints,
  checkAdminUnlocked
} from "./admin/index.js";

// ---------- 小工具 ----------
/** 取指令后面的参数文本，例如 argText("/code_new 100", "/code_new") → "100" */
function argText(rawText, name) {
  return String(rawText || "").replace(new RegExp(`^${name}(@\\w+)?`, "i"), "").trim();
}

/** 商城管理入口：动态 import 避免管理端代码进入冷启动路径 */
async function renderShopAdmin(ctx) {
  const { renderShopAdmin: render } = await import("../../shop/admin.js");
  await render(ctx.token, ctx.env, ctx.chatId, null);
}

// ---------- 命令表 ----------
export const COMMANDS = [
  // ===== 普通用户 =====
  {
    name: "/start", desc: "开始使用 / 查看欢迎信息",
    handle: cmdStart
  },
  {
    name: "/help", aliases: ["/h"], desc: "查看指令列表",
    handle: cmdHelp
  },
  {
    name: "/checkin", aliases: ["/sign"], feature: "checkin",
    desc: "每日签到（连续签到奖励递增）", handle: cmdCheckin
  },
  {
    name: "/tasks", aliases: ["/daily"], feature: "tasks",
    desc: "每日任务（完成领积分）", handle: cmdTasks
  },
  {
    name: "/points", aliases: ["/mypoints"],
    desc: "积分流水（可翻页）", handle: cmdPoints
  },
  {
    name: "/rank", aliases: ["/top", "/leaderboard"],
    desc: "积分排行榜 Top 10", handle: cmdRank
  },
  {
    name: "/game", aliases: ["/games"], feature: "game",
    desc: "游戏大厅", handle: cmdGame
  },
  {
    name: "/profile", desc: "个人信息卡片", handle: cmdProfile
  },
  {
    name: "/setlang", desc: "切换 AI 回复语言（zh / en）",
    usage: "/setlang <zh/en>", handle: cmdSetLang
  },
  {
    name: "/setprompt", desc: "设置 / 清空自定义 AI 偏好",
    usage: "/setprompt <设定>", handle: cmdSetPrompt
  },
  {
    name: "/clear", desc: "清空当前场景的对话记忆", handle: cmdClear
  },
  {
    name: "/shop", aliases: ["/store"], feature: "shop", privateOnly: true,
    desc: "积分商城（仅私聊）", handle: cmdShop,
    privateHint: (ctx) => `🛒 商城功能仅支持<b>私聊</b>使用。\n\n请点击下方链接直接与 Bot 私聊：\n👉 私聊我：${ctx.botMention}`
  },
  {
    name: "/orders", aliases: ["/myorders"], feature: "shop", privateOnly: true,
    desc: "我的订单（仅私聊）", handle: cmdOrders,
    privateHint: "📜 订单查询仅支持<b>私聊</b>使用。"
  },
  {
    name: "/redeem", aliases: ["/use"], feature: "redeem", privateOnly: true,
    desc: "用兑换码领积分（仅私聊）", usage: "/redeem <兑换码>",
    handle: cmdRedeem,
    privateHint: "🎟️ 兑换码请到<b>私聊</b>里使用，避免被群里其他人看到。"
  },

  // ===== 管理员（需先 /admin 解锁）=====
  {
    name: "/admin", scope: "admin", needsUnlock: false,
    desc: "打开管理控制台", handle: cmdAdminRoot
  },
  {
    name: "/users", aliases: ["/users_private"], scope: "admin",
    desc: "私聊场景列表", handle: cmdUsersPrivate
  },
  {
    name: "/users_group", scope: "admin",
    desc: "群聊场景列表", handle: cmdUsersGroup
  },
  {
    name: "/stats", scope: "admin",
    desc: "系统使用统计", handle: cmdStats
  },
  {
    name: "/addpoints", scope: "admin",
    desc: "增减用户全局积分", usage: "/addpoints <场景ID> <数量>", handle: cmdAddPoints
  },
  {
    name: "/clearmem", aliases: ["/clearmemory"], scope: "admin",
    desc: "清除指定场景 / 群组 / 群成员的 AI 记忆", usage: "/clearmem <群ID> [用户ID]", handle: cmdClearMem
  },
  {
    name: "/kb", aliases: ["/knowledge"], scope: "admin",
    desc: "知识库（上传资料 / 让 AI 依据资料回答）", handle: cmdKb
  },
  {
    name: "/ban", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "封禁用户（群里：@某人 + 理由，需确认）", usage: "/ban <用户ID|@某人> [理由]", handle: cmdBan
  },
  {
    name: "/unban", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "解除封禁（机器人 + 群）", usage: "/unban <用户ID|@某人>", handle: cmdUnban
  },
  {
    name: "/kick", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "踢出群组（可重新加入，需理由）", usage: "/kick <@某人> <理由>", handle: cmdKick
  },
  {
    name: "/groupban", aliases: ["/gban"], scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "群内封禁（不可重新加入，需理由）", usage: "/groupban <@某人> <理由>", handle: cmdGroupBan
  },
  {
    name: "/mute", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "群内禁言（支持时长，需理由）", usage: "/mute <@某人> [时长] <理由>", handle: cmdMute
  },
  {
    name: "/unmute", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "解除群内禁言", usage: "/unmute <@某人>", handle: cmdUnmute
  },
  {
    name: "/rules", scope: "admin",
    groupAdmin: true, feature: "guard",
    desc: "查看本群群规与可识别的违规类型", handle: cmdRules
  },
  {
    name: "/report", aliases: ["/jubao"], groupOnly: true, feature: "guard",
    desc: "举报违规（先回复对方的消息）", usage: "/report <违规现象>", handle: cmdReport,
    groupHint: "📣 举报请在<b>群里</b>使用：先回复违规消息，再发 <code>/report 发广告</code>。"
  },
  {
    name: "/guard", scope: "admin",
    desc: "群规执法面板（群里：编辑群规 / 默认处置 / 处置记录）", handle: cmdGuard
  },
  {
    name: "/appeal", aliases: ["/shensu"], privateOnly: true, feature: "guard",
    desc: "对处置提出申诉（仅私聊，只走指令）", usage: "/appeal <申诉理由>", handle: cmdAppeal,
    privateHint: "🙋 申诉请私聊机器人，避免在群里公开。"
  },
  {
    name: "/setrules", scope: "admin",
    desc: "设置本群群规（执法时用它校验理由）", usage: "/setrules <群规正文>", handle: cmdSetRules
  },
  {
    name: "/syncmenu", scope: "admin",
    desc: "把指令同步到输入框菜单（/ 弹出列表）", handle: cmdSyncMenu
  },
  {
    name: "/code_new", scope: "admin",
    desc: "生成兑换码", usage: "/code_new <积分> [次数] [有效天数]", handle: cmdCodeNew
  },
  {
    name: "/code_list", aliases: ["/codes"], scope: "admin",
    desc: "兑换码列表与启停", handle: cmdCodeList
  },
  {
    name: "/broadcast", aliases: ["/announce"], scope: "admin", privateOnly: true,
    desc: "群发给所有私聊用户（仅私聊）", usage: "/broadcast <内容>", handle: cmdBroadcast,
    privateHint: "📢 群发消息仅支持<b>私聊</b>使用。"
  },
  {
    name: "/shop_admin", scope: "admin", privateOnly: true, feature: "shop",
    desc: "商城管理（仅私聊）", handle: renderShopAdmin,
    privateHint: "🛒 商城管理仅支持<b>私聊</b>使用。"
  },
  {
    name: "/shop_add", scope: "admin", privateOnly: true, feature: "shop",
    desc: "引导式添加商品（仅私聊）", handle: async (ctx) => {
      const arg = argText(ctx.rawText, "/shop_add").toLowerCase();
      if (arg === "cancel" || arg === "取消") await cancelAddItem(ctx.token, ctx.env, ctx.chatId);
      else await startAddItem(ctx.token, ctx.env, ctx.chatId);
    },
    privateHint: "🛒 添加商品仅支持<b>私聊</b>使用。"
  },
  {
    name: "/shop_edit", aliases: ["/edititem"], scope: "admin", privateOnly: true, feature: "shop",
    desc: "引导式编辑商品（仅私聊）", usage: "/shop_edit <商品ID>", handle: cmdShopEdit,
    privateHint: "🛒 商品编辑仅支持<b>私聊</b>使用。"
  }
];

// ---------- 查找 ----------
const COMMAND_MAP = (() => {
  const map = new Map();
  for (const cmd of COMMANDS) {
    map.set(cmd.name, cmd);
    for (const alias of cmd.aliases || []) map.set(alias, cmd);
  }
  return map;
})();

/**
 * 解析用户输入对应的命令（支持 /cmd@bot 形式）。
 * @returns {object|null} 命令定义；不是指令或未注册时返回 null
 */
export function resolveCommand(text) {
  const first = String(text || "").trim().split(/\s+/)[0] || "";
  if (!first.startsWith("/")) return null;
  return COMMAND_MAP.get(first.split("@")[0].toLowerCase()) || null;
}

// ---------- 分发 ----------
/**
 * 按注册表执行命令：依次判定管理员权限 → 仅私聊 → 功能开关。
 * @returns {Promise<boolean>} true 表示已处理（包括被拦下并给出提示）
 */
export async function dispatchCommand(text, ctx) {
  const cmd = resolveCommand(text);
  if (!cmd) return false;

  const { env, ctx: workerCtx, token, chatId, sceneKey, isGroupCtx, isMaster, uctx } = ctx;

  // 1) 管理员权限
  // 带 groupAdmin 标记的指令，本群管理员（creator / administrator）也能用，
  // 否则「群里处置」这个能力就只剩机器人管理员一个人能用了。
  if (cmd.scope === "admin") {
    const localGroupAdmin = !isMaster && cmd.groupAdmin && isGroupCtx && env?.DB
      ? await isGroupAdmin(token, chatId, uctx?.userId)
      : false;

    if (!isMaster && !localGroupAdmin) {
      await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, workerCtx);
      return true;
    }
    // 解锁只针对机器人管理员；本群管理员没有 /admin 会话，不需要（也无法）解锁
    if (isMaster && cmd.needsUnlock !== false && !(await checkAdminUnlocked(env, isMaster, chatId))) {
      await sendAutoDelete(token, chatId, ERR.ADMIN_LOCKED, null, isGroupCtx, workerCtx);
      return true;
    }
  }

  // 2) 仅私聊
  if (cmd.privateOnly && isGroupCtx) {
    const hint = typeof cmd.privateHint === "function" ? cmd.privateHint(ctx) : (cmd.privateHint || "该功能仅支持私聊。");
    await sendAutoDelete(token, chatId, hint, "HTML", isGroupCtx, workerCtx);
    return true;
  }

  // 2.5) 仅群聊
  if (cmd.groupOnly && !isGroupCtx) {
    const hint = cmd.groupHint || "该指令仅支持在<b>群里</b>使用。";
    await sendAutoDelete(token, chatId, hint, "HTML", isGroupCtx, workerCtx);
    return true;
  }

  // 3) 功能开关（场景覆盖 → 全局设置 → 默认开启）
  if (cmd.feature && !(await isFeatureEnabled(env, sceneKey, cmd.feature))) {
    await sendAutoDelete(
      token, chatId,
      `⚠️ 本场景已关闭「${featureLabel(cmd.feature)}」，如需使用请联系管理员。`,
      null, isGroupCtx, workerCtx
    );
    return true;
  }

  await cmd.handle(ctx);
  return true;
}

// ---------- 自动生成 /help ----------
/**
 * 由命令表生成 /help 文案。
 * 普通用户看不到管理指令，群聊里看不到「仅私聊」指令。
 */
export function buildHelpText({ isMaster, isGroupCtx }) {
  const visible = COMMANDS.filter((c) => {
    if (c.scope === "admin") return isMaster;
    if (c.privateOnly) return !isGroupCtx;
    if (c.groupOnly) return isGroupCtx;
    return true;
  });

  const userCmds = visible.filter((c) => c.scope !== "admin");
  const adminCmds = visible.filter((c) => c.scope === "admin");

  const line = (c) => {
    const names = [c.name, ...(c.aliases || [])].join(" / ");
    // usage 里可能带 <参数> 占位符，必须转义后再放进 <code>，否则会被 Telegram 当成 HTML 标签
    const params = c.usage && c.usage.startsWith(c.name) ? c.usage.slice(c.name.length).trim() : "";
    const shown = escapeHtml(params ? `${names} ${params}` : names);
    return `• <code>${shown}</code> — ${escapeHtml(c.desc)}`;
  };

  let text = `📖 <b>指令列表</b>\n`;
  text += `-------------------------\n\n`;
  text += `👤 <b>普通指令</b>\n`;
  text += userCmds.map(line).join("\n") + "\n";

  if (isMaster) {
    text += `\n👑 <b>管理员指令（仅你可见，需先 /admin）</b>\n`;
    text += adminCmds.map(line).join("\n") + "\n";
  } else {
    text += `\n👑 <b>管理员指令</b>\n• <i>仅管理员可用，如需使用请联系管理员</i>\n`;
  }

  text += `\n💡 <b>${isGroupCtx ? "群聊" : "私聊"}规则</b>\n`;
  if (isGroupCtx) {
    text += `• 只有 <b>@我</b> 或使用 <b>/指令</b> 时才会回复\n`;
    text += `• 处置违规请用 <code>/ban</code>、<code>/mute</code>、<code>/report</code> 等指令，机器人不猜自然语言\n`;
    text += `• 群聊里的指令回执默认 <b>5 秒后自动删除</b>，管理员可在「🗑️ 自动删除」里按消息类型调整\n`;
    text += `• <code>/points</code>、<code>/rank</code> 等带按钮的卡片会保留，方便翻页\n`;
    text += `• 🛒 商城、🎟️ 兑换码 <b>仅支持私聊使用</b>\n`;
  } else {
    text += `• 私聊消息会正常保留\n`;
    text += `• 申诉请用 <code>/appeal 理由</code>\n`;
    text += `• 🛒 商城、🎟️ 兑换码在私聊里完全可用\n`;
  }
  text += `• 每次 AI 对话消耗 <b>1 积分</b>（私聊与群聊共用同一份积分）\n`;

  return text;
}
