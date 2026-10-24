# pi-manager

独立的 **Pi profile、插件包和上下文资源 TUI 管理器**，不改 Pi 源码，不往默认 Pi 配置里注册插件。

## 开始使用

需要 Node.js **22.19+**，以及安装了 SDK 的 Pi。当前在 Pi **1.3.0** 上验证。

```bash
cd /path/to/pi-manager
npm start
# 或
node src/index.js
```

无第三方运行时依赖，也不需要修改 Pi。项目目前标记为 `private`，不会意外发布到已被占用的 npm 名称；不要用 `npm install -g pi-manager` 安装 npm 上的同名其他项目。

### 安装为全局命令

在源码目录中将当前版本打包，再从本地包安装（无需联网，也不安装 Pi extension）：

```bash
npm pack --offline
npm install --global ./pi-manager-0.3.0.tgz --offline --ignore-scripts --no-audit --no-fund
pi-manager --version
```

安装后可以在任何项目目录中运行：

```bash
cd /path/to/your-project
pi-manager
# 或直接用指定 profile 启动 Pi
pi-manager profile run review
```

Pi 使用启动时的当前目录作为工作目录。首次打开选择 `+ Create profile`，创建后添加包/资源，再选择 `Run Pi`。此安装是当前版本的独立副本；源码修改后需重新打包安装。开发时也可用 `npm link --offline` 创建指向源码的命令链接。

### TUI

- `↑` / `↓`、`PgUp` / `PgDn`：导航
- `Enter`：打开详情或执行动作
- `/`：搜索；搜索时 `Enter` 结束输入，再按一次打开
- `Space`：切换包或资源的启用状态
- `Esc`：返回；有搜索条件时先清空条件
- 预览页支持垂直和水平滚动

```text
Profiles
└── review
    ├── Run Pi
    ├── Packages
    │   └── package detail / resource switches / uninstall
    ├── Skills
    ├── Context files
    ├── Extensions
    ├── Prompt templates
    ├── Themes
    ├── All resources
    ├── Package generations / restore
    ├── Package operation logs
    ├── Set as default
    ├── Copy profile
    └── Delete profile
```

安装前显示包信息并确认第三方代码风险；卸载和删除也需要确认。界面是独立终端程序，不加载到 Pi 内部。

## 隔离边界

管理器自身的持久化状态放在 `~/.pi-manager/`：

```text
~/.pi-manager/
├── state.json
└── profiles/
    └── review/
        ├── settings.json       # 此 profile 的 Pi 原生配置
        ├── manager.json        # 上下文、整包禁用时的原配置等
        ├── resources/          # 导入的资源副本
        ├── .packages/          # 管理器拥有的包版本代，不覆盖当前使用的目录
        │   └── <generation>/
        │       ├── npm/        # 此版本的 npm 包、manifest 与锁文件
        │       ├── git/        # 此版本的 Git 包副本
        │       ├── settings.json
        │       └── generation.json
        ├── npm/                # 旧版布局可能保留；首次变更只复制，不移动/删除
        ├── git/                # 旧版布局可能保留
        ├── sessions/           # 此 profile 的会话
        ├── auth.json           # 在此 profile 中登录后由 Pi 创建
        └── .operations/        # 包操作日志
```

**不会主动修改：**

- 默认 `~/.pi/agent/settings.json` 和其资源目录
- Pi 安装目录、源码、内置插件
- 当前项目的 `.pi/`、`AGENTS.md` 或 `CLAUDE.md`
- 父 shell 的环境变量
- 导入资源的原文件、外部本地 package 的内容

包操作使用独立子进程中的 **Pi 公共 `DefaultPackageManager` SDK**，只在新建的候选版本代中处理包文件。校验成功后，通过 profile 的 `settings.json` 单次原子替换切换包路径和过滤器。Pi 看到的只是普通本地 package 路径，不需要补丁或扩展配合。源 npm/git 声明和版本代引用保存在管理器自己的 settings 字段中，管理界面仍显示原来源。不会执行 Pi 自更新入口。资源枚举同样复用 SDK，支持 manifest、glob 和 Pi 资源过滤，不导入/执行第三方 extension。

### 不是安全沙箱

“无污染”是管理器的写入约定，**不等于限制第三方代码的系统权限**：

