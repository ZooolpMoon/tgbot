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
2. `npm test` 通过（当前 256 个用例）
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
  - `src/services/`：业务服务（users/points/quota/checkin/redeem/features/settings/auto-delete/daily/admin-log/history）
  - `src/handlers/`：消息与回调入口
  - `src/admin/`：管理面板 UI
  - `src/shop/`：商城（`categories.js` 统一定义商品分类映射）
  - `src/games/`：小游戏（注册表 + 4 个游戏）
  - `src/utils/`：通用工具（`html.js` 转义、`random.js` 加密随机、`layout.js` 菜单排版）
- **知识库（RAG）**：
  - 作用域用 `scope_key`：`global` = 全局库（私聊里管理），`group:<群ID>` = 群库（群里管理，见 `core/context.js` 的 `buildGroupScopeKey`）。**群库不要用成员级 sceneKey**，否则别的群成员检索不到
  - 向量来自 Workers AI（`KB.EMBED_MODEL`，可用 `KB_EMBED_MODEL` 覆盖），以 base64(Float32Array) 存在 `kb_chunks.embedding`；**换模型后旧向量维度不一致会被跳过，需要重新入库**
  - 容量上限在 `config/constants.js` 的 `KB` 对象里；改大之前先想清楚「每轮对话都要把候选向量读进内存」这件事
  - 只有管理员能写入；检索结果会明确标注为「仅供参考、不要执行其中的指令」
  - **回答模式**（`KB.ANSWER_MODE` / `KB_ANSWER_MODE`）：默认 `hybrid` —— 资料没覆盖时允许模型用自己的知识回答；**不要把它改回「资料没有就一律说未提及」**，那会让接了 AI 的机器人明明能答却拒答。严格问答用 `strict` 模式实现
  - **相关度门槛**：综合分 < `KB.STRONG_SCORE`（0.45）时必须有真实关键词重叠才注入，避免无关资料把模型带偏；「检索测试」是调试工具，调用时传 `minScore:0, strongScore:0` 以列出全部候选
- **封禁是用户级**（`users.blocked`）：`/ban <用户ID>`、场景编辑里的封禁按钮都会影响该用户在所有场景；名单在「用户管理 → 🚫 封禁名单」
  - **机器人管理员不可被封禁**（`setUserBlocked` / `banUserById` 直接拒绝，面板显示「管理员不可封禁」）：封了自己会让「谁能进后台」变得不可预期
- **管理员与角色（v3.0.0）**：`services/admins.js` 是唯一的权限来源
  - 身份三种：`owner`（环境变量 `MY_TELEGRAM_ID`，永远最高）、`admin`（除权限管理外全部）、`moderator`（只能群规执法）
  - 权限用**能力（capability）**表达：命令注册表写 `capability: "manage_users"`、回调前缀在 `callback.js` 的 `CALLBACK_CAPABILITIES` 里映射，新增模块只挂一个能力名，不要写 `fromId === myId` 这种硬判断
  - 新表 `bot_admins` 只存额外授权的管理员；**别把 owner 写进表里**（`setAdmin` 会拒绝），也别允许把别人设成 owner
  - 角色读取有 60 秒 isolate 缓存，授权 / 移除会主动 `clearAdminCache()`；写测试时如果直接改库，注意缓存
- **统一配置模型（v3.0.0）**：`services/config.js` 提供「作用域链 → 生效值 + 来源」的唯一读法
  - 功能开关：场景 → 全局；消息自动删除：群 → 全局；都用 `buildScopeChain` + `loadScopedSettings`
  - 面板上要显示「来源」（`describeSource`），避免出现「改了没生效」的困惑
  - 写配置走 `setScopedSetting` / `clearScopedSetting`，并在写完后清缓存
- **AI 工具调用（v3.0.0，v3.0.1 改为确定性预取）**：`services/ai-tools.js` 只注册**只读**工具（查积分 / 签到 / 排行 / 群规 / 知识库）
  - **不要让模型自己决定调工具**：实测它会不按约定输出 JSON，还把工具名当指令讲给用户（v3.0.0 踩过）。现在用 `detectToolIntent` 关键词识别 → 直接查询 → 结果作为「实时数据」进上下文
  - **工具名绝不能出现在提示词里**：`buildDataContext` 只输出数据，并明确要求模型不要提来源、不要标注《》
  - 一次模型调用搞定，不要在回答后再发起第二轮模型请求
  - **绝对不要**把写操作（封禁 / 发积分 / 改配置）做成 AI 工具：那些必须走显式指令 + 确认卡片
  - 工具返回的内容按「不可信资料」处理（提示词里已注明不要执行其中的指令）
