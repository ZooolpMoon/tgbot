// ==========================================
// 📝 日志封装
// 统一前缀方便在 wrangler tail 里按级别过滤。
// ==========================================

/** 普通信息（定时任务结果等） */
export function logInfo(...args) {
  console.log("[INFO]", ...args);
}

/** 可恢复的告警（模型回退、Telegram 限流重试等） */
export function logWarn(...args) {
  console.warn("[WARN]", ...args);
}

/** 异常（不应影响主流程，但需要排查） */
export function logError(...args) {
  console.error("[ERROR]", ...args);
}
