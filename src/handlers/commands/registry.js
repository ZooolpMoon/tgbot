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
function argText(rawText, name) {
  return String(rawText || "").replace(new RegExp(`^${name}(@\\w+)?`, "i"), "").trim();
}

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

export function resolveCommand(text) {
  const first = String(text || "").trim().split(/\s+/)[0] || "";
  if (!first.startsWith("/")) return null;
  return COMMAND_MAP.get(first.split("@")[0].toLowerCase()) || null;
}

// ---------- 分发 ----------
/**
 * 按注册表执行命令。返回 true 表示已经处理（包括被权限/开关拦下并给出提示）。
 */
export async function dispatchCommand(text, ctx) {
  const cmd = resolveCommand(text);
  if (!cmd) return false;

  const { env, ctx: workerCtx, token, chatId, sceneKey, isGroupCtx, isMaster } = ctx;

  // 1) 管理员权限
  if (cmd.scope === "admin") {
    if (!isMaster) {
      await sendAutoDelete(token, chatId, ERR.PERMISSION_DENIED, null, isGroupCtx, workerCtx);
      return true;
    }
    if (cmd.needsUnlock !== false && !(await checkAdminUnlocked(env, isMaster, chatId))) {
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

  // 3) 功能开关（v2.1.0 起只受全局开关控制）
  if (cmd.feature && !(await isFeatureEnabled(env, cmd.feature))) {
    await sendAutoDelete(
      token, chatId,
      `⚠️ 管理员已关闭「${featureLabel(cmd.feature)}」。`,
      null, isGroupCtx, workerCtx
    );
    return true;
  }

  await cmd.handle(ctx);
  return true;
}

// ---------- 自动生成 /help ----------
export function buildHelpText({ isMaster, isGroupCtx }) {
  const visible = COMMANDS.filter((c) => {
    if (c.scope === "admin") return isMaster;
    if (c.privateOnly) return !isGroupCtx;
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
    text += `• 群聊里大部分 /指令消息 <b>5 秒后自动删除</b>\n`;
    text += `• <code>/points</code>、<code>/rank</code> 等带按钮的卡片会保留，方便翻页\n`;
    text += `• 🛒 商城、🎟️ 兑换码 <b>仅支持私聊使用</b>\n`;
  } else {
    text += `• 私聊消息会正常保留\n`;
    text += `• 🛒 商城、🎟️ 兑换码在私聊里完全可用\n`;
  }
  text += `• 每次 AI 对话消耗 <b>1 积分</b>（私聊与群聊共用同一份积分）\n`;

  return text;
}