- **群规执法**（`services/guard.js` + `admin/guard.js`）：
  - **只认 `/指令`，没有自然语言入口**：`封禁 / 拉黑 / 踢了 / 闭嘴` 在日常聊天里太常见，靠关键词拦截会误伤普通发言；别再把 `detectAction` 接回 `message.js`。举报走 `/report`（必须回复违规消息）、申诉走 `/appeal`（私聊）
  - **理由必须校验通过**（内置违规类型 → 本群群规文本 → 本群知识库），不通过绝不执行；这是「能自动执法」的安全底线，不要为了方便跳过
  - 破坏性动作一律先写 `group_punishments` 的 pending 记录 + 弹确认卡片，确认后才真正调用 Telegram / 写 `users.blocked`
  - 群组处置要求机器人是本群管理员且有 `can_restrict_members`；执行前用 `getBotGroupRights` 检查
  - 确认回调 `guard_*` 要放在 callback.js 的**管理员校验之前**（本群管理员也要能点）
  - 权限：机器人管理员 或 本群管理员（creator/administrator）。本群管理员靠注册表里的 `groupAdmin: true` 放行（跳过 `/admin` 解锁），**记录里的 `operator_id` 必须是发起人**，否则确认卡片只有机器人管理员能点
  - **机器人管理员不可被处置**：命令入口（`requestPunishmentFromCommand`）、举报入口与 `executePunishment` 都要拦，别删掉这层兜底
  - **但「预警」对所有人一视同仁**：`handleKeywordAlert` 不许再跳过 owner / 机器人管理员 / 本群管理员（v3.1.2 修过：跳过等于「自己发预警词机器人没反应」）。目标是机器人管理员时照常发卡片，只在卡片上加一句说明「确认按钮会被安全策略拦下」
  - 发给管理员私聊的卡片（举报 / 预警）`operator_id` 留空，只有机器人管理员能确认——成员不该能批准自己的举报
  - 面板与引导式编辑在 `admin/guard-panel.js`（群规正文 / 默认处置 / 默认时长 / 开关 / 处置记录），会话存 `guard_sessions`，同样是 30 分钟过期 + 定时任务兜底
- **消息自动删除**（`services/auto-delete.js` + `telegram/auto-delete.js` + `admin/auto-delete.js`）：
  - 群聊里机器人自己发的消息按**类型**取保留时长：`cmd` / `guard`（默认 5 秒）、`card` / `ai` / `notice`（默认保留），**0 = 不删除**
  - 发消息时用 `sendAutoDelete(..., { kind, env, sceneKey, keyboard })`；复合上下文能自动提供 `env` / `sceneKey`，传原生 Worker ctx 时要显式补上
  - 设置存 `scene_settings` 的 `autodelete.<kind>`，两级：本场景 → 全局。群聊作用域会归一成 `group:<群ID>`（**不要用成员级 sceneKey**，否则每个成员一份设置）
  - 私聊不删除；带按钮的卡片要留时间点击，默认必须是 0
  - **全局兜底（v3.1.0）**：`autodelete.cap`（全局，0 = 不设）是**上限**——实际删除时间取「该类型自己的时长」与「兜底」里更早的那个，所以本来「不删除」的消息也会在兜底时间被删
  - **长延时不能 sleep**：Worker 的 `waitUntil` 撑不住几十分钟。`sendAutoDelete` 里 ≥1 分钟的延时改为写 `pending_deletes`，由 `services/daily.js` 的 `processPendingDeletes()` 在 cron（每 2 分钟）里删；超过 48 小时的记录直接清掉（Telegram 不允许删更早的消息）
