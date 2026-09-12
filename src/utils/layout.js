// ==========================================
// 📐 菜单排版工具
//
// 统一所有 inline keyboard 的排版规则（AGENTS.md 约定）：
//   • 单行最多 2 个按钮（两列网格），避免被拉成一条长龙
//   • 整个菜单不超过 8 行（含翻页与返回按钮）
//   • 按钮文案不超过 32 个字符，超出自动省略
//   • callback_data 不超过 64 字节（Telegram 硬限制）
//
// 同时提供分页与页码收敛工具，避免「页码越界后菜单卡死」这类问题。
// ==========================================

/** Telegram 与项目约定的排版上限 */
export const LAYOUT = {
  /** 每行按钮数（两列网格） */
  PER_ROW: 2,
  /** 一个菜单最多几行 */
  MAX_ROWS: 8,
  /** 按钮文案最大字符数（按 Unicode 码点计算，避免截断 emoji） */
  MAX_BUTTON_TEXT: 32,
  /** callback_data 最大字节数 */
  MAX_CALLBACK_BYTES: 64,
  /** 统一的正文分隔线 */
  DIVIDER: "-------------------------"
};

/**
 * 把按钮数组按「每行 N 个」切成网格。
 * @param {Array} buttons 按钮列表
 * @param {number} [perRow] 每行按钮数，默认 2
 * @returns {Array<Array>} inline_keyboard 需要的二维数组
 */
export function grid(buttons, perRow = LAYOUT.PER_ROW) {
  const size = Math.max(1, Math.floor(Number(perRow) || LAYOUT.PER_ROW));
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) {
    rows.push(buttons.slice(i, i + size));
  }
  return rows;
}

/**
 * 按 Unicode 码点截断文案。
 * 直接用 String.slice 会截断 emoji 的代理对，导致出现乱码方块。
 * @param {unknown} text 原始文案
 * @param {number} [max] 最大码点数
 */
export function compactLabel(text, max = LAYOUT.MAX_BUTTON_TEXT) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  const limit = Math.max(2, Math.floor(Number(max) || LAYOUT.MAX_BUTTON_TEXT));
  if (chars.length <= limit) return cleaned;
  // 预留 1 个字符给省略号
  return chars.slice(0, limit - 1).join("") + "…";
}

/** 由总数与每页条数算出总页数（至少 1 页） */
export function totalPagesOf(total, pageSize) {
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const count = Math.max(0, Math.floor(Number(total) || 0));
  return Math.max(1, Math.ceil(count / size));
}

/** 把页码收敛到 [1, totalPages]，避免越界后查询到空列表 */
export function clampPage(page, totalPages) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(1, n), total);
}

/** 当前页的 SQL OFFSET */
export function pageOffset(page, pageSize) {
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  return (Math.max(1, Math.floor(Number(page) || 1)) - 1) * size;
}

/**
 * 生成「上一页 / 下一页」按钮行。
 * 只有一页时返回 null，调用方据此决定是否 push。
 * @param {{page:number,totalPages:number,prefix:string,unit?:string}} opts
 */
export function pagerRow({ page, totalPages, prefix }) {
  const row = [];
  if (page > 1) row.push({ text: "⬅️ 上一页", callback_data: `${prefix}${page - 1}` });
  if (page < totalPages) row.push({ text: "下一页 ➡️", callback_data: `${prefix}${page + 1}` });
  return row.length > 0 ? row : null;
}

/**
 * 统一的「页码：x / y（共 n 个单位）」文案。
 * @param {{page:number,totalPages:number,total:number,unit?:string}} opts
 */
export function pageInfoText({ page, totalPages, total, unit = "条" }) {
  return `页码：<b>${page} / ${totalPages}</b>（共 ${Number(total) || 0} ${unit}）`;
}

/**
 * 校验键盘是否符合排版约定（供测试与本地自检使用）。
 * @param {object} keyboard `{ inline_keyboard: [...] }`
 * @returns {string[]} 问题列表，空数组表示通过
 */
export function validateKeyboard(keyboard) {
  const problems = [];
  const rows = keyboard?.inline_keyboard;

  if (!Array.isArray(rows) || rows.length === 0) {
    return ["菜单没有按钮"];
  }
  if (rows.length > LAYOUT.MAX_ROWS) {
    problems.push(`菜单有 ${rows.length} 行，超过上限 ${LAYOUT.MAX_ROWS}`);
  }

  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) {
      problems.push(`第 ${rowIndex + 1} 行是空的`);
      return;
    }
    if (row.length > LAYOUT.PER_ROW) {
      problems.push(`第 ${rowIndex + 1} 行有 ${row.length} 个按钮，超过上限 ${LAYOUT.PER_ROW}`);
    }
    for (const btn of row) {
      const label = String(btn?.text ?? "");
      if (!label) problems.push(`第 ${rowIndex + 1} 行有按钮缺少文案`);
      if (Array.from(label).length > LAYOUT.MAX_BUTTON_TEXT) {
        problems.push(`按钮文案过长（${Array.from(label).length} 字）：${label}`);
      }
      if (btn?.callback_data === undefined || btn?.callback_data === null) {
        problems.push(`按钮「${label}」缺少 callback_data`);
      } else if (new TextEncoder().encode(String(btn.callback_data)).length > LAYOUT.MAX_CALLBACK_BYTES) {
        problems.push(`callback_data 超过 ${LAYOUT.MAX_CALLBACK_BYTES} 字节：${btn.callback_data}`);
      }
    }
  });

  return problems;
}
