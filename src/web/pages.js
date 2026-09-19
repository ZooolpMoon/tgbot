// ==========================================
// 🖥️ Web 管理后台 · 页面（v3.10.2）
//
// 刻意做成「一页 + 原生 fetch」：没有构建步骤、没有外部 CDN，
// 部署上去就能用，也不会因为前端依赖过期而烂掉。
// 模板里的 `${}` 是**服务端**插值，页面自己的 JS 用字符串拼接（避免反引号打架）。
// ==========================================

import { escapeHtml } from "../utils/html.js";
import { roleLabel } from "../services/admins.js";

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1a1d21;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--danger:#dc2626;--ok:#059669}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a1f;--fg:#e8eaed;--muted:#9aa0a6;--line:#2a2f36;--accent:#60a5fa;--danger:#f87171;--ok:#34d399}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;gap:14px;align-items:center;flex-wrap:wrap;background:var(--card);position:sticky;top:0;z-index:9}
header h1{font-size:16px;margin:0;font-weight:600;white-space:nowrap}
nav{display:flex;gap:2px;flex-wrap:wrap}
nav a{color:var(--muted);text-decoration:none;font-size:13px;cursor:pointer;padding:4px 10px;border-radius:7px}
nav a:hover{background:var(--bg)}
nav a.on{color:var(--accent);font-weight:600;background:var(--bg)}
main{padding:20px;max-width:1100px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{color:var(--muted);font-size:12px}
.card .v{font-size:20px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
tr:last-child td{border-bottom:none}
input,button,select{font:inherit;padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
input[type=number]{width:90px}
button{cursor:pointer;white-space:nowrap}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);color:#fff;border-color:transparent}
button.danger{color:var(--danger);border-color:currentColor}
button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.muted{color:var(--muted);font-size:12px}
.empty{padding:30px;text-align:center;color:var(--muted)}
.err{color:var(--danger)}
.ok{color:var(--ok)}
.pill{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;border:1px solid var(--line)}
.pill.on{color:var(--ok);border-color:currentColor}
.pill.off{color:var(--muted)}
.feat{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.feat button{font-size:11px;padding:2px 7px;border-radius:20px}
.feat button.on{color:var(--ok);border-color:currentColor}
.feat button.off{color:var(--muted)}
code{background:var(--bg);padding:1px 5px;border-radius:5px;font-size:12px}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px;box-shadow:0 6px 24px rgba(0,0,0,.15);display:none;z-index:99;max-width:80vw}
.toast.on{display:block}
`;

export function renderLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>需要登录 · 机器人后台</title><style>${BASE_CSS}</style></head>
<body><main>
<div class="card">
<h1 style="margin-top:0">🔐 需要登录</h1>
<p>这个后台只认 Telegram 里发出的<b>一次性登录链接</b>，没有密码可输。</p>
<p>打开 Telegram，在私聊里给机器人发送：</p>
<p><code>/web</code></p>
<p class="muted">机器人会回一条 5 分钟内有效的登录按钮（只有已授权的管理员才能生成）。</p>
</div>
</main></body></html>`;
}

export function renderMessagePage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head>
<body><main><div class="card"><h1 style="margin-top:0">${escapeHtml(title)}</h1>
<p>${escapeHtml(detail)}</p></div></main></body></html>`;
}

/** 单页后台（标签页由页面内 JS 渲染，数据全部走 /admin/api/*） */
export function renderAdminPage(viewer) {
  const roleName = escapeHtml(roleLabel(viewer.role));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>机器人后台</title><style>${BASE_CSS}</style></head>
<body>
<header>
  <h1>🖥️ 机器人后台</h1>
  <nav id="nav">
    <a data-tab="overview" class="on">概览</a>
    <a data-tab="users">用户</a>
    <a data-tab="groups">群组</a>
    <a data-tab="shop">商城</a>
    <a data-tab="codes">兑换码</a>
    <a data-tab="logs">日志</a>
  </nav>
  <span class="muted" style="margin-left:auto">${roleName} · <code>${escapeHtml(viewer.userId)}</code></span>
  <form method="post" action="/admin/logout" style="margin:0"><button type="submit">退出</button></form>
</header>
<main>
  <section id="tab-overview"></section>
  <section id="tab-users" hidden></section>
  <section id="tab-groups" hidden></section>
  <section id="tab-shop" hidden></section>
  <section id="tab-codes" hidden></section>
  <section id="tab-logs" hidden></section>
</main>
<div class="toast" id="toast"></div>
<script>
var $ = function (sel) { return document.querySelector(sel); };
var esc = function (s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
};
var fmt = function (n) { return new Intl.NumberFormat("zh-CN").format(Number(n) || 0); };

var toastTimer = null;
function toast(text, bad) {
  var el = $("#toast");
  el.textContent = text;
  el.style.color = bad ? "var(--danger)" : "var(--ok)";
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("on"); }, 2600);
}

async function api(path, options) {
  var res = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options));
  if (res.status === 401) { location.href = "/admin"; return null; }
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!data) { toast("服务返回异常（HTTP " + res.status + "）", true); return null; }
  if (data.error && data.error !== "forbidden") { toast(data.detail || data.error, true); }
  else if (data.error === "forbidden") { toast(data.detail || "没有权限", true); }
  return data;
}

// ============================================================
// 📊 概览
// ============================================================
async function renderOverview() {
  var d = await api("/admin/api/overview");
  if (!d) return;
  var cards = [
    ["用户", fmt(d.users)], ["群组", fmt(d.groups)], ["积分总量", fmt(d.points)],
    ["已封禁", fmt(d.blocked)], ["待处理订单", fmt(d.pendingOrders)],
    ["近 7 天 AI 调用", fmt(d.aiCall)], ["近 7 天模型失败", fmt(d.aiFail)], ["近 7 天群消息", fmt(d.msgIn)]
  ];
  var trend = "";
  if (d.daily && d.daily.length) {
    trend = '<table><thead><tr><th>日期</th><th>AI 调用</th><th>群消息</th></tr></thead><tbody>' +
      d.daily.map(function (r) {
        return "<tr><td>" + esc(r.date) + "</td><td>" + fmt(r.ai) + "</td><td>" + fmt(r.msg) + "</td></tr>";
      }).join("") + "</tbody></table>";
  } else {
    trend = '<div class="card muted">还没有用量数据。和机器人聊一次天、或等一次定时任务，这里就会有数字。</div>';
  }
  $("#tab-overview").innerHTML =
    '<div class="cards">' + cards.map(function (c) {
      return '<div class="card"><div class="k">' + esc(c[0]) + '</div><div class="v">' + esc(c[1]) + "</div></div>";
    }).join("") + "</div>" +
    '<div class="row"><a href="/admin/export/users.csv"><button class="primary">⬇️ 导出用户 CSV</button></a>' +
    '<span class="muted">最多 5000 行，含积分与封禁状态</span></div>' +
    '<h3 style="font-size:14px;margin:18px 0 8px">📅 近 7 天用量</h3>' + trend;
}

// ============================================================
// 👥 用户
// ============================================================
var userQuery = "";
async function renderUsers(page) {
  var d = await api("/admin/api/users?q=" + encodeURIComponent(userQuery) + "&page=" + (page || 1));
  if (!d) return;
  var totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  var rows = d.rows.map(function (u) {
    var name = u.firstName || u.username || u.userId || "(未命名)";
    var kind = u.chatType === "private" ? "私聊" : "群";
    var quota = u.maxDaily === -1 ? "不限" : String(u.maxDaily);
    return "<tr>" +
      "<td>" + esc(name) + '<div class="muted">' + esc(u.userId || "") + "</div></td>" +
      "<td>" + esc(kind + " " + (u.chatId || "")) + "</td>" +
      "<td>" + fmt(u.points) + "</td>" +
      "<td>" + esc(quota) + "</td>" +
      "<td>" + (u.blocked ? '<span class="err">已封禁</span>' : "正常") + "</td>" +
      "<td>" + esc(u.updatedAt || "") + "</td>" +
      "<td>" +
        '<button data-block="' + esc(u.userId || "") + '" data-next="' + (u.blocked ? "0" : "1") + '" class="' + (u.blocked ? "" : "danger") + '">' + (u.blocked ? "解封" : "封禁") + "</button> " +
        '<button data-points="' + esc(u.userId || "") + '">改积分</button> ' +
        '<button data-scene="' + esc(u.sceneKey) + '" data-quota="' + esc(u.maxDaily) + '" data-rate="' + esc(u.rateLimitSec) + '">限额</button> ' +
        '<button data-clearmem="' + esc(u.sceneKey) + '">清记忆</button>' +
      "</td></tr>";
  }).join("");

  $("#tab-users").innerHTML =
    '<div class="row"><input id="q" placeholder="搜索昵称 / 用户名 / 用户ID / 群ID" value="' + esc(userQuery) + '" style="min-width:260px">' +
    '<button class="primary" id="search">搜索</button>' +
    '<span class="muted">共 ' + fmt(d.total) + " 条</span></div>" +
    "<table><thead><tr><th>用户</th><th>场景</th><th>积分</th><th>每日额度</th><th>状态</th><th>最后活跃</th><th>操作</th></tr></thead>" +
    "<tbody>" + (rows || '<tr><td colspan="7" class="empty">没有匹配的记录</td></tr>') + "</tbody></table>" +
    '<div class="row" style="margin-top:12px"><button id="prev"' + (page <= 1 ? " disabled" : "") + ">← 上一页</button>" +
    '<span class="muted">第 ' + page + " / " + totalPages + " 页</span>" +
    '<button id="next"' + (page >= totalPages ? " disabled" : "") + ">下一页 →</button></div>";

  $("#search").onclick = function () { userQuery = $("#q").value.trim(); renderUsers(1); };
  $("#q").onkeydown = function (e) { if (e.key === "Enter") { userQuery = $("#q").value.trim(); renderUsers(1); } };
  if ($("#prev")) $("#prev").onclick = function () { renderUsers(page - 1); };
  if ($("#next")) $("#next").onclick = function () { renderUsers(page + 1); };

  Array.prototype.forEach.call(document.querySelectorAll("[data-block]"), function (btn) {
    btn.onclick = async function () {
      var userId = btn.getAttribute("data-block");
      var blocked = btn.getAttribute("data-next") === "1";
      if (blocked && !confirm("确认封禁 " + userId + " ？（该用户在所有场景都会被拦下）")) return;
      var r = await api("/admin/api/users/block", { method: "POST", body: JSON.stringify({ userId: userId, blocked: blocked }) });
      if (r && r.ok) { toast(blocked ? "已封禁" : "已解封"); renderUsers(page); }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-points]"), function (btn) {
    btn.onclick = async function () {
      var target = btn.getAttribute("data-points");
      var delta = prompt("给 " + target + " 增减多少积分？（可为负数）", "10");
      if (delta === null) return;
      var r = await api("/admin/api/users/points", { method: "POST", body: JSON.stringify({ target: target, delta: Number(delta) }) });
      if (r && r.ok) { toast("已更新，当前余额 " + r.balance); renderUsers(page); }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-scene]"), function (btn) {
    btn.onclick = async function () {
      var sceneKey = btn.getAttribute("data-scene");
      var quota = prompt("每日额度（-1 = 不限，0 = 禁止使用）", btn.getAttribute("data-quota"));
      if (quota === null) return;
      var rate = prompt("冷却秒数（0 = 不限）", btn.getAttribute("data-rate"));
      if (rate === null) return;
      var r = await api("/admin/api/users/scene", {
        method: "POST",
        body: JSON.stringify({ sceneKey: sceneKey, maxDaily: Number(quota), rateLimitSec: Number(rate) })
      });
      if (r && r.ok) { toast("已更新限额"); renderUsers(page); }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-clearmem]"), function (btn) {
    btn.onclick = async function () {
      var sceneKey = btn.getAttribute("data-clearmem");
      if (!confirm("清空这个场景的对话记忆与长期印象？")) return;
      var r = await api("/admin/api/users/clear-memory", { method: "POST", body: JSON.stringify({ sceneKey: sceneKey }) });
      if (r && r.ok) { toast("已清空记忆"); renderUsers(page); }
    };
  });
}

// ============================================================
// 👥 群组
// ============================================================
async function renderGroups(page) {
  var d = await api("/admin/api/groups?page=" + (page || 1));
  if (!d) return;
  var totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  var rows = d.rows.map(function (g) {
    var feats = d.features.map(function (f) {
      var state = g.overrides[f.key];
      var on = state === undefined ? null : state;
      var cls = on === null ? "" : (on ? "on" : "off");
      var label = on === null ? f.label + "（跟随全局）" : f.label + (on ? "：开" : "：关");
      return '<button class="' + cls + '" data-gfeat="' + esc(f.key) + '" data-chat="' + esc(g.chatId) + '" data-next="' + (on === true ? "0" : "1") + '">' + esc(label) + "</button>";
    }).join("");
    return "<tr><td><code>" + esc(g.chatId) + '</code><div class="muted">' + fmt(g.members) + " 位成员</div>" +
      '<div class="feat">' + feats + "</div></td>" +
      "<td>" + esc(g.updatedAt) + "</td></tr>";
  }).join("");

  $("#tab-groups").innerHTML =
    '<div class="row"><span class="muted">点按钮切换<b>本群</b>的功能开关；没点过的项跟随全局设置。</span></div>' +
    "<table><thead><tr><th>群</th><th>最后活跃</th></tr></thead><tbody>" +
    (rows || '<tr><td colspan="2" class="empty">还没有群聊场景</td></tr>') + "</tbody></table>" +
    '<div class="row" style="margin-top:12px"><button id="gprev"' + (page <= 1 ? " disabled" : "") + ">← 上一页</button>" +
    '<span class="muted">第 ' + page + " / " + totalPages + " 页</span>" +
    '<button id="gnext"' + (page >= totalPages ? " disabled" : "") + ">下一页 →</button></div>";

  if ($("#gprev")) $("#gprev").onclick = function () { renderGroups(page - 1); };
  if ($("#gnext")) $("#gnext").onclick = function () { renderGroups(page + 1); };
  Array.prototype.forEach.call(document.querySelectorAll("[data-gfeat]"), function (btn) {
    btn.onclick = async function () {
      var r = await api("/admin/api/groups/feature", {
        method: "POST",
        body: JSON.stringify({
          chatId: btn.getAttribute("data-chat"),
          feature: btn.getAttribute("data-gfeat"),
          enabled: btn.getAttribute("data-next") === "1"
        })
      });
      if (r && r.ok) { toast("已切换"); renderGroups(page); }
    };
  });
}

// ============================================================
// 🛒 商城
// ============================================================
var orderFilter = "pending";
async function renderShop(page) {
  var items = await api("/admin/api/shop/items");
  var orders = await api("/admin/api/shop/orders?status=" + encodeURIComponent(orderFilter) + "&page=" + (page || 1));
  if (!items || !orders) return;

  var itemRows = items.rows.map(function (it) {
    return "<tr><td>" + esc(it.icon + " " + it.name) + '<div class="muted">' + esc(it.deliveryText) + "</div></td>" +
      '<td><input type="number" min="0" value="' + it.price + '" data-price="' + it.id + '"></td>' +
      '<td><input type="number" min="-1" value="' + it.stock + '" data-stock="' + it.id + '"></td>' +
      "<td>" + fmt(it.sold) + "</td>" +
      "<td>" + (it.enabled ? '<span class="pill on">上架</span>' : '<span class="pill off">下架</span>') + "</td>" +
      "<td>" +
        '<button data-toggle-item="' + it.id + '" data-next="' + (it.enabled ? "0" : "1") + '">' + (it.enabled ? "下架" : "上架") + "</button> " +
        '<button data-save-item="' + it.id + '" class="primary">保存改动</button>' +
      "</td></tr>";
  }).join("");

  var statusText = { pending: "待处理", done: "已完成", cancelled: "已取消", refunded: "已退款" };
  var orderRows = orders.rows.map(function (o) {
    var actions = "";
    if (o.status === "pending") {
      actions = '<button data-order="' + o.id + '" data-act="done" class="primary">标记完成</button> ' +
        '<button data-order="' + o.id + '" data-act="cancel" class="danger">取消退款</button>';
    } else if (o.status === "done") {
      actions = '<button data-order="' + o.id + '" data-act="refund" class="danger">退款</button>';
    } else {
      actions = '<span class="muted">—</span>';
    }
    return "<tr><td>" + esc(o.name) + '<div class="muted">' + esc(o.orderNo) + "</div></td>" +
      "<td>" + esc(o.userId) + "</td><td>" + fmt(o.price) + "</td>" +
      "<td>" + esc(statusText[o.status] || o.status) + "</td>" +
      "<td>" + esc(o.createdAt) + "</td><td>" + actions + "</td></tr>";
  }).join("");

  var filters = [["pending", "待处理"], ["done", "已完成"], ["cancelled", "已取消"], ["refunded", "已退款"], ["all", "全部"]];
  var filterHtml = filters.map(function (f) {
    return '<button data-filter="' + f[0] + '" class="' + (orderFilter === f[0] ? "primary" : "") + '">' + f[1] + "</button>";
  }).join(" ");

  $("#tab-shop").innerHTML =
    '<h3 style="font-size:14px;margin:0 0 8px">🎁 商品</h3>' +
    "<table><thead><tr><th>商品</th><th>售价</th><th>库存</th><th>已售</th><th>状态</th><th>操作</th></tr></thead><tbody>" +
    (itemRows || '<tr><td colspan="6" class="empty">还没有商品</td></tr>') + "</tbody></table>" +
    '<h3 style="font-size:14px;margin:22px 0 8px">📦 订单</h3>' +
    '<div class="row">' + filterHtml + "</div>" +
    "<table><thead><tr><th>商品</th><th>买家</th><th>价格</th><th>状态</th><th>下单时间</th><th>操作</th></tr></thead><tbody>" +
    (orderRows || '<tr><td colspan="6" class="empty">没有订单</td></tr>') + "</tbody></table>" +
    '<div class="row" style="margin-top:12px"><span class="muted">共 ' + fmt(orders.total) + " 笔 · 库存 -1 表示不限量</span></div>";

  Array.prototype.forEach.call(document.querySelectorAll("[data-toggle-item]"), function (btn) {
    btn.onclick = async function () {
      var r = await api("/admin/api/shop/item", {
        method: "POST",
        body: JSON.stringify({ itemId: Number(btn.getAttribute("data-toggle-item")), enabled: btn.getAttribute("data-next") === "1" })
      });
      if (r && r.ok) { toast("已切换上下架"); renderShop(page); }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-save-item]"), function (btn) {
    btn.onclick = async function () {
      var id = btn.getAttribute("data-save-item");
      var price = document.querySelector('[data-price="' + id + '"]').value;
      var stock = document.querySelector('[data-stock="' + id + '"]').value;
      var r = await api("/admin/api/shop/item", {
        method: "POST",
        body: JSON.stringify({ itemId: Number(id), price: Number(price), stock: Number(stock) })
      });
      if (r && r.ok) { toast("已保存"); renderShop(page); }
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-filter]"), function (btn) {
    btn.onclick = function () { orderFilter = btn.getAttribute("data-filter"); renderShop(1); };
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-order]"), function (btn) {
    btn.onclick = async function () {
      var act = btn.getAttribute("data-act");
      var label = { done: "标记完成", cancel: "取消并退款", refund: "退款" }[act];
      if (!confirm("确认对该订单「" + label + "」？")) return;
      var r = await api("/admin/api/shop/order", {
        method: "POST",
        body: JSON.stringify({ orderId: Number(btn.getAttribute("data-order")), action: act })
      });
      if (r && r.ok) { toast("已处理"); renderShop(page); }
    };
  });
}

// ============================================================
// 🎟️ 兑换码
// ============================================================
async function renderCodes(page) {
  var d = await api("/admin/api/codes?page=" + (page || 1));
  if (!d) return;
  var totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  var rows = d.rows.map(function (c) {
    return "<tr><td><code>" + esc(c.code) + "</code></td>" +
      "<td>" + fmt(c.points) + "</td>" +
      "<td>" + c.usedCount + " / " + c.maxUses + "</td>" +
      "<td>" + (c.expiresAt ? esc(c.expiresAt) : "不过期") + "</td>" +
      "<td>" + (c.enabled ? '<span class="pill on">启用</span>' : '<span class="pill off">停用</span>') + "</td>" +
      "<td>" + esc(c.createdAt) + "</td>" +
      '<td><button data-code="' + c.id + '" data-next="' + (c.enabled ? "0" : "1") + '">' + (c.enabled ? "停用" : "启用") + "</button></td></tr>";
  }).join("");

  $("#tab-codes").innerHTML =
    '<div class="row">' +
    '<span class="muted">生成：</span>' +
    '<input id="c-points" type="number" value="100" title="每个码的积分"> ' +
    '<input id="c-count" type="number" value="1" title="生成几个（最多 50）"> ' +
    '<input id="c-uses" type="number" value="1" title="每个码可用次数"> ' +
    '<input id="c-days" type="number" value="0" title="有效天数（0 = 不过期）"> ' +
    '<button class="primary" id="c-create">生成</button>' +
    '<span class="muted">（积分 / 个数 / 可用次数 / 有效天数）</span></div>' +
    "<table><thead><tr><th>兑换码</th><th>积分</th><th>已用</th><th>有效期</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody>" +
    (rows || '<tr><td colspan="7" class="empty">还没有兑换码</td></tr>') + "</tbody></table>" +
    '<div class="row" style="margin-top:12px"><button id="cprev"' + (page <= 1 ? " disabled" : "") + ">← 上一页</button>" +
    '<span class="muted">第 ' + page + " / " + totalPages + " 页 · 共 " + fmt(d.total) + " 个</span>" +
    '<button id="cnext"' + (page >= totalPages ? " disabled" : "") + ">下一页 →</button></div>";

  if ($("#cprev")) $("#cprev").onclick = function () { renderCodes(page - 1); };
  if ($("#cnext")) $("#cnext").onclick = function () { renderCodes(page + 1); };
  $("#c-create").onclick = async function () {
    var r = await api("/admin/api/codes", {
      method: "POST",
      body: JSON.stringify({
        points: Number($("#c-points").value),
        count: Number($("#c-count").value),
        maxUses: Number($("#c-uses").value),
        validDays: Number($("#c-days").value)
      })
    });
    if (r && r.ok) {
      toast("已生成 " + r.codes.length + " 个：" + r.codes.slice(0, 3).join(" "));
      renderCodes(1);
    }
  };
  Array.prototype.forEach.call(document.querySelectorAll("[data-code]"), function (btn) {
    btn.onclick = async function () {
      var r = await api("/admin/api/codes/toggle", {
        method: "POST",
        body: JSON.stringify({ codeId: Number(btn.getAttribute("data-code")), enabled: btn.getAttribute("data-next") === "1" })
      });
      if (r && r.ok) { toast("已切换"); renderCodes(page); }
    };
  });
}

// ============================================================
// 📜 日志
// ============================================================
async function renderLogs(page) {
  var d = await api("/admin/api/logs?page=" + (page || 1));
  if (!d) return;
  var totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  var rows = d.rows.map(function (l) {
    return '<tr><td class="muted">' + esc(l.createdAt) + "</td><td><code>" + esc(l.adminId) + "</code></td>" +
      "<td>" + esc(l.action) + "</td><td>" + esc(l.detail) + "</td></tr>";
  }).join("");

  $("#tab-logs").innerHTML =
    "<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr></thead><tbody>" +
    (rows || '<tr><td colspan="4" class="empty">还没有日志</td></tr>') + "</tbody></table>" +
    '<div class="row" style="margin-top:12px"><button id="lprev"' + (page <= 1 ? " disabled" : "") + ">← 上一页</button>" +
    '<span class="muted">第 ' + page + " / " + totalPages + " 页 · 共 " + fmt(d.total) + " 条</span>" +
    '<button id="lnext"' + (page >= totalPages ? " disabled" : "") + ">下一页 →</button></div>";

  if ($("#lprev")) $("#lprev").onclick = function () { renderLogs(page - 1); };
  if ($("#lnext")) $("#lnext").onclick = function () { renderLogs(page + 1); };
}

// ============================================================
// 标签切换
// ============================================================
var renderers = {
  overview: renderOverview,
  users: function () { renderUsers(1); },
  groups: function () { renderGroups(1); },
  shop: function () { renderShop(1); },
  codes: function () { renderCodes(1); },
  logs: function () { renderLogs(1); }
};
function switchTab(name) {
  Object.keys(renderers).forEach(function (key) {
    var section = $("#tab-" + key);
    if (section) section.hidden = key !== name;
    var link = document.querySelector('[data-tab="' + key + '"]');
    if (link) link.classList.toggle("on", key === name);
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  renderers[name]();
}
document.querySelectorAll("[data-tab]").forEach(function (a) {
  a.onclick = function () { switchTab(a.getAttribute("data-tab")); };
});
switchTab(renderers[location.hash.slice(1)] ? location.hash.slice(1) : "overview");
</script>
</body></html>`;
}
