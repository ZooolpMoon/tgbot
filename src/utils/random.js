// ==========================================
// 🔐 加密随机数工具
// 用 crypto.getRandomValues 替代 Math.random，
// 避免游戏/订单号等有实际价值的随机结果被预测。
// ==========================================

/**
 * 返回 [0, max) 范围内的随机整数。
 * @param {number} max 上限（不含）
 */
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) {
    throw new RangeError("randomInt: max 必须是正整数");
  }

  const MAX_UINT32 = 0xffffffff;
  // 拒绝采样，避免取模带来的分布偏差。
  const limit = Math.floor(MAX_UINT32 / max) * max;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % max;
}

/**
 * 返回 [0, 1) 范围内的随机浮点数。
 */
export function randomFloat() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}
