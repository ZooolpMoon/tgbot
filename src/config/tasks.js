// ==========================================
// ✅ 每日任务定义
// 想加任务：在数组里加一项，并在对应流程里调用 completeTask()
// ==========================================

export const DAILY_TASKS = [
  { key: "checkin", points: 5, label: "完成每日签到", hint: "发送 /checkin" },
  { key: "chat", points: 3, label: "和 AI 聊一次", hint: "直接发消息；群聊里 @ 我" },
  { key: "game", points: 3, label: "玩一局游戏", hint: "发送 /game 开一局" },
  { key: "shop", points: 2, label: "在商城兑换一次", hint: "发送 /shop 挑一件商品（仅私聊）" }
];

// 四个任务全部完成后的额外奖励（每个用户每天一次）
export const DAILY_TASK_ALL_BONUS = 10;
export const TASK_ALL_KEY = "all_bonus";
