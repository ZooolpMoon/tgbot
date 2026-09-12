// ==========================================
// 🧩 用户上下文
// userKey  = 全局积分键（同一个用户在私聊/群聊共享一份积分）
// sceneKey = 场景隔离键（私聊 = private:<uid>；群聊 = group:<gid>:user:<uid>）
// ==========================================

/** 全局积分键：一个 Telegram 用户对应一条 users 记录 */
export function buildUserKey(userId) {
  return `user:${String(userId || "").trim()}`;
}

/** 场景键：决定「今日额度 / 冷却时间 / AI 记忆」的隔离粒度 */
export function buildSceneKey(chatId, userId, chatType) {
  const safeChat = String(chatId || "").trim();
  const safeUser = String(userId || "").trim();
  const type = String(chatType || "private").toLowerCase();
  if (type === "private") return `private:${safeUser || safeChat}`;
  return `group:${safeChat}:user:${safeUser}`;
}

/**
 * 从 Telegram 更新对象解析统一上下文。
 * 回调消息与普通消息共用；缺少 chat/from 等必要字段时返回 null，上层直接忽略。
 */
export function resolveUserContext(payload) {
  const cb = payload.callback_query;
  const msg = payload.message || payload.edited_message;

  const build = (chat, from) => {
    if (!chat || !from || chat.id == null || from.id == null) return null;
    const chatType = chat.type || "private";
    const chatId = String(chat.id);
    const userId = String(from.id);
    return {
      chatId,
      userId,
      chatType,
      userKey: buildUserKey(userId),
      sceneKey: buildSceneKey(chatId, userId, chatType),
      username: from.username,
      firstName: from.first_name
    };
  };

  if (cb && cb.message) return build(cb.message.chat || {}, cb.from || {});
  if (msg && msg.chat) return build(msg.chat || {}, msg.from || {});
  return null;
}