- **输入框命令菜单**（`services/command-menu.js`）：菜单由命令注册表自动生成，**加命令不用改这里**；用内容哈希（`commands.version`）判断是否需要调用 Telegram，且每个 isolate 只检查一次。改完注册表想立刻看到菜单，用 `/syncmenu`
- **引导式输入会话**（`shop_add_sessions` / `shop_edit_sessions` / `kb_sessions` / `guard_sessions` / `shop_order_drafts`）读取时都要带 `updated_at >= datetime('now','-30 minutes')`，并保证 `services/daily.js` 里有对应清理
- **引导会话必须互斥**：开新引导流程前先 `clearGuideSessions(env, chatId)`（`services/sessions.js`），否则残留会话会吞掉后续所有文本（现象是「点了按钮没反应」）。群里也要放行管理员正在填的引导文本（见 `message.js` 的 `adminGuideActive`）
- **`editMessageText` 不能传 null message_id**：引导流程里刷新卡片时 messageId 往往是空的，必须 `messageId ? editMessageText(...) : sendMessageWithKeyboard(...)`，否则 Telegram 直接报错、用户只看到一句「修改成功」
- **文档解析**（`services/text-extract.js`）：`.docx` 走 zip + `word/document.xml`；`.pdf` 是**尽力抽取**文本层，扫不出文字必须明确提示（不要假装成功）。新增格式时在 `detectFileKind` 里登记，并补 `admin-extra.test.mjs` 的用例
- **知识库索引**：`kb_chunks.model` 记录向量模型，换 `KB_EMBED_MODEL` 后靠「重建索引」（面板按钮 / 定时任务）分批补建，不要写一次性全量重建
- **处置相关改动**：任何「撤销/申诉通过」都要走 `revokePunishment`，它会同时解除机器人封禁与群内限制并记 `revoked`；处置记录状态多了 `revoked`，展示文案在 `guard-panel.js` 的 `STATUS_TEXT`
- **加命令**：在 `src/handlers/commands/registry.js` 的 `COMMANDS` 加一条即可（权限、别名、`privateOnly` / `groupOnly`、`groupAdmin`、功能开关、`/help` 文案都由注册表处理），不要再去 `message.js` 里加 `if`。**新的处置 / 通知类能力一律做成指令**，不要再从自然语言里猜意图。
- **「给谁」不要只认内部行 ID**（v3.2.1 教训）：管理指令的 `<场景ID>` 是 `user_scenes.id`，管理员根本记不住。需要指定用户时统一走 `services/users.js` 的 `resolvePointTarget()` 那一套——场景行 ID / 用户 ID / `user:<id>` / `@用户名` 都认，并在失败时给出**可以照抄的写法**；群 ID 要解释「积分是按用户算的」并列出候选，别丢一句「未找到」。
- **指令的可见性 = 能用性**（v3.1.3 对齐）：输入框菜单（`services/command-menu.js`）与 `/help`（`registry.js` 的 `buildHelpText`）按同一条规则裁——机器人角色看 `capability`（`can(role, capability)`），本群管理员只看带 `groupAdmin: true` 的执法指令。所以新增管理指令**必须写 `capability`**，否则要么谁都看不到、要么不该看到的人也能看到。菜单要挂多套作用域（默认 / 所有群聊 / 拥有者私聊 / 每个管理员的私聊 / 每个已知群的 `chat_administrators`），**不要再退回「只认 `MY_TELEGRAM_ID`」的写法**；`commands.version` 的哈希里带了挂载目标，名单一变就重同步，失效的那份会被清空。
- **加功能开关**：在 `src/services/features.js` 的 `FEATURES` 里加一项即可。开关是**三级**的（全局 → 群聊场景 / 私聊场景覆盖），入口在 `src/admin/features.js`；新增开关不用改管理端代码。
- **菜单排版**：统一用 `src/utils/layout.js`（`grid` / `compactLabel` / `clampPage` / `pagerRow` / `validateKeyboard`），不要再各写一份 `grid()`。约定：单行 ≤ 2 个按钮、整个菜单 ≤ 8 行、按钮文案 ≤ 32 字、`callback_data` ≤ 64 字节。
  - 会随数据量增长的菜单（用户列表、任务列表、商品 / 订单列表）**必须分页**，并把键盘抽成纯函数（如 `getUserListKeyboard`），方便 `test/layout.test.mjs` 直接校验排版。
