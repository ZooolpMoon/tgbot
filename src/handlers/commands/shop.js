// ==========================================
// /shop 打开积分商城
// ==========================================

import { renderShopHome } from "../../shop/index.js";

export async function cmdShop({ env, token, chatId, userKey }) {
  await renderShopHome(token, env, chatId, userKey, null);
}