# @文件/目录 引用插件（file-mention）任务规划与实现提示词

> 本手册用于在**独立仓库**中维护该插件并走 npm 发布路线。所有接口事实均已在
> deepseek-harness 运行实例中实测/逆向确认（2026-08，版本 0.1.0-rc.5 系），
> 并附有参考实现文件路径。提示词章节可直接整段投喂给 AI 编程助手。
>
> 功能对齐对象：**Codex CLI 的 @ 提及**（@file / @dir）。

---

## 0. 功能定义（验收基线）

与 Claude Code / Codex 的 @ 提及一致，覆盖**文件**与**目录**两类引用：

1. 输入框输入 `@文件名/目录名片段`，弹出候选列表（文件名/目录名 + 所在目录，
   `↑↓` 选择，**Enter** 确认，鼠标点击亦可）。
   - 文件：`📄` 图标；目录：`📁` 图标、名称带 `/` 后缀（Codex 惯例）。
2. 确认后输入框插入 Harness 原生结构化引用 chip，引用内部保存准确的工作区相对路径，
   发送时通过 `ReferenceCodec` 序列化为 `@{精确路径}`。旧式纯文本 token 仅作为手输兼容入口；
   目录 chip 的显示标签继续追加 `/`。
3. 发送后，模型上下文自动附带引用内容：
   - **@file** → 该文件完整内容（注入为上下文消息，含完整相对路径）；
   - **@dir** → 该目录的**递归树快照 + 目录内（小）文件内容**（对齐 Codex 的目录提及，
     带预算上限，见下）。
4. 对话区展示与输入框同一引用；Host 在 pre-step 边界解析序列化后的结构化路径并注入上下文。
5. 候选列表**不得闪烁**：索引到客户端本地缓存后本地过滤，击键不发起逐键 RPC。

---

## 1. 任务规划（里程碑）

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 | 建仓脚手架：pnpm monorepo + tsdown 构建 + `dsh` 元数据字段 | 两个包可 `pnpm build` 出 `lib/` 与类型声明 |
| M1 | Host 插件包：索引 Remote 服务（**文件+目录**）+ pre-step 注入（**@file 内容 / @dir 树+内容**） | 单测：`list` 返回含目录的索引；pre-step 对 `@path`/`` `short` ``/`` `short/` `` 正确注入并落盘 |
| M2 | Web 客户端插件包：`@` 触发源（本地索引缓存 + 候选过滤 + 结构化引用插入） | 浏览器测试：候选平滑无闪烁；选中文件/目录后保留准确 `ref` 与可见 label |
| M3 | 发布 Bundle 包 + 组合行（host 行 + dsh.client 行） | `pnpm publish` 成功；目标机 profile 加 bundle 后 `dsh web` 重启可见 |
| M4 | 安装与回归 | 重启 DSH 进程后插件仍在（永久性验证）；新会话可用 |

**风险提示**
- Remote 命名空间（typert）是整套机制里最深的环节，M1 优先做最小 `list` 方法打通链路再补 pre-step。
- 客户端 source 名 `file` 不可与其他 `@` source 重名（现有 `subagent`）；注册重复会抛错。
- 菜单分组标题只能显示 source 原始名（`file`）：`slash.menu` 语言包由
  `ui-input-trigger` 独占注册（同名同 locale 二次注册抛错），第三方无法本地化。
- 目录/文件歧义用**尾随 `/` 约定**解决：候选里目录名带 `/`，插入文本保留 `/`；
  Host 按"有 `/` 只匹配目录、无 `/` 优先文件"解析。

---

## 2. 仓库结构建议

```
file-mention/
├─ package.json            # private workspace root
├─ pnpm-workspace.yaml     # packages: ['packages/*']
├─ packages/
│  ├─ host/                # @ohoyo/dsh-file-mention-host
│  │  ├─ package.json
│  │  ├─ tsdown.config.ts
│  │  └─ src/index.ts      # 服务 + pre-step 监听
│  ├─ client/              # @ohoyo/dsh-client-ui-file-mention
│  │  ├─ package.json      # 含 dsh.client 元数据
│  │  ├─ tsdown.config.ts
│  │  └─ src/index.ts      # 浏览器半（@ source）
│  └─ bundle/              # @ohoyo/dsh-file-mention（发布面）
│     ├─ package.json      # dsh.bundle.patch = ./cordis.patch.yml
│     └─ cordis.patch.yml  # 同时插入 host 行与 client 行
```

---

## 3. 实现提示词

### Prompt 0 — 脚手架（M0）

