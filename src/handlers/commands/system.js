// ==========================================
// ⌨️ /syncmenu：把指令同步到 Telegram 输入框菜单
//
// 平时不用手动调用：每次部署后第一个请求会自动比对菜单内容，
// 变了才会调用 Telegram（见 services/command-menu.js）。
// 这个指令用于「想立刻刷新」或排查菜单没更新的情况。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { syncCommandMenu, buildCommandMenu } from "../../services/command-menu.js";

/** /syncmenu：强制同步输入框命令菜单 */
export async function cmdSyncMenu({ env, ctx, token, chatId, isGroupCtx }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const result = await syncCommandMenu(env, token, { force: true });
  const pub = buildCommandMenu({ includeAdmin: false, inGroup: false }).length;
  const grp = buildCommandMenu({ includeAdmin: false, inGroup: true }).length;
  const adm = buildCommandMenu({ includeAdmin: true, inGroup: false }).length;

  await sendAutoDelete(
    token, chatId,
    result.synced
      ? `✅ <b>指令菜单已同步</b>\n-------------------------\n` +
        `👤 私聊：${pub} 条 · 👥 群聊：${grp} 条 · 👑 管理员私聊：${adm} 条\n\n` +
        `现在在聊天框输入 <code>/</code> 就能看到列表。`
      : `⚠️ 同步失败：${result.error || "未知错误"}`,
    "HTML", isGroupCtx, ctx
  );
}
