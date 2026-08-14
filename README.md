# @ohoyo/dsh-file-mention

DeepSeek Harness 的 **@file / @dir 提及插件**（功能对齐 Codex CLI 的 `@` 提及），以 pnpm monorepo 维护，走 npm 发布路线。

输入框输入 `@文件名/目录名片段` 弹出候选列表；确认后插入 Harness 原生的结构化引用 chip，内部保存准确的工作区相对路径，发送时由 codec 序列化为可读的 `@{精确路径}`。因此路径含空格、标点、同名文件和目录折叠冲突都能保持准确引用；Host 在 pre-step 边界解析结构化路径，并注入文件内容（`<file_context>`）或目录树+小文件内容（`<dir_context>`）到模型上下文。手输的旧式 `@路径` 和反引号路径仍保留兼容解析。

> 结构化引用依赖 Harness 当前的 `ReferenceInsert` / `ReferenceCodec` 接口。`@{...}` 是发送给 Host 的协议文本，不是用户必须手写的语法；复制或粘贴引用时也使用同一格式。旧式纯文本 token 仅作为兼容入口保留。

## 包结构

| 包 | 说明 |
| --- | --- |
| `packages/host` (`@ohoyo/dsh-file-mention-host`) | Host 插件：`fileIndex` Typert Remote 服务（工作区文件+目录索引，cwd 默认缓存 15s、单飞、上限 5000 条/深度 14）+ `agent/pre-step` 引用注入 |
| `packages/client` (`@ohoyo/dsh-client-ui-file-mention`) | Web 客户端插件：`@` 触发源（`name: 'file'`、`order: -1`），按 Host 配置 TTL 的本地索引缓存 + 单飞逐键本地过滤，候选无闪烁；结构化 occurrence chip + 旧式 lexicon 兼容 |
| `packages/bundle` (`@ohoyo/dsh-file-mention`) | 发布面 bundle：`dsh.bundle.patch` 指向 `cordis.patch.yml`，同时插入 host 行与 client 行 |

## 开发

```sh
pnpm install --frozen-lockfile  # 从 lockfile 安装 registry 依赖
pnpm build          # tsdown 构建 lib/（host/client 含类型声明；client.js 为浏览器 factory bundle）
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest / node:test（Host + Client 60 用例、bundle 2 用例）
pnpm smoke          # 构建产物冒烟（built client.js + cordis Context 驱动）
pnpm pack:local     # 生成可在仓库外 profile 安装的三个 tarball
```

### 可选：链接本地 deepseek-harness checkout

默认从 registry 解析依赖。若要针对本地 checkout（如 `0.1.0-rc.5`）调试：

```sh
pnpm link:checkout -- <deepseek-harness checkout 路径>
pnpm install
```

该脚本只在本机的 `pnpm-workspace.yaml` 中生成（或覆盖）`overrides` 块，把
`@deepseek-ai/*` 以 `link:` 固定到 checkout；该文件中的本机 overrides 不应提交。
执行 `pnpm unlink:checkout` 可删除该块并回落到 registry 版本。默认 registry lockfile 已提交；本机链接后
lockfile 可能暂时出现本机路径，解除链接并重新安装即可恢复。

## 发布（GitHub + npm）

1. 把仓库推到 GitHub（例如 `github.com/<you>/dsh-file-mention`）。
2. 在仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`（npmjs.org 的 automation token）。
3. 推送版本标签触发发布：`git tag v0.1.0 && git push origin v0.1.0`。
   - 三个 package 的版本必须与 tag 一致；`.github/workflows/publish.yml` 会 frozen install、类型检查、测试、冒烟和打包校验后，按依赖序发布三包（host → client → bundle；bundle 的 `workspace:^` 自动改写为具体版本），发布到 `https://registry.npmjs.org`（见各包 `publishConfig.registry`）。
   - 每次 push / PR 会跑 `.github/workflows/ci.yml`（build + typecheck + test + smoke）。
4. 发布后即可按下方“使用者安装”步骤安装。

> 首次发布前请确认三包版本号、`repository` 字段（可选）与 README 链接。

## 使用者安装（profile bundle）

