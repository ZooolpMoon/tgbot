// ==========================================
// 💬 用户可见文案
// ==========================================

import { POINTS } from "./constants.js";

export const ERR = {
  PERMISSION_DENIED: "❌ 权限不足：只有管理员可以访问管理控制台。",
  ADMIN_LOCKED: "❌ 请先输入 /admin 解锁控制台。",
  DB_NOT_BOUND: "❌ 未绑定 D1 数据库。",
  AI_NOT_BOUND: "❌ 错误：Cloudflare Workers AI 未绑定，本次消耗已自动退回。",
  AI_ERROR: "❌ AI 服务暂时异常，本次积分和今日额度已自动退回，请稍后重试。",
  POINTS_EMPTY: "⚠️ 你的积分已用尽，无法发起新的对话。",
  QUOTA_EMPTY: (n) => `⚠️ 您本场景今日额度（${n}条/天）已用完。`,
  QUOTA_ZERO: "⚠️ 本场景每日发送额度已被设置为 0 条。",
  RATE_LIMIT: (s) => `⏳ 发送频率过快，请等待 ${s} 秒后再试。`,
  UNKNOWN_CMD: "⚠️ 未知指令。输入 /help 查看帮助。"
};

export const TIPS = {
  MENU_TITLE: "👑 <b>管理员控制台</b>\n-------------------------\n点击下方按钮查看或编辑用户数据：",
  WELCOME: (name, user, tag, pts, quota, lang) =>
    `👋 您好，${name}（${user}）！\n` +
    `📌 当前身份：${tag}\n\n` +
    `当前全局积分：${pts}\n` +
    `本场景今日额度：${quota}\n` +
    `当前语言：${lang}\n\n` +
    `📅 输入 /checkin 每日签到领 ${POINTS.CHECKIN_REWARD} 积分\n` +
    `📖 输入 /help 查看完整指令列表\n` +
    `🎮 输入 /game 打开游戏大厅\n\n` +
    `输入 /admin 进入管理控制台`
};