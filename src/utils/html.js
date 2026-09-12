// ==========================================
// 🔒 HTML 转义
// Telegram 的 HTML 解析模式只认少数标签，但用户输入的 < > & 必须转义，
// 否则会被当成标签（轻则排版错乱，重则整条消息发送失败）。
// ==========================================

/** 转义用户可控文本；空值统一返回空串，方便模板里直接拼接 */
export function escapeHtml(text) {
  if (!text) return "";
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
