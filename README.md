# @ohoyo/dsh-file-mention

DeepSeek Harness 的 **@file / @dir 提及插件**（功能对齐 Codex CLI 的 `@` 提及），以 pnpm monorepo 维护，走 npm 发布路线。

输入框输入 `@文件名/目录名片段` 弹出候选列表；确认后插入 **chip 兼容的 `@最短无歧义后缀` token**（文件 = `父目录段/名字`、目录 = `名字`；`/`、`.` 折叠为 `-`；与其他行折叠冲突时自动向上补路径段直至唯一，如 `@warning-disposal-report-index-vue` / `@warning-disposal-report`）——该形态匹配内置引用装饰扫描（输入框 lexicon 装饰 + 对话气泡形状装饰都会渲染成底色 chip，且**完整可见、不被截断**）；发送后 Host 在 pre-step 边界把该 token 按“唯一后缀匹配”解析回真实路径，自动把文件内容（`<file_context>`）或目录树+小文件内容（`<dir_context>`）注入模型上下文。

> **为什么不用带 `/` 的真实路径？** 两处内置装饰（气泡的 `projectUserText` 与输入框的 lexicon 扫描）都只接受 `[/@][\w-]+` 字符集，含 `/`、`.` 的文本不会被渲染成 chip；而输入框的 occurrence chip 虽支持任意文案，其显示单元却是固定 ~4em 的占位符单元格、长文案会被居中裁切加省略号（内置 `InputBar.module.css` 的 `.chipLabel` 固定设计，短名字如 skill/subagent 才适用），长路径同样显示不全。因此采用 text 路径：chip 画在真实文字上、宽度随文本、永不截断，代价是分隔符折叠为 `-`。手输反引号路径（`` `src/util` ``）与手输 `@真实路径`（`@src/main.ts`）的解析仍然保留。

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
3. Enter 选文件 → 输入框出现完整可见的 chip `@warning-disposal-report-index-vue`；
   选目录 → `@warning-disposal-report`；发送后对话气泡显示同一 token chip。
4. 发送文件引用 → 模型上下文出现 `<file_context>`。
5. 发送目录引用 → 上下文出现 `<dir_context>`，二进制/超大文件被跳过并在统计中体现。
6. `@不存在的路径`、普通反引号文本（如 `` `false` ``）不注入、不报错。
7. `@<动态插件id>`（形如 `abc-123`）不被劫持。
8. 与既有 `@subagent` 源共存：两个分组都出现在菜单中。

## 已知限制

- 路径含空格的引用不支持（token 以空白分隔）。
- 提及 token 为折叠形态（`/`、`.` → `-`），取最短无歧义后缀（文件取父目录段+名字、目录取名字，冲突时向上补段）；完整可见、不被截断（见开头说明）。
- 两个不同路径折叠为同一 token 时（如 `a/b.md` 与 `a-b.md`）无法区分：匹配 >1 则跳过注入（防误注入）。
- 形如 `abc-123` 的 token 按动态插件 id 规则跳过，因此折叠后恰好形如 `<3-6字母>-<数字>` 的路径无法被提及（罕见）。
- 菜单分组标题固定显示 `file`（`slash.menu` 语言包由 ui-input-trigger 独占注册，第三方无法本地化）。
- 同短名后缀匹配上限 2 条，超过则跳过注入（防误注入）。
- 索引跳过 `node_modules`/`.git`/`dist` 等目录；上限 5000 条（文件+目录）。
- @dir 快照有预算：树深 3 / 200 行；仅 ≤32KB 的文本文件附内容（前 24,000 字符，最多 8 个）；二进制文件跳过。
- 每回合最多注入 5 个引用，同回合按路径去重。

## License

MIT
