// ==========================================
// /shop 打开积分商城
// 仅私聊可用（由命令注册表的 privateOnly 拦截）。
// ==========================================

import { renderShopHome } from "../../shop/index.js";

/** /shop 指令实现 */
export async function cmdShop({ env, token, chatId, userKey }) {
  await renderShopHome(token, env, chatId, userKey, null);
}