**前置**：目标机为 DeepSeek Harness（Web 界面）部署，版本 ≥ 0.1.0-rc.5 系。

```sh
# 由 dsh CLI 初始化/维护 profile manifest，并安装 bundle：
dsh plugin --profile web add @ohoyo/dsh-file-mention
```

重启 `dsh web`（进程重启后组合重新装配），刷新页面即可。

**本地 checkout 调试**：这是源码工作流，不是免构建的 GitHub 安装。先构建并打包；`pnpm pack:local`
会将 bundle 的 `workspace:^` 依赖改写为可在仓库外解析的具体版本，并生成三个 tarball：

```sh
git clone <仓库> dsh-file-mention
cd dsh-file-mention
pnpm install
pnpm build
pnpm pack:local
```

在 profile 的 `package.json` 中添加本地依赖，并由 `dsh.profile.bundles` 列出 bundle：

```jsonc
{
  "dependencies": {
    "@ohoyo/dsh-file-mention": "file:<仓库>/.local-pack/ohoyo-dsh-file-mention-0.1.0.tgz",
    "@ohoyo/dsh-file-mention-host": "file:<仓库>/.local-pack/ohoyo-dsh-file-mention-host-0.1.0.tgz",
    "@ohoyo/dsh-client-ui-file-mention": "file:<仓库>/.local-pack/ohoyo-dsh-client-ui-file-mention-0.1.0.tgz"
  }
}
```

然后在 profile 目录执行 `pnpm install`，重启 `dsh web`。

源码安装依赖构建产物；如果希望不执行构建，使用 npm 发布包或 `pnpm pack` 生成的 tarball。

## 验证清单（对应 handoff Prompt 4）

1. 重启 DSH 进程后插件仍在（组合行存在、无 loading 错误）。
2. 输入 `@warning` → 候选平滑出现（文件 `📄` + 目录 `📁/`），逐键输入无闪烁。
3. Enter 选文件或目录 → 输入框出现带准确路径身份的 chip；发送后对话气泡显示对应引用。
4. 发送文件引用 → 模型上下文出现 `<file_context>`。
5. 发送目录引用 → 上下文出现 `<dir_context>`，二进制/超大文件被跳过并在统计中体现。
6. `@不存在的路径`、普通反引号文本（如 `` `false` ``）不注入、不报错。
7. `@<动态插件id>`（形如 `abc-123`）不被劫持。
8. 与既有 `@subagent` 源共存：两个分组都出现在菜单中。

## 已知限制

- 手输旧式 `@路径` 仍受空白分隔、扁平化碰撞和动态插件 ID 兼容规则影响；菜单选择的结构化引用不受这些限制。
- 菜单分组标题固定显示 `file`（`slash.menu` 语言包由 ui-input-trigger 独占注册，第三方无法本地化）。
- 同短名后缀匹配上限 2 条，超过则跳过注入（防误注入）。
- 索引跳过 `node_modules`/`.git`/`dist` 等目录；上限 5000 条（文件+目录）。
- 超过索引上限时 Host 会返回 `complete: false`，客户端对未命中的查询回退到
  Host 端检索；已完成索引仍走本地过滤，避免逐键 RPC 和菜单闪烁。写入/编辑文件后
  Host 会失效索引缓存。不完整索引的非空查询会在配置的工作区深度内做元数据检索，
  不会被前 5000 条索引行限制；同一工作区的多个 query 会共享搜索目录缓存，默认
  上限为 100,000 行、4 个 workspace。
- @dir 快照有预算：树深 3 / 200 行；仅 ≤32KB 的文本文件附内容（前 24,000 字符，最多 8 个）；二进制文件跳过。
- 每回合最多注入 5 个引用，同回合按路径去重；默认总上下文预算为 12,000 个估算 token，可通过 `maxContextTokens` 调整。
- 不完整索引模式下，Client 对 query 做 50ms 可取消防抖；快速输入被替代的 query 不会发起远程检索。
- 候选菜单默认钳制在 `min(260px,100%)` / `max(537px,100%)`（内置 MenuView 设计）；本插件仅对包含 `file` 分组的菜单注入 CSS，将宽度强制为输入卡片宽度（随插件卸载自动移除）。

## License

MIT
