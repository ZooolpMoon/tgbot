// ==========================================
// 🧩 用户上下文
// userKey  = 全局积分键
// sceneKey = 场景隔离键
// ==========================================

export function buildUserKey(userId) {
  return `user:${String(userId || "").trim()}`;
}

export function buildSceneKey(chatId, userId, chatType) {
  const safeChat = String(chatId || "").trim();
  const safeUser = String(userId || "").trim();
  const type = String(chatType || "private").toLowerCase();
  if (type === "private") return `private:${safeUser || safeChat}`;
  return `group:${safeChat}:user:${safeUser}`;
}

export function resolveUserContext(payload) {
  const cb = payload.callback_query;
  const msg = payload.message || payload.edited_message;

  const build = (chat, from) => {
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