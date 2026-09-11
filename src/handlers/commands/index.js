// ==========================================
// 📖 指令注册与分发
// ==========================================

import { cmdStart } from "./start.js";        // 开始指令
import { cmdHelp } from "./help.js";          // 帮助指令
import { cmdCheckin } from "./checkin.js";    // 签到指令
import { cmdProfile } from "./profile.js";    // 个人信息指令
import { cmdSetLang } from "./setlang.js";    // 语言更改指令
import { cmdSetPrompt } from "./setprompt.js";// AI 自定义指令
import { cmdClear } from "./clear.js";        // 清除 AI 上下文指令
import { cmdGame } from "./game.js";          // 游戏指令

export const COMMANDS = {
  "/start": cmdStart,
  "/help": cmdHelp,
  "/h": cmdHelp,
  "/checkin": cmdCheckin,
  "/sign": cmdCheckin,
  "/profile": cmdProfile,
  "/setlang": cmdSetLang,
  "/setprompt": cmdSetPrompt,
  "/clear": cmdClear,
  "/game": cmdGame,
  "/games": cmdGame
};

export async function dispatchCommand(cmd, ctxObj) {
  const handler = COMMANDS[cmd];
  if (!handler) return false;
  await handler(ctxObj);
  return true;
}