> 你是 deepseek-harness 生态插件开发者。请在空仓库按下面要求搭建 monorepo 脚手架。
>
> 1. pnpm workspace，包名：`@ohoyo/dsh-file-mention-host`（host 目录）、
>    `@ohoyo/dsh-client-ui-file-mention`（client 目录）、`@ohoyo/dsh-file-mention`
>    （bundle 目录）。
> 2. 全部包 `"type": "module"`，用 tsdown 构建（`"bundle": "tsdown"`，
>    `"watch": "tsdown --watch"`），产物 `lib/index.js` + `lib/types/*.d.ts`，
>    exports 含 `.` 与 `./package.json`；client 包额外导出 `./client` →
>    `lib/client.js`；bundle 包额外导出 `./cordis.patch.yml`。
> 3. peerDependencies 固定 `@deepseek-ai/cordis` 与 `@deepseek-ai/cordis-plugin-loader`；
>    devDependencies 用 `workspace:^` 链接到本地 checkout 里的同包名版本（调试期）。
> 4. 参照 `packages/client/ui-skill/package.json` 的 `"dsh"` 字段为 client 包写
>    `"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime",
>    "@deepseek-ai/dsh-client-ui-input-trigger", "@deepseek-ai/dsh-api-remotes"],
>    "platform": "web" } }`。
> 5. bundle 包 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，文件先为空数组。
> 6. 每个包配 `publishConfig.access`（私有源则按源的规范），LICENSE、README 占位。

### Prompt 1 — Host 插件包（M1）

> 在 `packages/host/src/index.ts` 实现 host 插件，导出 `name`、`inject`、`apply`。
> 参考实现：
> - `packages/context/time-context/src/index.ts`（pre-step 注入范式）
> - `packages/extensions/cordis-host-runner/src/index.ts`（TypertRemoteService 范式）
> - `packages/llm/llm/src/message.ts`（`createUserMessage`）
>
> **A. 索引 Remote 服务（命名空间 `fileIndex`）**
> - `export class FileIndexService extends TypertRemoteService`，
>   `constructor(ctx, config) { super(ctx, 'fileIndex') }`，`static inject = ['fs']`，并将
>   `static Config` 指向同名 Schemastery schema；
>   `import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'`。
> - 方法 `@Remote('list') list(agent: Agent, request: { query?: string }): Promise<{ files: readonly IndexRow[], complete: boolean, cacheTtlMs: number }>`
>   —— 第一个参数必须是 `agent: Agent`（typert 会把客户端传来的 agentId 解析为活体 Agent，
>   参考 `DynamicCordisRunnerService` 的 Remote 方法）。
> - 从 `agent.session.header.cwd` 读工作区绝对路径（`SessionHeader.cwd`，可能为 undefined）。
> - 递归建立索引：BFS + `ctx.fs.listDir(target)`；跳过目录集合
>   `node_modules,.git,dist,build,out,coverage,target,.next,.nuxt,.output,.nitro,
>   .cache,.turbo,.idea,.vscode,vendor,__pycache__,.venv,venv,logs,tmp,temp,.svn,
>   .hg,obj,.pytest_cache,.mypy_cache`；上限 5000 条、深度 14；**文件与目录都收录**。
> - 每条 `{ type: 'file' | 'directory', path: 相对路径(正斜杠), name: 名字, dir: 父目录相对路径 }`。
> - 索引按 cwd 缓存，默认 TTL 15s（由 `Config.indexTtlMs` 配置），单飞（in-flight 去重）。
> - 当快照因 `indexLimit` 不完整时，非空 query 共享按 cwd 构建的元数据搜索目录，
>   目录受 `searchIndexLimit`（默认 100000 行）与 `searchCacheEntries`（默认 4 个 workspace）限制；
>   超限或遍历失败返回 `complete: false`。
> - `list` 内按 query 过滤排序：base===query(0) > base.startsWith(1) >
>   path.startsWith(2) > path.includes(3)；同秩按路径长度升序；取前 20；
>   query 归一化：小写、`\` → `/`。
>
> **B. pre-step 引用注入（@file + @dir）**
> - `ctx.on('agent/pre-step', handler, { prepend: true })`（waterfall：先
>   `const decision = await next()`，`reject`/`signal.aborted` 直接返回）。
> - 只扫描 `source.kind === 'user'` 消息的文本块，两种 token：
>   - `/(?:^|[\s\u3000])@([^\s@]+)/g`：捕获后剥尾部标点
>     `[.,;:!?，。；：！？、"')\]}>]+$`；跳过 `/^[a-z]{3,6}-\d+$/i`（动态插件 id）。
>   - `` /`([^`\n]+)`/g ``：反引号短路径；含空格者跳过。
> - 解析规则（`norm = token 去尾部 `/` 后、`\`→`/` 归一化`）：
>   1. **token 以 `/` 结尾 = 目录意图**：直接 `fs.resolve(token,{cwd})`+`stat`，
>      类型为 `directory` 即命中；失败则用索引对 `type==='directory'` 做后缀匹配
>      （`path===norm || path.endsWith('/'+norm)`），匹配数 0 或 >2 跳过（防误注入）。
>   2. **无 `/` 结尾**：先直接解析；失败则索引后缀匹配**先文件后目录**
>      （两类合计匹配数 0 或 >2 跳过，1~2 个全部注入）。
> - **@file 注入**：`stat` 后 `readText`；>400KB 或 size 未知时改 `streamText` 流式截取；
>   文本上限 60,000 字符（截断注明）。消息格式：
>   ```
>   <file_context>
>   The user referenced this workspace file: <完整相对路径>. Its content:
>   <内容>
>   When the user asked to modify this file, edit it in place with its exact path; keep unrelated parts unchanged.
>   </file_context>
>   ```
> - **@dir 注入（对齐 Codex）**：从目录 BFS 生成两部分——
>   ① **树**：深度 3、上限 200 行、目录优先排序、目录名带 `/`、跳过上述噪声目录；
>   ② **文件内容**：树内（深度上限内）`type==='file'` 且 size ≤ 32KB 的文件，
>   读前 24,000 字符，**文本嗅探**（前 512 字符含 `\0` 则跳过，防止二进制垃圾入上下文）；
>   最多含 8 个文件，整条消息总量 ≤ 60,000 字符，截断注明。消息格式：
>   ```
>   <dir_context>
>   The user referenced this workspace directory: <相对路径>/ (N files, M dirs; contents of K files included)
>   [directory tree]
>   <树行>
>   [file contents]
>   --- <相对路径> ---
>   <内容>
>   </dir_context>
>   ```
> - 每回合最多注入 5 个引用（目录引用按 1 个计）；同回合按路径去重（在
>   `agent.session.events` 中往回找本 turn 的 `turn/start` 或按
>   `{agentId, turn}` 内存态去重均可）。
> - 注入消息：`createUserMessage({ content: [{ type:'text', text }],
>   source: { kind:'plugin', plugin: name, form:'snapshot',
>   sections: [{ name, text }] } })`，返回
>   `{ kind:'enter', messages: [...decision.messages, ...injected] }`。
> - 类插件构造函数注册 `fileIndex` 服务；所有部署可调限制均通过 `Config` schema 注入，
>   不在 `apply` 中自行注册或遗留未清理的全局监听器。
> - 全部 IO 包 try/catch，失败打日志并跳过，绝不阻塞回合。

