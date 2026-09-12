// ==========================================
// 🧹 /clearmem 清除 AI 记忆
// /clearmem                 → 用法说明
// /clearmem me              → 清除当前场景记忆
// /clearmem <群ID>          → 清除该群所有成员的记忆
// /clearmem <群ID> <用户ID> → 清除「某群 + 某用户」的记忆
// ==========================================

import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { logAdminAction } from "../../services/admin-log.js";

const USAGE =
  "🧹 <b>清除 AI 记忆</b>\n-------------------------\n" +
  "用法：\n" +
  "• <code>/clearmem me</code> —— 清除当前场景记忆\n" +
  "• <code>/clearmem -1001234567890</code> —— 清除该群所有成员记忆\n" +
  "• <code>/clearmem -1001234567890 123456789</code> —— 清除某群某用户的记忆\n\n" +
  "也可以从 <b>管理员控制台 → 用户管理 → 场景编辑</b> 里点「🧹 清空此场景记忆」。";

export async function cmdClearMem({ env, ctx, token, chatId, isMaster, isGroupCtx, rawText, sceneKey, myId }) {
  if (!env.DB) {
    await sendAutoDelete(token, chatId, "❌ 未绑定数据库。", null, isGroupCtx, ctx);
    return;
  }

  const args = String(rawText || "")
    .replace(/^\/clearmem(@\w+)?/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 0) {
    await sendAutoDelete(token, chatId, USAGE, "HTML", isGroupCtx, ctx);
    return;
  }

  // 当前场景
  if (args.length === 1 && /^(me|self|当前|这里)$/i.test(args[0])) {
    const res = await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(sceneKey).run();
    await logAdminAction(env, { adminId: myId, chatId, action: "scene_clear_memory", detail: `${sceneKey}` });
    await sendAutoDelete(
      token, chatId,
      res.meta.changes > 0 ? `🧹 已清除当前场景记忆（${sceneKey}）` : `ℹ️ 当前场景没有对话记忆（${sceneKey}）`,
      null, isGroupCtx, ctx
    );
    return;
  }

  const groupId = args[0];
  if (!/^-?\d+$/.test(groupId)) {
    await sendAutoDelete(token, chatId, `⚠️ 群 ID 必须是数字。\n\n${USAGE}`, "HTML", isGroupCtx, ctx);
    return;
  }

  // 某群某用户
  if (args.length >= 2) {
    const userId = args[1];
    if (!/^-?\d+$/.test(userId)) {
      await sendAutoDelete(token, chatId, `⚠️ 用户 ID 必须是数字。\n\n${USAGE}`, "HTML", isGroupCtx, ctx);
      return;
    }
    const targetKey = `group:${groupId}:user:${userId}`;
    const res = await env.DB.prepare("DELETE FROM chat_history WHERE scene_key = ?").bind(targetKey).run();
    await logAdminAction(env, {
      adminId: myId, chatId, action: "scene_clear_memory", detail: targetKey
    });
    await sendAutoDelete(
      token, chatId,
      res.meta.changes > 0
        ? `🧹 已清除该用户在本群的记忆。\n🧩 场景键：<code>${targetKey}</code>`
        : `ℹ️ 没有找到该场景的记忆记录。\n🧩 场景键：<code>${targetKey}</code>`,
      "HTML", isGroupCtx, ctx
    );
    return;
  }

  // 整个群
  const likeKey = `group:${groupId}:user:%`;
  const res = await env.DB.prepare("DELETE FROM chat_history WHERE scene_key LIKE ?").bind(likeKey).run();
  await logAdminAction(env, {
    adminId: myId, chatId, action: "group_clear_memory",
    detail: `群 ${groupId}（清除 ${res.meta.changes} 个场景）`
  });
  await sendAutoDelete(
    token, chatId,
    `🧹 已清除群 <code>${groupId}</code> 的 <b>${res.meta.changes}</b> 个成员记忆。`,
    "HTML", isGroupCtx, ctx
  );
}