- 包的安装脚本、加载到 Pi 的 extensions、外部编辑器仍有当前用户的权限。
- npm/git 可能使用自己的缓存、凭证和 Git 配置；不能承诺它们不写任何外部文件。
- 外部编辑使用临时文件，保存后才写回管理器资源副本。
- 不自动共享默认 Pi 的凭证、模型配置或会话。第一次在 profile 中运行 Pi 时需自行登录，或使用环境变量提供凭证。
- Pi 仍可能读取项目上下文 `AGENTS.md` / `CLAUDE.md`、`~/.agents/skills` 等原生发现来源。默认 `--no-approve` 只禁用信任控制下的项目配置，不等于关闭所有上下文发现。
- UI 显示的是**下次启动配置**，不是一个已经运行的 Pi 进程的实时状态。

## 包管理

```bash
node src/index.js profile create review
node src/index.js package inspect npm:pi-tool-display
node src/index.js package add review npm:pi-tool-display --yes
node src/index.js package list review
node src/index.js package disable review npm:pi-tool-display
node src/index.js package enable review npm:pi-tool-display
node src/index.js package update review --yes
node src/index.js package remove review npm:pi-tool-display --yes
node src/index.js package versions review
node src/index.js package rollback review --yes
```

来源沿用 Pi 格式：`npm:name@version`、`git:github.com/owner/repo@ref` 或本地目录/模块绝对路径。**本地 package 是引用，不复制、不安装依赖、不删除原目录**；需要可编辑副本时用 resource import。

整包关闭会将四类资源过滤器设为 `[]`，并在 `manager.json` 保存原配置；重新打开恢复原过滤器。**不使用 `autoload:false` 充当整包开关**，因为它在 Pi 中有独立的增量过滤语义。

没有 source 的 update 显式执行“更新所有 packages”，不会更新 Pi。CLI 包操作要求 `--yes`，表示已知晓第三方代码/安装脚本执行风险。Git inspect 只说明来源，不能在未下载前验证其 manifest 或脚本。

### 停止态版本切换与恢复

1. 获取 profile 独占锁；管理器启动的 Pi 尚未退出时拒绝安装、更新、卸载和恢复。
2. 将当前管理器拥有的 npm/git 文件复制到新的候选版本代。复制真实文件，不硬链接到当前包；依赖内部的 symlink 重定位到新副本，拒绝指向外部的链接和 linked Git worktree。
3. 在候选目录中安装/更新/卸载，再检查包文件、manifest、资源路径和所有权；不加载 extension。校验不等于保证第三方代码运行正确。
4. 记录包内容摘要、过滤器和上一代引用；通过单次原子 settings 替换发布新引用。只有这一步之后下次启动才会用新包。
5. 失败时丢弃候选目录，当前包文件和配置引用不变；成功时保留上一代供恢复。

`package rollback <profile> --yes` / TUI 的 **Package generations / restore**：

- 离线校验上一代内容摘要、路径和包文件，然后切回原包路径、包选择及包资源过滤器。
- 不恢复 `auth.json`、会话、模型、上下文文件或独立资源；不改默认 Pi 或项目配置。
- 本地外部包只恢复其**引用**，不快照、覆盖或倒退其原目录内容。外部文件已被修改时，无法通过本功能恢复。
- 上一代的管理器包文件如果发生变化或丢失，拒绝恢复，不静默重新下载别的版本。旧版本的 metadata、锁文件也保留在版本代内。
- 可再次恢复到刚才离开的那一代；当前 UI 提供当前/上一代切换，不支持任意历史版本选择。

旧布局第一次成功操作会先复制可用的包文件作为基线，旧目录原地保留。若复制的 profile 只有声明、还没有对应包文件，允许初始化，但不会宣称有一个可恢复的完整基线，结果会列出缺失项。

**边界：**这不是对宿主机的完整事务回滚。安装脚本的外部写入、网络请求、数据库修改、Pi 内存状态无法撤销；第三方代码仍拥有用户权限。包代码本身如果擅自写到当前代之外，也不是目录隔离能防住的，需要 OS 沙箱。

切换后的 Pi 原生 `packages` 字段是版本代内的本地路径，`pi-manager` 会映射回原 npm/git 来源。请在管理器中进行包更新/卸载和版本恢复，不要用 profile 内的原生包命令改这组受管声明；Pi 原生的本地包更新不会等价于更新原 npm/Git 来源。

版本代目前不会自动清理，会占用额外磁盘空间，保留它们是为了避免误删当前或恢复目标。强制中止进程可能留下候选目录和 `.lock`；先确认 Pi/npm/git 子进程都已退出，不要在它们仍运行时手动清理。单文件替换保证普通操作的原子发布，不宣称断电时整个磁盘都具备事务持久性。

## 资源管理