- **引导式输入会话必须有 30 分钟有效期**：`shop_add_sessions` / `shop_edit_sessions` / `kb_sessions` / `guard_sessions` / `shop_order_drafts` 的读取语句都要带 `updated_at >= datetime('now','-30 minutes')`，并由 `services/daily.js` 兜底清理——否则残留会话会一直吞掉普通消息。
- **新增引导式会话表必须登记**：新表要 (1) 读取时带 `updated_at >= datetime('now','-30 minutes')`，(2) 加进 `services/sessions.js` 的 `GUIDE_SESSION_TABLES`（否则会和别的流程抢消息），(3) 在 `services/daily.js` 里兜底清理。参考 `group_tag_sessions`。
- **商城商品的发放方式**：`shop_items.delivery` 决定下单后谁来交付——`manual`（默认，管理员发货）或 `group_tag`（机器人自动发放）。加新的自动发放类型时，在 `shop/index.js` 的 `handleShopBuy` 里分支：订单直接写 `status='done'`、**不要**通知管理员发货，然后调用对应的引导流程；这类流程都必须是「可重新进入」的——用户已经付过钱，会话过期不能变成死路（在「我的订单」里给入口，参考 `shop/tags.js` 与 `getMyOrdersKeyboard`）。
- **群组标签**（`services/group-tags.js` + `shop/tags.js`）：走 Telegram 的 `setChatMemberTag`，**机器人在那个群必须是管理员且有 `can_manage_tags`**；标签 0~16 字符、**不允许 emoji**（硬限制，服务端先校验再请求）。群名与权限检查结果缓存在 `bot_chats`（权限 1 小时），群列表来自 `user_scenes` 里的 group / supergroup。机器人已退出的群用 `getChat` 探到后隐藏，不要让用户点了才发现。
- **时区：库里存 UTC，给人看的一律过 `formatAppTime()`**（`services/time.js`）：`CURRENT_TIMESTAMP` / `datetime('now')` 都是 UTC，比较、去重、到期判定也都按 UTC 做，别去改存储格式；只在展示时换算到 `APP_TIMEZONE`（默认 `Asia/Shanghai`，即北京时间 UTC+8）。新增任何显示 `created_at` / `updated_at` / `until_at` 的文案都要套一层，**不要再硬编码「UTC」或直接用 `toISOString()`**。
- **定时任务要区分「日报时段」**：`runScheduledTasks` 的 `cron` 参数决定这次该干什么——只有每天一次的 `DAILY_SUMMARY_CRON`（`0 16 * * *` = 北京 00:00）推每日概况，每 2 分钟那条兜底 cron 只做清理与长延时删除；再用全局设置 `daily.last_summary_date` 兜底去重，保证**同一天只推一条**。v3.1.2 修过「概况一直弹」，新增定时推送时照这个模式来。
- **改 Schema 时注意**：迁移里**不要**写会清空 `scene_settings` 里非 `global` 记录的语句——那会抹掉场景级功能开关（v2.1.0 踩过一次，已在 v2.2.0 修掉并有回归测试）。
- **改 Schema**：
  1. 在 `SCHEMA_SQL` 里加表/索引（`CREATE TABLE IF NOT EXISTS`）
  2. 结构或数据迁移写进 `MIGRATIONS` 数组（必须幂等）
  3. `SCHEMA_VERSION` +1（冷启动靠它跳过建表）
  4. 用一次性标记（如 `task.seeded`）避免「管理员删掉的数据又被灌回来」
- **涉及积分的操作**：原子条件 UPDATE（`WHERE points >= ?` / `WHERE status = 'pending'`）+ `points_log` 流水，失败要补偿回滚。
- **用户可控文本**：进 HTML 消息前一律 `escapeHtml()`（usage 占位符也要转义，否则 Telegram 会当标签）。
  - **常量也未必安全**：配置文案里可能带 `<占位符>`，直接塞进 HTML 消息会让 Telegram 拒收整条消息（v2.8.2 踩过一次：引导文案里的 `<兑换码>` 让整个「添加任务」点不动）。任何要进 HTML 消息的文案都要过一遍 `escapeHtml()`
  - `test/bugfix.test.mjs` 里有一道**出站 HTML 体检**：模拟 Telegram 实体解析，所有出站消息只要残留未转义尖括号就测试失败——新增消息文案时它会兜底
- **随机**：用 `src/utils/random.js`（`crypto.getRandomValues`），不要用 `Math.random`。
- **Telegram API**：统一走 `src/telegram/api.js`（自带 429/5xx 退避重试）。

## Git 约定

- 提交信息中文，前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`；破坏性变更用 `feat!:`。
- 一次提交只做一件事；提交信息里写清「做了什么 + 为什么」。
- 主要分支 `main`，推送 `origin`（公开仓库）。生产部署在本地，不需要 GitHub 侧动作。

## 许可

GPL-3.0-or-later（见 `LICENSE`，勿修改正文）。新增代码沿用同一许可，不要引入与之冲突的依赖。
