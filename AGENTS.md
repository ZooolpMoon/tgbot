# AGENTS.md

给在本仓库工作的 AI / 协作者的约定。**改动后请同步更新本文件，并提交推送。**

## 项目定位

- 一个跑在 **Cloudflare Workers + D1 + Workers AI** 上的 Telegram 机器人（AI 对话、积分、签到、小游戏、积分商城、管理后台）。
- 本仓库 `ZooolpMoon/tgbot`（公开）**同时承担两件事**：开源项目 + 代码备份。
- **生产部署在本地执行**（`npm run deploy:prod`），不依赖任何 CI/CD：
  - 仓库里**不含** GitHub Actions 工作流，也不要主动添加（曾按需求移除）。
  - 如果将来要加自动化，必须先确认需求——目前约定是「本地部署 + push 备份」。

## 绝对不能提交的内容

| 文件 | 说明 |
|------|------|
| `wrangler.production.toml` | 生产配置：Bot Token、账号 ID、D1 database_id |
| `.dev.vars` | 本地开发变量（含 Token） |
| `.config-backup` | 私有备份仓库名（一行 `owner/repo`） |
| `.local/` | 本地工具（如 `push-via-api.mjs`） |
| `backups/` | 数据库导出文件 |

这些都在 `.gitignore` 里。提交前建议自查：

```bash
npm run check
git status --short
git ls-files | findstr production   # Windows；应无输出
```

生产配置的备份走 `npm run backup:config`（推到**私有**仓库，脚本会先校验目标仓库确实是私有的）。

## 常用命令

```bash
npm run dev             # 本地预览（读取 .dev.vars）
npm run deploy:prod     # 部署到 Cloudflare（读取 wrangler.production.toml）
npm run check           # 语法 + import 路径自检（覆盖 src / scripts / test / test-helpers）
npm test                # 测试（node:test + node:sqlite，内存库跑真实 SQL）
npm run backup          # D1 导出到 backups/
npm run backup:config   # 生产配置备份到私有仓库
```

### 提交前必须做

1. `npm run check` 通过
2. `npm test` 通过（当前 71 个用例）
3. 改了 Schema / 迁移 → 递增 `src/core/db.js` 的 `SCHEMA_VERSION`
4. 发版本 → 同步 `package.json` 版本号与 `CHANGELOG.md`

### 推送被墙时的兜底

`github.com:443` 在本机会间歇性不可达（`Recv failure: Connection was reset`）。此时用本地工具走 GitHub API 推送：

```bash
node .local/push-via-api.mjs --dry-run   # 先看要推什么
node .local/push-via-api.mjs             # 真正推送（会校验 blob/tree 一致并自动对齐本地分支）
```

## 代码约定

- **ESM + 显式扩展名**：`import { x } from "./y.js"`（Node 与 Wrangler 都要求）。
- **注释与用户可见文案用中文**；管理端文案也是中文（`/setlang` 只影响 AI 回复语言）。
- 目录职责：
  - `src/config/`：常量、文案、任务触发器
  - `src/core/`：上下文、DB Schema、日志
  - `src/services/`：业务服务（users/points/quota/checkin/redeem/tasks/features/settings/daily/admin-log/history）
  - `src/handlers/`：消息与回调入口
  - `src/admin/`：管理面板 UI
  - `src/shop/`、`src/games/`：业务模块
- **加命令**：在 `src/handlers/commands/registry.js` 的 `COMMANDS` 加一条即可（权限、别名、仅私聊、功能开关、`/help` 文案都由注册表处理），不要再去 `message.js` 里加 `if`。
- **加功能开关**：在 `src/services/features.js` 的 `FEATURES` 里加一项；开关**只作用于全局**（v2.1.0 起不再有场景级覆盖）。
- **改 Schema**：
  1. 在 `SCHEMA_SQL` 里加表/索引（`CREATE TABLE IF NOT EXISTS`）
  2. 结构或数据迁移写进 `MIGRATIONS` 数组（必须幂等）
  3. `SCHEMA_VERSION` +1（冷启动靠它跳过建表）
  4. 用一次性标记（如 `task.seeded`）避免「管理员删掉的数据又被灌回来」
- **涉及积分的操作**：原子条件 UPDATE（`WHERE points >= ?` / `WHERE status = 'pending'`）+ `points_log` 流水，失败要补偿回滚。
- **用户可控文本**：进 HTML 消息前一律 `escapeHtml()`（usage 占位符也要转义，否则 Telegram 会当标签）。
- **随机**：用 `src/utils/random.js`（`crypto.getRandomValues`），不要用 `Math.random`。
- **Telegram API**：统一走 `src/telegram/api.js`（自带 429/5xx 退避重试）。

## Git 约定

- 提交信息中文，前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`；破坏性变更用 `feat!:`。
- 一次提交只做一件事；提交信息里写清「做了什么 + 为什么」。
- 主要分支 `main`，推送 `origin`（公开仓库）。生产部署在本地，不需要 GitHub 侧动作。

## 许可

GPL-3.0-or-later（见 `LICENSE`，勿修改正文）。新增代码沿用同一许可，不要引入与之冲突的依赖。
