// ==========================================
// /game
// ==========================================

import { renderGameCenter } from "../../games/index.js";

export async function cmdGame({ token, chatId }) {
  await renderGameCenter(token, chatId, null);
}