### Prompt 2 — Web 客户端插件包（M2）

> 在 `packages/client/src/index.ts` 实现浏览器半。参考：
> - `packages/client/ui-skill/src/client/index.ts`（注册 `/` source 的完整范式）
> - `packages/client/ui-subagent/src/client/index.ts`（`@` source 范式）
> - `packages/client/ui-input-trigger/src/types.ts`（契约：`InputTriggerSource`、
>   `CandidateRequest`、`InputTriggerPick`、`PickOutcome`）
>
> - 客户端插件声明 `inject: ['remote', 'inputTriggers']`，`apply` 先挂载手写 Typert
>   contribution，再通过 `ctx.get('remote.fileIndex')` 使用刚挂载的命名空间；不能把
>   `remote.fileIndex` 同时声明为 inject，否则会在本插件挂载前形成等待环。
> - `ctx.effect(() => ctx.inputTriggers.registerSource(source), 'label')` 注册 source：
>   ```
>   { trigger: '@', name: 'file', order: -1, candidates, warm, onPick }
>   ```
>   （`order: -1` 排在 subagent 组之前；`name: 'file'` 即菜单分组标题）。
> - **本地索引缓存（防闪烁的关键）**：`warm(session)` 与 `candidates` 共用
>   `ensureIndex(sessionId)`——使用 Host 返回的 `cacheTtlMs` 的 sessionId 级缓存 + 单飞；
>   完整快照（`complete: true`）由客户端本地过滤；索引达到上限而返回
>   `complete: false` 时，非空 query 通过 Host 查询，并按 query 做有界 TTL 缓存；
>   数据源为 `ctx.remote.fileIndex.list(session.sessionId, { query: '' })`
>   （首次取快照，返回 `{ files: [{type,path,name,dir}], complete, cacheTtlMs }`，其中 TTL 由 Host 配置）。
>   不完整快照的非空 query 由 Client 做 50ms 可取消防抖；被后续 query 替代的请求不发起 RPC。
> - `candidates(session, { query, signal })`：缓存就绪后**纯本地**过滤排序
>   （与 host 同规则，取前 20），`await` 后检查 `signal.aborted` 返回 `[]`；
>   生成候选：
>   - 文件：`{ name, description: dir, icon: '📄' }`
>   - 目录：`{ name: name + '/', description: dir, icon: '📁' }`
>   - 同名（basename 相同，目录按带 `/` 的名比较）时 name 改为 `dir/名字` 保证唯一
>     （菜单 React key 依赖唯一 name）。
> - `onPick(pick)`：维护 `sessionId → Map<name, row>`（每次 candidates 结果刷新）；
>   由 `pick.candidate.name` 取回条目后返回 `{ insert: { source, ref, label,
>   clipboardText } }`，其中 `ref` 是准确工作区相对路径、`label` 是候选显示文本。
>   同时提供 `codec.clipboardText` 与 `codec.serialize`，在发送时序列化为 `@{path}`；
>   `lexicon` 仅保留给手输旧式 token 的兼容装饰。
> - 所有 `remote` 调用 try/catch，失败返回 `[]` 并 console.error。

