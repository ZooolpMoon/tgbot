// ==========================================
// /help 指令列表
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";

export async function cmdHelp({ token, chatId, isMaster, isGroupCtx, ctx }) {
  const text = buildHelpText(isMaster, isGroupCtx);
  await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx);
}

function buildHelpText(isMaster, isGroupCtx) {
  const isAdmin = Boolean(isMaster);
  const isPrivate = !isGroupCtx;

  // ---------- 普通用户指令（有序拼接）----------
  const userCmds = [];

  // 基础
  userCmds.push(
    `/start - 开始使用 / 查看欢迎信息`,
    `/help - 📖 查看本指令列表`,
    `/checkin - 📅 每日签到（+5 积分，北京时间）`
  );

  // 商城：仅私聊
  if (isPrivate) {
    userCmds.push(
      `/shop - 🛒 打开积分商城`,
      `/orders - 📜 查看我的订单`
    );
  }

  // 游戏 + 个人设置
  userCmds.push(
    `/game - 🎮 打开游戏大厅`,
    `/profile - 👤 查看个人信息卡片`,
    `/setlang &lt;zh/en&gt; - 🌐 切换语言`,
    `/setprompt &lt;设定&gt; - 📝 设置自定义 AI 偏好`,
    `/clear - 🧹 清空当前场景对话历史`
  );

  // ---------- 管理员指令 ----------
  const adminCmds = [
    `/admin - 👑 打开管理控制台（仅管理员）`,
    `/users - 💬 私聊用户管理（需先 /admin）`,
    `/users_group - 👥 群聊用户管理（需先 /admin）`,
    `/stats - 📈 系统使用统计（需先 /admin）`,
    `/addpoints &lt;场景ID&gt; &lt;数量&gt; - 🪙 增减用户全局积分（需先 /admin）`
  ];

  if (isPrivate) {
    adminCmds.push(`/shop_admin - 🛒 商城管理（仅私聊，需先 /admin）`);
    adminCmds.push(`/shop_add - ➕ 添加商品（仅私聊，需先 /admin）`);
  }

  // ---------- 拼接 ----------
  let text = `📖 <b>指令列表</b>\n`;
  text += `-------------------------\n\n`;

  text += `👤 <b>普通指令</b>\n`;
  userCmds.forEach((c) => { text += `• ${c}\n`; });

  if (isAdmin) {
    text += `\n👑 <b>管理员指令（仅你可见）</b>\n`;
    adminCmds.forEach((c) => { text += `• ${c}\n`; });
  } else {
    text += `\n👑 <b>管理员指令</b>\n`;
    text += `• <i>仅管理员可用，如需使用请联系管理员</i>\n`;
  }

  text += `\n💡 <b>${isGroupCtx ? "群聊" : "私聊"}规则</b>\n`;
  if (isGroupCtx) {
    text += `• 只有 <b>@我</b> 或使用 <b>/指令</b> 时才会回复\n`;
    text += `• 群聊里 /指令类消息 <b>5 秒后自动删除</b>\n`;
    text += `• 用户 @我 触发的 AI 回复、游戏消息 <b>保留</b>\n`;
    text += `• 🛒 商城功能 <b>仅支持私聊使用</b>\n`;
  } else {
    text += `• 私聊消息会正常保留\n`;
    text += `• 🛒 商城功能在私聊里完全可用\n`;
  }
  text += `• 每次 AI 对话消耗 <b>1 积分</b>（私聊与群聊共用同一份积分）\n`;

  return text;
}
