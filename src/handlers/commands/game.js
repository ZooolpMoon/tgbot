// ==========================================
// /game
// 打开游戏大厅（是否可用由功能开关 game 控制）。
// ==========================================

import { renderGameCenter } from "../../games/index.js";

/** /game 指令实现 */
export async function cmdGame({ token, chatId }) {
  await renderGameCenter(token, chatId, null);
}