### Prompt 3 — Bundle、组合注册与发布安装（M3/M4）

> - `packages/bundle/cordis.patch.yml` 写入（顶层数组，`insert` 块）：
>   ```yaml
>   - insert:
>       - id: file-mention-host
>         name: '@ohoyo/dsh-file-mention-host'
>       - id: client-file-mention
>         name: '@ohoyo/dsh-client-ui-file-mention'
>   ```
>   （host 行是普通 root 行；client 行带 `dsh.client` 元数据，由 `modules` 服务扫描进
>   `window.__DSH_BOOT__` 并对外提供 `/plugins/<id>/client.js`。）
> - bundle 包 dependencies 同时声明两个包（`^` 版本），并携带上述 patch。
> - 发布：`pnpm publish`（按私有/公共源配置 `publishConfig`）。
>
> **本机安装步骤（Ohoyo 的部署，profile 路径已确认）**
> 1. 由 `dsh plugin --profile web add @ohoyo/dsh-file-mention` 写入并安装 profile
>    manifest（不手工维护 package.json 或 bundle 列表）。
> 2. 重启 `dsh web`（进程重启后组合重新装配；这是"永久性"验证点）。
> 3. 如客户端插件未加载，检查构建产物路径，刷新页面。

### Prompt 4 — 验证清单（人工回归）

> 1. 重启 DSH 进程后，插件仍在（组合行存在、无 loading 错误）。
> 2. 输入 `@warning` → 候选平滑出现（文件 `📄` + 目录 `📁/`），逐键输入无闪烁、无"透出对话区"。
> 3. Enter 选文件 → 输入框为 `@warning-disposal-report-index-vue`；
>    Enter 选目录 → 输入框为 `@warning-disposal-report`。
> 4. 发送文件引用 → 模型读到该文件完整内容（上下文出现 `<file_context>`）。
> 5. 发送目录引用 → 模型读到目录树 + 小文件内容（上下文出现 `<dir_context>`，
>    二进制/超大文件被跳过并在统计中体现）。
> 6. `@不存在的路径`、普通反引号文本（如 `` `false` ``）不注入、不报错。
> 7. `@<动态插件id>`（形如 `abc-123`）不被劫持。
> 8. 与既有 `@subagent` 源共存：两个分组都出现在菜单中。

---

## 4. 关键接口速查（本会话实测，供实现时对照）

