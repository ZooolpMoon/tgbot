# 🛠️ 开发与测试

[返回首页](../README.md) · [文档索引](README.md)

## npm 脚本

```bash
npm run dev            # 本地预览（读取 .dev.vars）
npm run deploy         # 部署（wrangler.toml）
npm run deploy:prod    # 部署（wrangler.production.toml）
npm run tail           # 实时看线上日志
npm run check          # 语法 + 相对 import 路径自检
npm test               # 256 个测试用例
npm run backup         # 导出线上 D1 到 backups/
npm run backup:local   # 导出本地 D1
npm run backup:config  # 把生产配置备份到私有仓库（需 .config-backup）
```

`npm run check` 做三件事：所有 `.js` / `.mjs` 语法检查、相对 import 路径是否存在、扫描 `src` `scripts` `test` `test-helpers` 四个目录。

## 测试

测试用 Node 内置的 `node:test`，配合 `test-helpers/d1.mjs`（基于 `node:sqlite` 的 D1 替身）**跑真实 SQL**，而不是把数据库 mock 掉——所以 SQL 写错、约束冲突这类问题在本地就能暴露。

覆盖范围：

| 文件 | 覆盖内容 |
|------|---------|
| `checkin.test.mjs` | 连续签到天数计算、递增奖励与里程碑 |
| `points.test.mjs` | 原子扣分、退款、流水 |
| `daily.test.mjs` | 定时任务清理与日报汇总 |
| `time.test.mjs` | 时区换算：库里存 UTC、展示按 `APP_TIMEZONE`（默认北京时间） |
| `command-menu.test.mjs` | 输入框菜单：按身份裁剪、多作用域挂载与失效清理、哈希版本比对 |
| `group-tags.test.mjs` | 商城「自定义群组标签」：下单即完成、选群、标签校验、权限兜底、重新进入 |
| `features.test.mjs` | 三级功能开关（全局 / 场景覆盖 / 恢复默认） |
| `auto-delete.test.mjs` | 消息自动删除：类型默认值、两级设置、按类型取时长、面板读写 |
| `bugfix.test.mjs` | 缺陷回归：管理员不可被封禁、引导会话互斥、HTML 转义、二次确认、出站消息 HTML 体检 |
| `admins.test.mjs` | 角色与能力矩阵、命令 / 回调权限拦截、引导式加管理员、菜单与 /help 裁剪 |
| `points-play.test.mjs` | 积分转账（成功与各种失败路径）与每日抽奖（免费限一次、付费扣分、奖池期望值） |
| `ai-tools.test.mjs` | AI 工具解析、只读工具执行、一轮工具调用闭环、开关关闭时不注入工具说明 |
| `history.test.mjs` | AI 上下文裁剪与预算 |
| `redeem.test.mjs` | 兑换码生成、兑换、次数与过期 |
| `shop.test.mjs` | 订单取消退款、库存回滚、下单备注 |
| `schema.test.mjs` | 建表、迁移、Schema 版本跳过逻辑 |
| `registry.test.mjs` | 命令表自洽性、权限标记、`/help` 生成 |
| `layout.test.mjs` | 所有菜单的排版约束（两列、行数、文案与 `callback_data` 长度） |
| `flows.test.mjs` | 入口链路集成（消息 → 指令 → AI → 回调） |
| `knowledge.test.mjs` | 分块、向量编解码、检索与降级、docx/pdf 解析、文件上传 |
| `guard.test.mjs` / `guard-extra.test.mjs` | 指令处置链路、理由校验、确认与执行、举报、申诉、预警、撤销、到期通知、群规版本，以及「自然语言不再触发处置」回归 |
| `admin-extra.test.mjs` | 用户详情、日志筛选、索引重建、文档范围调整 |
| `regression.test.mjs` | 历史缺陷回归（会话过期、群聊阻塞、签到回滚、积分夹断…） |

```bash
npm run check && npm test     # 提交前建议跑这一组
```

> 测试依赖 Node 22.5+ 的 `node:sqlite`；低版本会自动跳过依赖它的用例。

## 代码约定

