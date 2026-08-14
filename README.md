# @ohoyo/dsh-file-mention

DeepSeek Harness 的 **@file / @dir 提及插件**（功能对齐 Codex CLI 的 `@` 提及），以 pnpm monorepo 维护，走 npm 发布路线。

输入框输入 `@文件名/目录名片段` 弹出候选列表；确认后：

- **输入框**插入带底色的 **chip，文案为真实路径**（保留 `/` 与 `.`）：文件 `📄 warning-disposal-report/index.vue`、目录 `📁 warning-disposal-report/`；
- **发送时**由 codec 序列化为 chip 兼容的模型文本 `@<最短无歧义后缀>`（`/`、`.` 折叠为 `-`，如 `@warning-disposal-report-index-vue`），对话气泡按形状渲染为底色 chip；
- **Host** 在 pre-step 边界把该 token 按“唯一后缀匹配”解析回真实路径，自动把文件内容（`<file_context>`）或目录树+小文件内容（`<dir_context>`）注入模型上下文。

> **为什么对话气泡里的 token 不能带 `/`？** 气泡与输入框的引用装饰是内置 UI 的固定扫描（`ui-conversation` 的 `projectUserText` / `decorations.ts`），只接受 `[/@][\w-]+`（字母数字下划线连字符）的词边界 token——`/`、`.` 不在字符集内，任何含它们的文本都不会被渲染成 chip。输入框的 **occurrence chip**（本插件使用的插入路径）则支持任意文案，因此输入框显示真实路径、气泡显示折叠 token。若需要气泡也显示真实路径，必须用不同优先级注册 `conversation.chat.node` 的 `user` 键来替换内置气泡渲染器（可行但需重实现整个气泡组件，暂未启用）。

## 包结构

| 包 | 说明 |
| --- | --- |
| `packages/host` (`@ohoyo/dsh-file-mention-host`) | Host 插件：`fileIndex` Typert Remote 服务（工作区文件+目录索引，cwd 缓存 15s、单飞、上限 5000 条/深度 14）+ `agent/pre-step` 引用注入 |
| `packages/client` (`@ohoyo/dsh-client-ui-file-mention`) | Web 客户端插件：`@` 触发源（`name: 'file'`、`order: -1`），本地索引缓存（TTL 10s + 单飞）逐键本地过滤，候选无闪烁；occurrence chip 插入 + lexicon 装饰 |
| `packages/bundle` (`@ohoyo/dsh-file-mention`) | 发布面 bundle：`dsh.bundle.patch` 指向 `cordis.patch.yml`，同时插入 host 行与 client 行 |

## 开发

```sh
pnpm install        # 从 npm registry 解析 @deepseek-ai/dsh-*（rc.6 系）
pnpm build          # tsdown 构建 lib/（host/client 含类型声明；client.js 为浏览器 factory bundle）
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest / node:test（host 31 用例、client 18 用例、bundle 2 用例）
pnpm smoke          # 构建产物冒烟（built client.js + cordis Context 驱动）
```

### 可选：链接本地 deepseek-harness checkout

默认从 registry 解析依赖。若要针对本地 checkout（如 `0.1.0-rc.5`）调试：

```sh
pnpm link:checkout            # = node scripts/link-local-checkout.mjs [checkout 路径]
pnpm install
```

该脚本在 `pnpm-workspace.yaml` 中生成（或覆盖）`overrides` 块，把 `@deepseek-ai/*`
以 `link:` 固定到 checkout；删除该块即回落到 registry 版本。仓库不提交 lockfile，
所以本机链接不会污染他人安装。

## 发布（GitHub + npm）

1. 把仓库推到 GitHub（例如 `github.com/<you>/dsh-file-mention`）。
2. 在仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npmjs.org 的 automation token）。
3. 推送版本标签触发发布：`git tag v0.1.0 && git push origin v0.1.0`。
   - `.github/workflows/publish.yml` 会 build 后按依赖序发布三包（host → client → bundle；bundle 的 `workspace:^` 自动改写为具体版本），发布到 `https://registry.npmjs.org`（见各包 `publishConfig.registry`）。
   - 每次 push / PR 会跑 `.github/workflows/ci.yml`（build + typecheck + test + smoke）。
4. 发布后即可按下方“使用者安装”步骤安装。

> 首次发布前请确认三包版本号、`repository` 字段（可选）与 README 链接。

## 使用者安装（profile bundle）

**前置**：目标机为 DeepSeek Harness（Web 界面）部署，版本 ≥ 0.1.0-rc.5 系。

```sh
# 在目标 profile 目录（如 C:\Users\<user>\.dsh\profiles\web）：
pnpm add @ohoyo/dsh-file-mention
```

然后在 profile 的 `package.json` 中确认/添加：

```jsonc
{
  "dependencies": {
    "@ohoyo/dsh-file-mention": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@ohoyo/dsh-file-mention"]
    }
  }
}
```

重启 `dsh web`（进程重启后组合重新装配），刷新页面即可。

**不发布 npm 的替代**（git 安装）：clone 本仓库后，把三个包以本地路径加入 profile：

```jsonc
{
  "dependencies": {
    "@ohoyo/dsh-file-mention": "link:<仓库>/packages/bundle",
    "@ohoyo/dsh-file-mention-host": "link:<仓库>/packages/host",
    "@ohoyo/dsh-client-ui-file-mention": "link:<仓库>/packages/client"
  }
}
```

其余步骤相同（`dsh.profile.bundles` 追加 + `pnpm install` + 重启）。

## 验证清单（对应 handoff Prompt 4）

1. 重启 DSH 进程后插件仍在（组合行存在、无 loading 错误）。
2. 输入 `@warning` → 候选平滑出现（文件 `📄` + 目录 `📁/`），逐键输入无闪烁。
3. Enter 选文件 → 输入框出现真实路径 chip `📄 warning-disposal-report/index.vue`；
   选目录 → `📁 warning-disposal-report/`；发送后对话气泡显示折叠 token chip
   `@warning-disposal-report-index-vue` / `@warning-disposal-report`。
4. 发送文件引用 → 模型上下文出现 `<file_context>`。
5. 发送目录引用 → 上下文出现 `<dir_context>`，二进制/超大文件被跳过并在统计中体现。
6. `@不存在的路径`、普通反引号文本（如 `` `false` ``）不注入、不报错。
7. `@<动态插件id>`（形如 `abc-123`）不被劫持。
8. 与既有 `@subagent` 源共存：两个分组都出现在菜单中。

## 已知限制

- 路径含空格的引用不支持（token 以空白分隔）。
- 对话气泡的 chip 文案是折叠 token（`/`、`.` → `-`）；输入框 chip 显示真实路径（见开头说明）。
- 两个不同路径折叠为同一 token 时（如 `a/b.md` 与 `a-b.md`）无法区分：匹配 >1 则跳过注入（防误注入）。
- 形如 `abc-123` 的 token 按动态插件 id 规则跳过，因此折叠后恰好形如 `<3-6字母>-<数字>` 的路径无法被提及（罕见）。
- 菜单分组标题固定显示 `file`（`slash.menu` 语言包由 ui-input-trigger 独占注册，第三方无法本地化）。
- 同短名后缀匹配上限 2 条，超过则跳过注入（防误注入）。
- 索引跳过 `node_modules`/`.git`/`dist` 等目录；上限 5000 条（文件+目录）。
- @dir 快照有预算：树深 3 / 200 行；仅 ≤32KB 的文本文件附内容（前 24,000 字符，最多 8 个）；二进制文件跳过。
- 每回合最多注入 5 个引用，同回合按路径去重。

## License

MIT
