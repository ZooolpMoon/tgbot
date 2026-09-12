// ==========================================
// 🎟️ /redeem <兑换码>
// 仅私聊可用；每个码每人限兑一次
// ==========================================

import { sendMessage } from "../../telegram/api.js";
import { sendAutoDelete } from "../../telegram/auto-delete.js";
import { redeemCode } from "../../services/redeem.js";
import { completeTask } from "../../services/tasks.js";

/** /redeem <兑换码>：校验并发放积分，成功后触发「使用兑换码」类任务 */
export async function cmdRedeem({ env, ctx, token, chatId, userKey, isGroupCtx, rawText }) {
  if (isGroupCtx) {
    await sendAutoDelete(
      token, chatId,
      "🎟️ 兑换码请到<b>私聊</b>里使用，避免被群里其他人看到。",
      "HTML", isGroupCtx, ctx
    );
    return;
  }

  const code = String(rawText || "").replace(/^\/redeem(@\w+)?/i, "").trim();
  if (!code) {
    await sendMessage(
      token, chatId,
      "🎟️ <b>兑换码</b>\n-------------------------\n" +
      "用法：<code>/redeem 你的兑换码</code>\n" +
      "例如：<code>/redeem TG7KQ2M4XZ</code>\n\n" +
      "大小写和中间的连字符都能识别。",
      "HTML"
    );
    return;
  }

  const result = await redeemCode(env, userKey, code);

  if (!result.ok) {
    await sendMessage(token, chatId, `❌ ${result.error}`);
    return;
  }

  await sendMessage(
    token, chatId,
    `🎉 <b>兑换成功！</b>\n` +
    `-------------------------\n` +
    `🎟️ <b>兑换码：</b> <code>${result.code}</code>\n` +
    `🎁 <b>获得积分：</b> +${result.points}\n` +
    `🪙 <b>当前积分：</b> <b>${result.balance}</b>\n\n` +
    `积分可在商城兑换商品，快去看看吧～`,
    "HTML"
  );

  // 触发「使用一次兑换码」类任务。
  // 私聊场景键就是 private:<uid>，这里直接用 chatId 构造（私聊里二者相同）。
  await completeTask(env, userKey, "redeem", { sceneKey: `private:${chatId}`, chatId, token });
}