- **ESM + 显式扩展名**：`import { x } from "./y.js"`（Node 与 Wrangler 都要求）
- 注释与用户可见文案使用中文
- 涉及积分的操作必须「原子条件 UPDATE + 流水 + 失败回滚」
- 用户可控文本进 HTML 消息前必须 `escapeHtml()`
- 随机数统一用 `src/utils/random.js`（`crypto.getRandomValues`）
- 新的引导式会话必须有 30 分钟有效期，并在 `src/services/daily.js` 里加兜底清理
- 新增菜单必须满足排版约定（单行 ≤ 2 个按钮、整菜单 ≤ 8 行、按钮文案 ≤ 32 字、`callback_data` ≤ 64 字节）

## 扩展指南

### 加一个命令

只改 `src/handlers/commands/registry.js`：

```js
{
  name: "/mytool", aliases: ["/tool"], scope: "admin",
  desc: "我的新功能", usage: "/mytool <参数>", feature: "shop", privateOnly: true,
  handle: cmdMyTool
}
```

注册表会自动处理：管理员权限与解锁校验、仅私聊拦截、功能开关判定、`/help` 文案、输入框命令菜单。**不要再往 `message.js` 里加 `if`。**

字段含义：

| 字段 | 作用 |
|------|------|
| `name` / `aliases` | 命令名（含 `/`）与别名 |
| `scope: "admin"` | 需要是管理员，且默认需要先 `/admin` 解锁（`needsUnlock: false` 可跳过解锁） |
| `groupAdmin: true` | 群里额外放行本群管理员（creator / administrator），他们不需要 `/admin` 解锁 |
| `privateOnly: true` | 群里使用会被拦下并提示（`privateHint` 可自定义提示文案） |
| `groupOnly: true` | 私聊里使用会被拦下并提示（`groupHint` 可自定义提示文案） |
| `feature: "<key>"` | 受功能开关控制（key 来自 `services/features.js` 的 `FEATURES`） |
| `usage` | 会在 `/help` 里追加参数说明（尖括号会被自动转义） |
| `handle(ctx)` | 处理函数，参数是消息链路里的复合上下文（env / token / chatId / userKey / sceneKey / uctx …） |

### 加一个功能开关

在 `src/services/features.js` 的 `FEATURES` 加一项：

```js
{ key: "mytool", label: "我的功能", desc: "一句话说明它控制什么" }
```

管理端的三级开关 UI 会自动出现，不需要改管理端代码。业务里用 `isFeatureEnabled(env, sceneKey, "mytool")` 判断即可。

### 加一类可配置自动删除的消息

在 `src/services/auto-delete.js` 的 `AUTO_DELETE_KINDS` 加一项（`key` / `label` / `icon` / `desc` / `defaultSec`），
管理面板会自动多出一个类型按钮；发消息时带上类型即可：

```js
await sendAutoDelete(token, chatId, text, "HTML", isGroupCtx, ctx, {
  kind: "mytool", env, sceneKey, keyboard
});
```

复合上下文（`handle(ctx)` 收到的那个）能自动提供 `env` / `sceneKey`；只有原生 Worker ctx 时才需要显式补。
**默认值必须与既有行为一致**（该删的仍删、该留的仍留），否则升级后会突然少消息。

### 加一个游戏

1. 在 `src/games/` 新建模块（参考 `dice.js`），导出 `renderMain(...)` 与 `play(...)`
2. 在 `src/games/index.js` 的 `GAME_REGISTRY` 注册
3. 游戏大厅的按钮加一项

回调前缀统一用 `game_`，路由与功能开关判定都已经被通用层处理。

### 加一种知识库文件格式

在 `src/services/text-extract.js` 的 `detectFileKind` 登记扩展名，并实现对应的解析函数（返回 `{ ok, text, kind }`）。上传入口会自动使用它。

### 换个向量方案（更大规模）

把 `src/services/knowledge.js` 的 `searchKnowledge` 换成 Cloudflare Vectorize 查询即可：入库存向量、检索查向量库，其余调用方（AI 对话、执法理由校验）无需改动。

### 改默认数值

积分、额度、签到奖励、知识库阈值、群发批量等集中在 `src/config/constants.js`；单个用户 / 单个群的配置走管理后台，不用改代码。
