// ==========================================
// 📝 日志封装
// ==========================================

export function logInfo(...args) {
  console.log("[INFO]", ...args);
}
export function logWarn(...args) {
  console.warn("[WARN]", ...args);
}
export function logError(...args) {
  console.error("[ERROR]", ...args);
}