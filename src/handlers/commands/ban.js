// ==========================================
// 🚫 /ban 与 /unban
//
// 封禁是「用户级」的：一旦封禁，该用户在私聊和所有群都不再被服务（管理员不受影响）。
// 封禁名单可在「用户管理 → 🚫 封禁名单」里查看并解封。
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { escapeHtml } from "../../utils/html.js";
import { banUserById, unbanUserById } from "../../services/users.js";
import { logAdminAction } from "../../services/admin-log.js";

const USAGE_BAN =
  "🚫 <b>封禁用户</b>\n-------------------------\n" +
  "用法：<code>/ban &lt;用户ID&gt; [原因]</code>\n" +
  "例如：<code>/ban 123456789 广告刷屏</code>\n\n" +
  "用户 ID 是 Telegram 数字 ID（可从「用户管理 → 群组用户 → 群成员」里看到）。";

const USAGE_UNBAN =
  "✅ <b>解封用户</b>\n-------------------------\n" +
  "用法：<code>/unban &lt;用户ID&gt;</code>\n" +
  "也可以从「用户管理 → 🚫 封禁名单」里点按钮解封。";

/** 取指令后的参数（去掉 @botname 与多余空格） */
function parseArgs(rawText, name) {
  return String(rawText || "")
    .replace(new RegExp(`^${name}(@\\w+)?`, "i"), "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** /ban <用户ID> [原因] */
export async function cmdBan({ env, ctx, token, chatId, isGroupCtx, rawText, myId }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const args = parseArgs(rawText, "/ban");
  if (args.length === 0) {
    await sendAutoDelete(token, chatId, USAGE_BAN, "HTML", isGroupCtx, ctx);
    return;
  }

  const targetId = args[0];
  const reason = args.slice(1).join(" ").slice(0, 100);

  // 防止管理员把自己关在门外
  if (myId && String(targetId) === String(myId)) {
    await sendAutoDelete(token, chatId, "⚠️ 不能封禁管理员自己。", null, isGroupCtx, ctx);
    return;
  }

  const res = await banUserById(env, targetId);
  if (!res.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${res.error}\n\n${USAGE_BAN}`, "HTML", isGroupCtx, ctx);
    return;
  }

  await logAdminAction(env, {
    adminId: myId, chatId, action: "user_block",
    detail: `${res.userKey}${reason ? ` 原因：${reason}` : ""}${res.existed ? "" : "（新建档案）"}`
  });

  await sendAutoDelete(
    token, chatId,
    `🚫 <b>已加入封禁名单</b>\n-------------------------\n` +
    `🆔 <code>${targetId}</code>\n` +
    `📝 原因：${reason ? escapeHtml(reason) : "（未填写）"}\n\n` +
    `该用户在私聊与所有群都将停止服务；可用 <code>/unban ${targetId}</code> 解封。`,
    "HTML", isGroupCtx, ctx
  );
}

/** /unban <用户ID> */
export async function cmdUnban({ env, ctx, token, chatId, isGroupCtx, rawText, myId }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const args = parseArgs(rawText, "/unban");
  if (args.length === 0) {
    await sendAutoDelete(token, chatId, USAGE_UNBAN, "HTML", isGroupCtx, ctx);
    return;
  }

  const targetId = args[0];
  const res = await unbanUserById(env, targetId);
  if (!res.ok) {
    await sendAutoDelete(token, chatId, `⚠️ ${res.error}\n\n${USAGE_UNBAN}`, "HTML", isGroupCtx, ctx);
    return;
  }

  await logAdminAction(env, {
    adminId: myId, chatId, action: "user_unblock", detail: `${res.userKey}（命令解封）`
  });
  await sendAutoDelete(token, chatId, `✅ 已解封 <code>${targetId}</code>。`, "HTML", isGroupCtx, ctx);
}
