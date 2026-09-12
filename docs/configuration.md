# ⚙️ 配置项

[返回首页](../README.md) · [文档索引](README.md)

## 环境变量

| 变量 | 必需 | 默认 | 说明 |
|------|:----:|------|------|
| `BOT_TOKEN` | ✅ | — | BotFather 颁发的 Token |
| `MY_TELEGRAM_ID` | ✅ | — | 管理员数字 ID；只有它能使用 `/admin` 与全部管理指令 |
| `BOT_USERNAME` | 建议 | 空 | 机器人用户名（不含 `@`），群聊里识别 @ 提及用 |
| `WEBHOOK_SECRET` | 建议 | 空 | 填了之后 Telegram 必须回传 `X-Telegram-Bot-Api-Secret-Token`，否则拒绝请求 |
| `APP_TIMEZONE` | 可选 | `Asia/Shanghai` | 签到、每日额度、任务结算使用的时区 |
| `BOT_OWNER_NAME` | 可选 | `管理员` | 展示给用户的称呼（AI 提示词里也会用到） |
| `BOT_OWNER_USERNAME` | 可选 | `admin` | 管理员用户名（不含 `@`） |
| `ADMIN_NOTIFY_CHAT_ID` | 可选 | 同 `MY_TELEGRAM_ID` | 新订单、预警、申诉等通知发到哪个会话 |
| `AI_MODELS` | 可选 | 内置回退链 | 逗号分隔的模型列表，覆盖默认主 / 备模型 |
| `AI_HISTORY_MAX_CHARS` | 可选 | `6000` | AI 上下文字符预算（`>= 500` 才生效） |
| `KB_EMBED_MODEL` | 可选 | `@cf/baai/bge-m3` | 知识库向量模型；换模型后需在面板里「🧠 重建索引」 |
| `KB_ANSWER_MODE` | 可选 | `hybrid` | 知识库回答模式：`hybrid` 资料没覆盖时用 AI 自己的知识回答；`strict` 只依据资料 |

### 关于 AI 模型

内置回退链：

```
@cf/meta/llama-3.3-70b-instruct-fp8-fast      ← 主模型
@cf/meta/llama-3.1-8b-instruct-fast           ← 主模型失败时
@cf/mistral/mistral-7b-instruct-v0.1          ← 再失败时
```

主模型报错或返回空内容会自动切换下一个；全部失败才提示「AI 服务异常」，并退回本次消耗的积分与额度。

想换成别的模型（例如更便宜的 8B，或中文更好的模型）：

```toml
[vars]
AI_MODELS = "@cf/meta/llama-3.1-8b-instruct-fast,@cf/mistral/mistral-7b-instruct-v0.1"
```

换知识库向量模型（例如 `@cf/baai/bge-large-zh-v1.5`）后，旧向量与新模型维度不一致会被跳过，需要在知识库面板点「🧠 重建索引」分批补建。

## 绑定

| 绑定 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `DB` | D1 | 是\* | 用户、积分、商城、知识库、执法记录等全部数据 |
| `AI` | Workers AI | 是\* | AI 对话与知识库向量；未绑定时对话会提示并自动退分 |

\* 代码对缺失绑定做了降级处理：没有 `DB` 时依赖数据库的功能会提示「未绑定数据库」，没有 `AI` 时知识库退化为关键词检索。要完整体验请两个都绑定。

## 配置文件与本地文件

| 文件 / 变量 | 用途 | 是否提交 |
|------------|------|---------|
| `wrangler.toml` | 模板配置（占位符） | ✅ 可以提交 |
| `wrangler.production.toml` | 生产配置（含 Token） | ❌ 已 gitignore |
| `.dev.vars` | `npm run dev` 用的本地变量 | ❌ 已 gitignore |
| `.config-backup` | 配置备份目标私有仓库 `owner/repo` | ❌ 已 gitignore |
| `backups/` | `npm run backup` 导出的数据库文件 | ❌ 已 gitignore |

### 生产配置怎么放

两种方式，任选一种：

1. **写进 `wrangler.toml` 的 `[vars]`**：简单，但这个文件如果被提交就会泄露 Token。
2. **用 Cloudflare Secret（推荐）**：

   ```bash
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   ```

   密钥同样以环境变量形式注入，代码无需改动。

想把生产配置和模板分开管理，可以另存一份 `wrangler.production.toml`（已被 gitignore），然后 `npm run deploy:prod`；这份文件建议用 [配置备份](deployment.md#配置备份可选) 推到自己的私有仓库。

## 定时任务

在 `wrangler.toml` 里：

```toml
[triggers]
crons = ["0 16 * * *"]      # UTC 16:00 = 北京时间 00:00
```

> Cron 表达式**始终按 UTC 解析**，`APP_TIMEZONE` 只影响业务里的「今天」怎么算，不会改变 Cron 的触发时刻。

具体每次跑什么，见 [部署与运维 → 定时任务](deployment.md#定时任务)。
