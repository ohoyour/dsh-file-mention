# @ohoyo/dsh-file-mention

DeepSeek Harness 的 **@file / @dir 提及插件**（功能对齐 Codex CLI 的 `@` 提及），以 pnpm monorepo 维护，走 npm 发布路线。

输入框输入 `@文件名/目录名片段` 弹出候选列表；确认后插入 **chip 兼容的 `@扁平化路径` token**（`/`、`.` 折叠为 `-`，如 `@warning-disposal-report-index-vue`）——该形态匹配内置引用装饰扫描（输入框 lexicon 装饰 + 对话气泡形状装饰都会渲染成底色 chip）；发送后 Host 在 pre-step 边界把该 token 解析回真实路径，自动把文件内容（`<file_context>`）或目录树+小文件内容（`<dir_context>`）注入模型上下文。

> 格式演进说明：handoff 原设计插入反引号包裹路径，但实测本版本内置 UI 的反引号形态**不会**渲染 chip（输入框装饰与气泡装饰都只识别 `[/@][\w-]+` 词边界 token），因此改为扁平化 `@token` 形态。手输反引号路径（`` `src/util` ``）与手输 `@真实路径`（`@src/main.ts`）的解析仍然保留。

## 包结构

| 包 | 说明 |
| --- | --- |
| `packages/host` (`@ohoyo/dsh-file-mention-host`) | Host 插件：`fileIndex` Typert Remote 服务（工作区文件+目录索引，cwd 缓存 15s、单飞、上限 5000 条/深度 14）+ `agent/pre-step` 引用注入 |
| `packages/client` (`@ohoyo/dsh-client-ui-file-mention`) | Web 客户端插件：`@` 触发源（`name: 'file'`、`order: -1`），本地索引缓存（TTL 10s + 单飞）逐键本地过滤，候选无闪烁 |
| `packages/bundle` (`@ohoyo/dsh-file-mention`) | 发布面 bundle：`dsh.bundle.patch` 指向 `cordis.patch.yml`，同时插入 host 行与 client 行 |

## 开发

```sh
pnpm install      # 安装依赖（见下：调试期链接本地 checkout）
pnpm build        # tsdown 构建 lib/（host/client 含类型声明；client.js 为浏览器 factory bundle）
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest / node:test（host 28 用例、client 15 用例、bundle 2 用例）
```

### 调试期依赖链接

本仓库是独立 workspace；`pnpm-workspace.yaml` 中的 `overrides` 把 `@deepseek-ai/dsh-*`、
`@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-loader` 通过 `link:` 固定到本机
deepseek-harness checkout（`D:\ProgramData\deepseek-harness`，版本 `0.1.0-rc.5` —— 与本机运行时一致）。
更换机器或发布前，把 overrides 中的绝对路径改掉/删掉即可回落到各 package.json 声明的版本区间。

## 安装（profile bundle）

发布后（`pnpm publish`，`pnpm publish` 会自动把 `workspace:^` 改写为具体版本号）：

1. 在目标 profile 目录（如 `C:\Users\<user>\.dsh\profiles\web`）的 `package.json` 中：
   - `dependencies` 增加 `"@ohoyo/dsh-file-mention": "<version>"`；
   - `dsh.profile.bundles` 数组追加 `"@ohoyo/dsh-file-mention"`。
2. `pnpm install`，重启 `dsh web`（进程重启后组合重新装配）。

未发布时可用本地路径安装：`dependencies` 中写
`"@ohoyo/dsh-file-mention": "link:<仓库>/packages/bundle"`（同时 link 另外两个包），其余步骤相同。

## 验证清单（对应 handoff Prompt 4）

1. 重启 DSH 进程后插件仍在（组合行存在、无 loading 错误）。
2. 输入 `@warning` → 候选平滑出现（文件 `📄` + 目录 `📁/`），逐键输入无闪烁。
3. Enter 选文件 → 输入框插入带底色的 chip `@warning-disposal-report-index-vue`；
   选目录 → chip `@warning-disposal-report`；对话气泡中同一 token 同样渲染为底色 chip。
4. 发送文件引用 → 模型上下文出现 `<file_context>`。
5. 发送目录引用 → 上下文出现 `<dir_context>`，二进制/超大文件被跳过并在统计中体现。
6. `@不存在的路径`、普通反引号文本（如 `` `false` ``）不注入、不报错。
7. `@<动态插件id>`（形如 `abc-123`）不被劫持。
8. 与既有 `@subagent` 源共存：两个分组都出现在菜单中。

## 已知限制

- 路径含空格的引用不支持（token 以空白分隔）。
- 提及 token 为扁平化形态（`/`、`.` → `-`）；chip 文案显示该 token 本身（内置装饰的固定行为）。
- 两个不同路径折叠为同一 token 时（如 `a/b.md` 与 `a-b.md`）无法区分：匹配 >1 则跳过注入（防误注入）。
- 形如 `abc-123` 的 token 按动态插件 id 规则跳过，因此折叠后恰好形如 `<3-6字母>-<数字>` 的路径无法被提及（罕见）。
- 菜单分组标题固定显示 `file`（`slash.menu` 语言包由 ui-input-trigger 独占注册，第三方无法本地化）。
- 同短名后缀匹配上限 2 条，超过则跳过注入（防误注入）。
- 索引跳过 `node_modules`/`.git`/`dist` 等目录；上限 5000 条（文件+目录）。
- @dir 快照有预算：树深 3 / 200 行；仅 ≤32KB 的文本文件附内容（前 24,000 字符，最多 8 个）；二进制文件跳过。
- 每回合最多注入 5 个引用，同回合按路径去重。

## License

MIT
