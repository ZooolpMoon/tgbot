// ==========================================
// 🚚 商城的「发放方式」与「背包物品使用效果」
//
// 发放方式（shop_items.delivery）决定下单后谁来交付：
//   manual    下单后是「待处理」，管理员确认发放
//   group_tag 下单即完成，机器人引导用户设置群组标签
//   bag       下单即完成，物品自动进「🎒 我的背包」，用户自己用
//
// 使用效果（shop_items.use_type）只对进背包的物品有意义：
//   none    仅核销：使用后标记已用，通知管理员处理
//   points  使用后立刻兑换成 use_value 积分
// ==========================================

/** 发放方式 */
export const DELIVERY = {
  MANUAL: "manual",
  GROUP_TAG: "group_tag",
  BAG: "bag"
};

/** 发放方式 → 中文说明（面板/详情页展示用） */
export const DELIVERY_TEXT = {
  [DELIVERY.MANUAL]: "管理员人工发放",
  [DELIVERY.GROUP_TAG]: "自动发放 · 群组标签",
  [DELIVERY.BAG]: "自动发放 · 进背包"
};

/** 发放方式的别名（管理员输入用），小写后匹配 */
const DELIVERY_ALIAS = {
  "1": DELIVERY.MANUAL,
  "manual": DELIVERY.MANUAL,
  "人工": DELIVERY.MANUAL,
  "人工发放": DELIVERY.MANUAL,
  "管理员": DELIVERY.MANUAL,
  "2": DELIVERY.GROUP_TAG,
  "group_tag": DELIVERY.GROUP_TAG,
  "grouptag": DELIVERY.GROUP_TAG,
  "群标签": DELIVERY.GROUP_TAG,
  "标签": DELIVERY.GROUP_TAG,
  "3": DELIVERY.BAG,
  "bag": DELIVERY.BAG,
  "背包": DELIVERY.BAG,
  "进背包": DELIVERY.BAG
};

/** 商品的发放方式（未知/空一律按人工发放处理） */
export function deliveryOf(item) {
  const value = String(item?.delivery || "").trim();
  return value || DELIVERY.MANUAL;
}

/** 是否「下单即完成」的自动发放（群标签 / 进背包） */
export function isAutoDelivery(delivery) {
  const value = String(delivery || "").trim();
  return value === DELIVERY.GROUP_TAG || value === DELIVERY.BAG;
}

/** 把管理员输入解析成发放方式，非法输入返回 null */
export function parseDelivery(input) {
  return DELIVERY_ALIAS[String(input || "").trim().toLowerCase()] || null;
}

/** 展示用文案：未知取值原样返回，避免出现 undefined */
export function deliveryText(key) {
  const value = String(key || "").trim() || DELIVERY.MANUAL;
  return DELIVERY_TEXT[value] || value;
}

// ---------- 背包物品的使用效果 ----------

export const USE_TYPE = {
  /** 仅核销：使用后通知管理员处理（线下服务、实物兑换等） */
  NONE: "none",
  /** 使用后立刻兑换成积分 */
  POINTS: "points"
};

export const USE_TYPE_TEXT = {
  [USE_TYPE.NONE]: "仅核销（使用后通知管理员）",
  [USE_TYPE.POINTS]: "使用后兑换成积分"
};

const USE_TYPE_ALIAS = {
  "1": USE_TYPE.NONE,
  "none": USE_TYPE.NONE,
  "核销": USE_TYPE.NONE,
  "仅核销": USE_TYPE.NONE,
  "2": USE_TYPE.POINTS,
  "points": USE_TYPE.POINTS,
  "积分": USE_TYPE.POINTS,
  "换积分": USE_TYPE.POINTS
};

/** 背包物品的使用效果（未知/空按「仅核销」处理） */
export function useTypeOf(item) {
  const value = String(item?.use_type || item?.useType || "").trim();
  return value === USE_TYPE.POINTS ? USE_TYPE.POINTS : USE_TYPE.NONE;
}

/** 使用后的积分数量（仅 points 类型有意义，非正数按 0 处理） */
export function useValueOf(item) {
  const n = Math.floor(Number(item?.use_value ?? item?.useValue) || 0);
  return n > 0 ? n : 0;
}

/** 把管理员输入解析成使用效果，非法输入返回 null */
export function parseUseType(input) {
  return USE_TYPE_ALIAS[String(input || "").trim().toLowerCase()] || null;
}

/** 展示用文案 */
export function useTypeText(key) {
  const value = String(key || "").trim() || USE_TYPE.NONE;
  return USE_TYPE_TEXT[value] || value;
}

/** 「发放方式 + 使用效果」拼成一行说明，商品详情页用 */
export function deliverySummary(item) {
  const delivery = deliveryOf(item);
  if (delivery === DELIVERY.BAG) {
    const effect = useTypeOf(item);
    const value = useValueOf(item);
    const effectText = effect === USE_TYPE.POINTS
      ? `使用后换成 🪙 ${value} 积分`
      : "使用后由管理员核销";
    return `${deliveryText(delivery)}｜${effectText}`;
  }
  return deliveryText(delivery);
}
