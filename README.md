# @ohoyo/dsh-file-mention

让 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 支持使用 `@` 引用工作区中的文件和目录。

在 Harness 输入框中输入 `@` 加文件名或目录名即可搜索并插入引用。这个插件会把引用保存为准确的工作区相对路径，避免空格、标点、同名文件和目录嵌套造成歧义。

## 它解决什么问题？

DeepSeek Harness 原生支持 `@` 提及，但不能直接引用文件和目录。本插件补齐这条链路：

- 输入 `@` 后搜索工作区中的文件和目录。
- 选择文件或目录后插入 Harness 原生引用 chip。
- 文件引用会注入 `<file_context>`，目录引用会注入 `<dir_context>`。
- 目录引用包含受限的目录树和小型文本文件内容，避免一次性塞入过大上下文。
- 路径含空格、标点或重复文件名时仍能保持精确引用。
- 保留手写旧式 `@path` 和反引号路径的兼容解析。

## 安装

### 从 npm 安装（推荐）

要求：已安装 DeepSeek Harness Web。仓库当前以 `0.1.0-rc.5` 系列作为兼容性验证基线。

在目标环境执行：

```sh
dsh plugin --profile web add @ohoyo/dsh-file-mention
```

然后重启 Harness Web：

```sh
dsh web
```

如果 Harness Web 已经在运行，请重启对应进程并刷新浏览器页面。

## 使用

1. 在 Harness 输入框中输入 `@` 加文件名或目录名片段，例如 `@README` 或 `@src`。
2. 从候选列表中选择文件或目录。
3. 发送消息。
4. Host 会在请求进入模型前读取对应引用，并把内容加入上下文。

示例：

```text
请检查 @packages/client/src/client/index.ts 的缓存逻辑。
请总结 @packages/host/src/ 目录的结构。
```

菜单选择的引用会使用结构化格式保存，例如：

```text
@{packages/client/src/client/index.ts}
```

`@{...}` 是插件内部使用的精确协议格式，通常不需要手动输入。

## 工作方式

插件由两个部分组成：

| 部分 | 作用 |
| --- | --- |
| Client | 注册 `@` 输入源，缓存工作区索引，在浏览器端过滤和排序候选项 |
| Host | 提供文件索引 Remote 服务，解析引用并向模型上下文注入文件或目录内容 |

完整索引会在 Client 本地缓存，正常输入不会为每个字符发起远程请求。大型工作区会使用 Host 端的查询索引；文件写入或编辑后，Host 会使索引失效，Client 会根据版本号丢弃旧缓存并重新获取。

## 从源码安装

适用于需要修改插件、调试 Harness 集成或暂时没有 npm 发布包的场景：

```sh
git clone <repository-url> dsh-file-mention
cd dsh-file-mention
pnpm install --frozen-lockfile
pnpm build
pnpm pack:local
```

`pnpm pack:local` 会在 `.local-pack/` 生成 Host、Client 和 Bundle 的 tarball。将这三个 tarball 添加到目标 profile 的 `package.json`，并在 `dsh.profile.bundles` 中启用 Bundle，然后在 profile 目录执行：

```sh
pnpm install
dsh web
```

源码安装依赖构建产物；如果不想执行本地构建，请使用 npm 发布包。

## 已知限制

- 目录引用会受到树深、文件数量、文件大小和总字符数预算限制。
- 工作区索引默认最多收录 5,000 个文件和目录；超出后会使用 Host 查询索引补足非空搜索。
- 手写旧式 `@path` 仍受空白分隔、后缀碰撞和动态插件 ID 兼容规则影响；从菜单选择的结构化引用不受这些限制。
- Client 当前通过缓存 TTL 和 Host 返回的版本号保持新鲜度；Harness 尚未向第三方 Client 插件开放 `fs/observed` 的实时事件订阅，因此不会在文件变更瞬间主动推送刷新菜单。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm smoke
```

## 项目结构

```text
packages/
├── host/    Host 插件：索引、引用解析和上下文注入
├── client/  Web 插件：@ 输入源、候选菜单和结构化引用
└── bundle/  发布 Bundle：同时安装 Host 和 Client
```

## License

MIT
