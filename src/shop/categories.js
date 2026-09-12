// ==========================================
// 📂 商品分类
//
// v1.3.1 起商城只保留「虚拟物品 / 服务」两类（不再有实物与发货环节），
// 但历史数据里可能还有 'physical'，这里统一做兼容映射。
// 之前这份映射在 4 个文件里各写了一遍，改动容易漏，现在集中到这里。
// ==========================================

/** 用户/管理员输入的别名 → 标准分类键 */
export const CATEGORY_MAP = {
  "1": "virtual",
  "虚拟": "virtual",
  "虚拟物品": "virtual",
  "virtual": "virtual",
  "2": "service",
  "服务": "service",
  "service": "service",
  // 兼容旧版编号（3 = 服务）
  "3": "service"
};

/** 标准分类键 → 中文展示名 */
export const CATEGORY_TEXT = {
  virtual: "虚拟物品",
  service: "服务"
};

/** 展示用文案：未知分类原样返回，避免出现 undefined */
export function categoryText(key) {
  return CATEGORY_TEXT[key] || String(key || "未知");
}

/** 把任意输入解析成标准分类键，非法输入返回 null */
export function parseCategory(input) {
  return CATEGORY_MAP[String(input || "").trim().toLowerCase()] || null;
}
