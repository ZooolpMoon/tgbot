# 🤖 Telegram AI Bot（Cloudflare Workers + D1 + Workers AI）

一个可以自己部署的 Telegram 机器人：AI 对话、群知识库问答、群规执法、积分与签到、每日任务、小游戏、积分商城、兑换码，外加一套带审计的管理后台。

全部跑在 **Cloudflare Workers** 上——不需要服务器、不需要常驻进程、不需要数据库运维，数据保存在你自己的 Cloudflare 账号里。

> 当前版本 **v2.7.0** · 变更记录 [CHANGELOG.md](CHANGELOG.md) · 文档索引 [docs/](docs/README.md) · 许可 [GPL-3.0-or-later](LICENSE)

---

## 📑 目录

- [适合谁 / 不适合谁](#-适合谁--不适合谁)
- [能做什么](#-能做什么)
- [快速开始](#-快速开始)
- [常用指令速查](#-常用指令速查)
- [文档导航](#-文档导航)
- [已知限制](#-已知限制)
- [许可](#-许可)

---

## 🎯 适合谁 / 不适合谁

**适合**

- 想给自己的 Telegram 群配一个「能干活的」助手：答疑、查资料、维护群规
- 想有一个**完全自己掌控**的机器人（Token、数据、模型调用都在自己账号里）
- 能接受「克隆仓库 → 改几个配置 → `npm run deploy:prod`」这种自托管方式

**不适合**

- 想开箱即用的多租户 SaaS（本项目是**单管理员**模型：一个 Bot、一个主人）
- 需要万人规模知识库的检索（当前用 D1 存向量，见 [已知限制](#-已知限制)）
- 完全不想碰命令行

---

## ✨ 能做什么

| 能力 | 一句话 | 入口 | 文档 |
|------|--------|------|------|
| 🤖 AI 对话 | 多模型自动回退、上下文预算、积分计费、失败自动退款 | 私聊直接说，群里 @ 机器人 | [功能详解](docs/features.md) |
| 📚 知识库问答（RAG） | 上传群规 / 手册 / FAQ，AI 先检索再回答并标注来源 | `/kb` 或后台 → 📚 知识库 | [知识库](docs/knowledge-base.md) |
| 🛡️ 群规执法 | 群里 @ 机器人说「封禁 @某人 发广告」，先校验理由再执行；支持踢出 / 群封 / 限时禁言 / 申诉 / 预警 | 群里自然语言，或 `/guard` 面板 | [群规执法](docs/group-guard.md) |
| 🪙 积分体系 | 全局共享积分、流水、排行榜、管理员增减与封禁 | `/points`、`/rank` | [功能详解](docs/features.md) |
| 📅 签到与每日任务 | 连续签到奖励递增；任务由管理员引导式增删改 | `/checkin`、`/tasks` | [功能详解](docs/features.md) |
| 🎮 小游戏 | 骰子猜大小、老虎机、抛硬币、幸运转盘 | `/game` | [功能详解](docs/features.md) |
| 🛒 积分商城 | 商品上下架、限购、下单备注、订单状态机、取消自动退款 | `/shop`（仅私聊） | [功能详解](docs/features.md) |
| 🎟️ 兑换码 | 批量生成、次数与有效期控制、每人限兑一次 | `/code_new`、`/redeem` | [功能详解](docs/features.md) |
| 👑 管理后台 | 用户管理、群组浏览、封禁名单、知识库、群规、功能开关、审计日志、群发 | `/admin` | [后台导览](docs/admin-console.md) |
| ⏰ 定时任务 | 清理过期会话、推送每日概况、维护知识库索引、处置到期通知 | Cron Trigger | [部署与运维](docs/deployment.md) |

几个具体的使用画面：

```
群成员：@YourBot 退货怎么处理？
Bot  ：AI 先检索群知识库 → 命中「售后政策」→ 依据资料回答并标注来源

管理员：@YourBot 封禁 @某人 发广告刷屏
Bot  ：理由校验通过（违规类型「广告 / 推广引流」）→ 给管理员一张确认卡片
管理员：点「✅ 确认执行」（或一键改成禁言 / 踢出）
Bot  ：执行 + 群里公告 + 私聊当事人 + 写入审计

群成员：（回复违规消息）@YourBot 举报 发广告
Bot  ：把带处置按钮的卡片发到管理员私聊，群里只回执「已转给管理员」
```

---

## 🚀 快速开始

大约 10 分钟可以从零跑起来。**全程不需要写代码。**

### 0. 前置准备

| 需要的东西 | 怎么拿 |
|-----------|--------|
| Cloudflare 账号 | <https://dash.cloudflare.com/sign-up>（Workers / D1 / Workers AI 都有免费额度） |
| Node.js 18+ | <https://nodejs.org>（含 `npm`） |
| Bot Token | Telegram 里找 [@BotFather](https://t.me/BotFather) → `/newbot`，拿到形如 `123456:ABC-DEF...` 的 Token |
| 你的 Telegram 数字 ID | 找 [@userinfobot](https://t.me/userinfobot) 发一句话，它会返回你的 `id`（用于 `MY_TELEGRAM_ID`） |

### 1. 克隆并安装依赖

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler login          # 浏览器里授权 Cloudflare
npx wrangler d1 create your-db-name
```

命令会输出一段 `[[d1_databases]]` 配置，里面的 `database_id` 下一步要用。

> 表结构不用手动建：机器人第一次收到请求时会自动 `CREATE TABLE IF NOT EXISTS`（幂等，不会覆盖已有数据）。

### 3. 填写配置

仓库里的 `wrangler.toml` 是**模板文件**（只有占位符，可以直接提交），把 `[[d1_databases]]` 取消注释并填入上一步的 `database_id`：

```toml
name = "tgbot"
main = "src/index.js"
compatibility_date = "2025-01-01"

[vars]
BOT_TOKEN = ""              # 建议改用 wrangler secret put（见下）
BOT_USERNAME = ""           # 机器人用户名，不含 @
MY_TELEGRAM_ID = ""         # 你自己的数字 ID，只有它能用 /admin
WEBHOOK_SECRET = ""         # 建议填一串随机字符
APP_TIMEZONE = "Asia/Shanghai"
BOT_OWNER_NAME = "管理员"
BOT_OWNER_USERNAME = ""

[[d1_databases]]
binding = "DB"
database_name = "your-db-name"
database_id = "<上一步输出的 id>"

[ai]
binding = "AI"

[triggers]
crons = ["0 16 * * *"]      # UTC 16:00 = 北京时间 00:00 跑定时任务
```

**更安全的做法**：`BOT_TOKEN` 这类敏感值不放配置文件，改用 Cloudflare Secret：

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

所有配置项的含义见 [配置项](docs/configuration.md)。

### 4. 本地预览（可选）

新建 `.dev.vars`（已在 `.gitignore` 中，不会被提交），内容与 `[vars]` 一致：

```ini
BOT_TOKEN="123456:ABC-DEF..."
BOT_USERNAME="YourBot"
MY_TELEGRAM_ID="123456789"
WEBHOOK_SECRET=""
APP_TIMEZONE="Asia/Shanghai"
```

```bash
npm run dev      # 启动本地 Worker（默认 http://localhost:8787）
npm run check    # 语法 + import 路径自检
npm test         # 175 个测试用例（内存 SQLite 跑真实 SQL）
```

### 5. 部署

```bash
npm run deploy   # 用 wrangler.toml
```

如果想区分「模板配置」和「生产配置」，可以另存一份 `wrangler.production.toml`（**不要提交，已 gitignore**），然后：

```bash
npm run deploy:prod
```

部署成功后会输出形如 `https://your-worker.<subdomain>.workers.dev` 的地址。

### 6. 设置 Webhook

```bash
curl -F "url=https://your-worker.<subdomain>.workers.dev/" \
     -F "secret_token=<与 WEBHOOK_SECRET 相同的随机串>" \
     "https://api.telegram.org/bot<你的 BOT_TOKEN>/setWebhook"
```

返回 `{"ok":true,...}` 即成功。可以用 `getWebhookInfo` 复查；用浏览器打开 Worker 根地址显示「已成功部署！」说明服务正常。

### 7. 关闭群聊 Privacy Mode（否则群里收不到消息）

Telegram 默认只把 `/命令` 和 @ 提及转给机器人。要在群里正常对话，找 [@BotFather](https://t.me/BotFather)：

```
/mybots → 选择你的机器人 → Bot Settings → Group Privacy → Turn off
```

### 8. 把机器人设为群管理员（群规执法需要）

群规执法中的**踢出 / 群封 / 禁言**走 Telegram 官方能力，需要机器人在群里是管理员，并勾选：

- 删除消息
- 封禁用户

（只使用「机器人封禁」则不需要群管理权限——那只影响机器人自己的服务。）

### 9. 自检清单

| 检查项 | 期望结果 |
|--------|---------|
| 私聊发 `/start` | 返回欢迎卡片，显示积分与今日额度 |
| 聊天框输入 `/` | 弹出指令菜单（部署后自动同步，必要时 `/syncmenu` 刷新） |
| 发 `/admin` | 管理员控制台（只有 `MY_TELEGRAM_ID` 能用） |
| 控制台 → 📊 运行状态 | D1 与 Workers AI 都显示「已绑定」 |
| 群里 @ 机器人说话 | 正常回复（没反应多半是 Privacy Mode 没关） |

---

## 📖 常用指令速查

**用户**：`/start` 开始 · `/help` 帮助 · `/checkin` 签到 · `/tasks` 每日任务 · `/points` 积分流水 · `/rank` 排行榜 · `/game` 游戏大厅 · `/profile` 我的资料 · `/shop` 商城 · `/orders` 我的订单 · `/redeem` 兑换码 · `/appeal` 申诉

**管理员**：`/admin` 控制台 · `/users` `/users_group` 用户列表 · `/stats` 统计 · `/kb` 知识库 · `/guard` `/rules` `/setrules` 群规执法 · `/ban` `/kick` `/groupban` `/mute` `/unban` `/unmute` 处置 · `/code_new` `/code_list` 兑换码 · `/broadcast` 群发 · `/shop_admin` `/shop_add` `/shop_edit` 商城管理 · `/syncmenu` 刷新输入框菜单

> 管理员指令需要先在私聊发 `/admin` 解锁（30 分钟内有效）。完整表格、别名与参数说明见 [指令一览](docs/commands.md)。

---

## 📚 文档导航

| 文档 | 什么时候看 |
|------|-----------|
| [配置项](docs/configuration.md) | 改环境变量、换 AI / 向量模型、理解各绑定与本地文件的分工 |
| [指令一览](docs/commands.md) | 查指令用法、别名、群聊行为差异、输入框菜单原理 |
| [管理后台导览](docs/admin-console.md) | 后台每个面板能做什么、功能开关有几级、审计日志怎么筛 |
| [功能详解](docs/features.md) | AI 对话、积分、签到、每日任务、小游戏、商城、兑换码的参数与规则 |
| [知识库（RAG）](docs/knowledge-base.md) | 上传资料让 AI 依据资料回答、检索不到时怎么排查 |
| [群规执法](docs/group-guard.md) | 封禁 / 踢出 / 禁言的完整规则、理由校验、预警、申诉、群规版本 |
| [架构与数据库](docs/architecture.md) | 请求流程、目录结构、数据表、迁移流程与关键设计约定 |
| [开发与测试](docs/development.md) | 跑测试、加命令 / 加开关 / 加游戏 / 换向量方案 |
| [部署与运维](docs/deployment.md) | 部署、日志、回滚、备份、定时任务、资源与配额建议 |
| [安全与隐私](docs/security.md) | 上线前检查密钥管理、访问控制、提示词注入与数据留存 |
| [常见问题与已知限制](docs/faq.md) | 遇到问题先翻这里 |

---

## 🚧 已知限制

- **单管理员模型**：只有 `MY_TELEGRAM_ID` 能进管理后台（群规执法额外允许本群管理员）
- **知识库规模**：向量存在 D1、在 Worker 内算余弦相似度，单作用域约 400 块 / 25 万字量级；更大规模建议迁移 Vectorize
- **PDF 解析是尽力而为**：扫描件、加密 PDF、特殊字体编码可能抽不出文字（会明确提示，不会静默失败），需要先 OCR
- **无 Web 后台**：所有管理操作都在 Telegram 内完成
- **平台限制**：Workers 有 CPU 时间与请求大小限制，因此群发、索引重建、处置通知都做了分批与上限
- **多语言**：AI 回复支持中英切换（`/setlang`），但界面文案目前是中文

更完整的说明与缓解方式见 [常见问题与已知限制](docs/faq.md)。

---

## 📄 许可

本项目采用 **GNU General Public License v3.0 或更高版本**（SPDX：`GPL-3.0-or-later`），完整全文见 [LICENSE](LICENSE)。

```
Copyright (C) 2026 ZooolpMoon

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.
```

你可以自由使用、修改、分发（需保留许可与作者声明）。如果这个项目对你有帮助，欢迎 Star、提 Issue 或 PR。
