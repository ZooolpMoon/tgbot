// ==========================================
// ✅ 每日任务：可自动判定的「触发条件」
//
// 任务本身存在数据库（daily_task_defs），管理员可以引导式增删改；
// 但「机器人能观测到什么」是代码决定的，所以这里定义触发器，
// 管理员添加任务时从中挑一个，并自定义文案与奖励。
// ==========================================

export const TASK_TRIGGERS = [
  { key: "checkin", label: "完成每日签到", hint: "发送 /checkin", points: 5 },
  { key: "chat", label: "和 AI 聊一次", hint: "直接发消息；群聊里 @ 我", points: 3 },
  { key: "game", label: "玩一局游戏", hint: "发送 /game 开一局", points: 3 },
  { key: "shop", label: "在商城兑换一次", hint: "发送 /shop（仅私聊）", points: 2 },
  { key: "redeem", label: "使用一次兑换码", hint: "发送 /redeem <兑换码>（仅私聊）", points: 2 }
];

export const TRIGGER_KEYS = TASK_TRIGGERS.map((t) => t.key);

/** 按 key 查触发条件定义（不存在返回 null） */
export function triggerDef(key) {
  return TASK_TRIGGERS.find((t) => t.key === key) || null;
}

/** 触发条件的中文名（未知 key 原样返回） */
export function triggerLabel(key) {
  return triggerDef(key)?.label || key;
}

// 四个……不，全部任务完成后的额外奖励（管理员可改，存在全局设置里）
export const DEFAULT_TASK_BONUS = 10;
export const TASK_BONUS_SETTING = "task.all_bonus";

// 全勤奖在 daily_tasks 里占用的保留键
export const TASK_ALL_KEY = "all_bonus";