| 事实 | 说明 / 参考位置 |
| --- | --- |
| pre-step 事件 | `agent/pre-step`（waterfall，root 作用域监听器收所有 agent）。签名：`(payload: { agent, messages, turn, step, signal }, next) => Promise<PreStepDecision>`；`PreStepDecision = { kind:'enter', messages: UserMessage[] } \| { kind:'reject' }`。参考 `packages/core/agent/src/runtime-types.ts`、`packages/context/time-context/src/index.ts` |
| 注入消息构造 | `createUserMessage({ content:[{type:'text',text}], source:{kind:'plugin', plugin:name, form:'snapshot', sections:[{name,text}]} })`，包 `@deepseek-ai/dsh-llm` |
| 会话工作区 | `agent.session.header.cwd`（绝对路径，可能 undefined）；SessionHeader 见 `packages/core/session/src/types.ts` |
| fs 服务 | `resolve(path, {cwd?, signal?})`、`stat`、`listDir(target)`、`readText`、`streamText`；`FsDirEntry { name, type, target, size? }` 见 `packages/fs/fs/src/types.ts` |
| 触发源契约 | `InputTriggerSource { trigger:'@', name, order, candidates(session,{query,position,signal}), onPick(pick), warm? }`；`onPick` 可返回 `{ text }`（替换 span）、`{ insert }`（芯片+codec）或 undefined。见 `packages/client/ui-input-trigger/src/types.ts` |
| 菜单渲染 | `MenuView`：分组标题取 `t(source.name)`（未知 key 原样显示）；`itemName` 40% 宽省略、`itemDescription` 紧随；空组自动关菜单；Enter 选取高亮项。见 `packages/client/ui-input-trigger/src/client/MenuView.tsx`、`src/core/menu.ts` |
| 语言包限制 | `slash.menu` 命名空间由 ui-input-trigger 独占（`locale.register` 同 (ns,locale) 重复抛错），第三方无法加分组标题翻译。见 `packages/client/locale/src/client/index.ts` |
| 客户端远程调用 | 客户端插件 `inject: ['remote.<namespace>']`，调用 `ctx.remote.<ns>.<method>(agentId, ...args)`；host 端方法第一参数 `agent: Agent`（typert 用 agentId 解析活体 Agent）。参考 `packages/extensions/cordis-client-runner/src/client/index.ts`（`remote.dynamicCordisRunner`） |
| Remote 服务声明 | `class X extends TypertRemoteService` + `@Remote('method')`，`super(ctx, '<ns>')`；导入 `@deepseek-ai/dsh-typert-protocol`。参考 `packages/extensions/cordis-host-runner/src/index.ts` |
| 客户端包元数据 | `package.json`：`"dsh": { "client": { "inject": [<依赖包名>], "platform": "web" } }`，exports `./client` → `lib/client.js`。参考 `packages/client/ui-skill/package.json` |
| Bundle 元数据 | `package.json`：`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。参考 `packages/bundle/base/package.json`、`packages/bundle/web-app/cordis.patch.yml` |
| 本机 profile | `C:\Users\Ohoyo\.dsh\profiles\web\`：`cordis.yml`（空根）、`cordis.patch.yml`（用户补丁层）、`package.json` 的 `dsh.profile.bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']` |
| 组合行格式 | `{ id, name: '<包名>', inject?: [...], config?: {...} }`；patch 层 `insert:` 追加、`id` 定位覆盖/禁用。参考 `packages/bundle/web-app/cordis.patch.yml` |

## 5. 已知限制（写入 README）

- 旧式手输 token 的路径含空格仍不支持；菜单选择的结构化引用支持空格路径。
- 用户气泡不渲染 markdown：对话区中反引号为字面文本（内置 UI 行为）。
- 菜单分组标题固定显示 `file`（语言包独占限制）。
- 同短名后缀匹配上限 2 条，超过则跳过注入（防误注入）。
- 索引跳过 `node_modules`/`.git`/`dist` 等目录；上限 5000 条（文件+目录）。
- @dir 快照有预算：树深 3 / 200 行；仅 ≤32KB 的文本文件附内容（前 24,000 字符，
  最多 8 个）；二进制文件跳过。

## 6. 附：可直接复用的核心代码

- **@file 基线**：Host 端 token 解析、直接解析→后缀匹配、截断读取、消息构造；
  Client 端 `ensureIndex` 缓存、`rank/filterFiles`、`shortForm`、`candidates/onPick`
  的完整逻辑，见本会话中动态插件 `atfil-2/pkg-4` 的源码
  （`cordis_inspect_self(pluginId='atfil-2', packageId='pkg-4')` 可回读）。
- **@dir 为新增工作**：在 pkg-4 逻辑上按 Prompt 1/2 扩展
  （索引加 `type` 与目录条目、候选加 `📁` 与 `/` 后缀、pre-step 加 `<dir_context>` 分支）。
- 迁移到静态插件时仅需替换：
  - `harness.handle('file-index')` → `FileIndexService` 的 `@Remote('list')`；
  - `host.call('file-index', {sessionId, query})` → `ctx.remote.fileIndex.list(sessionId, { query })`；
  - `ctx.get('fs')/ctx.get('agents')` → 插件 `inject: ['fs']`（服务内 `this.ctx` 访问）；
  - `console.log` 沙箱写法 → 普通 `console`。