```bash
node src/index.js resource list review
node src/index.js resource list review skills --json
node src/index.js resource import review skills ./my-skill
node src/index.js resource import review prompts ./review.md
node src/index.js resource preview review <resource-id>
node src/index.js resource disable review <resource-id>
node src/index.js resource enable review <resource-id>
node src/index.js resource edit review <resource-id>
node src/index.js resource remove review <resource-id> --yes
```

类型为 `skills`、`extensions`、`prompts`、`themes`、`context`。

- 包内资源可预览、逐项启停；过滤器写入隔离 profile，不修改 package。
- 外部/包内资源只读，不允许编辑或单独删除；可导入副本后编辑。
- 导入会复制文件；skills 需是包含 `SKILL.md` 的目录，extension 目录需有 `index.ts` / `index.js`。
- 导入拒绝 symlink，避免编辑或删除沿链接误触原文件。
- 原生 skill frontmatter、theme 等格式仍需符合 Pi 规范；文件枚举不等于内容通过 Pi 加载校验。
- 包的整包开关优先于包内逐项开关。
- 预览限制 128 KiB，过大的文件不允许用内置编辑流程覆盖。

## 预置上下文

```bash
node src/index.js context create review rules 'Focus on correctness and explain assumptions.'
node src/index.js context import review ./guidelines.md
node src/index.js context list review
node src/index.js context edit review rules
node src/index.js context preview review rules
node src/index.js context disable review rules
node src/index.js context enable review rules
node src/index.js context remove review rules --yes
```

上下文保存在 profile 的 `resources/context/*.md` 中；启用的文件通过 **`--append-system-prompt <file>`** 传给新启动的 Pi，不写或替换 `AGENTS.md`、`SYSTEM.md`。关闭后只影响后续启动，不改已保存会话的历史消息。

## Profile 复制与启动

```bash
node src/index.js profile copy review frontend
node src/index.js profile use frontend
node src/index.js profile run frontend
node src/index.js profile run frontend -- --offline
node src/index.js profile delete frontend --yes
```

复制包含 settings、管理器 metadata、导入的资源和 context；**不复制 auth、sessions、npm/git 安装目录或版本代引用**。原 npm/git 声明保留，依赖需在新 profile 中安装/由 Pi 解析，不会让新 profile 共用旧 profile 的版本目录。原本引用外部本地包的资源仍引用同一个外部只读来源。

启动使用子进程环境 `PI_CODING_AGENT_DIR=<profile>` 和独立 `PI_CODING_AGENT_SESSION_DIR`，默认 `--no-approve`；需要项目资源时显式透传 `--approve`。不尝试更换已经运行的 Pi 的 agentDir，也不提供热卸载。

管理器启动的 Pi 和包操作持有 profile lease；同一 profile 使用中拒绝其他管理操作。无法检测从外部手动启动的 Pi。崩溃后可能留下 `.lock`：**先确认相关 Pi/npm/git 进程已退出，再手动删除该文件**，不自动抢占不明进程的锁。

## 环境变量

| 变量 | 用途 |
|---|---|
| `PI_MANAGER_HOME` | 管理器数据目录，默认 `~/.pi-manager`，不可与默认 Pi 目录重叠 |
| `PI_MANAGER_PI` | Pi 启动命令/可执行文件，默认 `pi` |
| `PI_MANAGER_SDK_PATH` | Pi SDK 包目录或公开入口文件；未设置时从 Node 模块或已安装 Pi launcher 查找 |
| `PI_MANAGER_EDITOR` | 编辑器**可执行文件路径**；回退 `VISUAL`、`EDITOR`、`vi` |

编辑器字符串不经过 shell 求值；需要参数时用 wrapper 可执行文件。网络代理沿用进程环境变量，不修改 Pi 的 httpProxy 或 npm registry 配置。

## 测试

```bash
npm test
```

测试使用临时管理器目录，包括路径防护、整包/逐项过滤、CLI、复制、上下文、失败恢复、切换失败注入、包字节校验和真实 Pi SDK 的本地包离线集成。还通过仅监听 loopback 的测试 registry 验证真实 npm 包安装、版本替换、删除及断开 registry 后的恢复，不访问外网。没有 Pi SDK 时集成测试显示 skip；可设置 `PI_MANAGER_SDK_PATH`。不需要模型 API key，不进行模型调用。

## 暂未实现

- 市场索引和远程搜索
- 完整安装脚本审批/沙箱
- 安装中可靠取消及整棵子进程树恢复
- 外部脚本副作用、整台机器的事务回滚
- 任意历史版本选择和旧版本自动清理
- profile 跨进程实时切换；**热卸载明确不做**
- 全局会话/凭证共享、自动写入默认 Pi 的导出功能
- 单包资源有效上下文的精确 token 计数
