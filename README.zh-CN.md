# pi-manager

[English](README.md) | **简体中文**

**v1.3.0 — 管理器作为独立包安装。** [版本说明](CHANGELOG.md#简体中文) · [GitHub Releases](https://github.com/meatRoll/pi-manager/releases)

一个**在 Pi 里面使用的扩展**，管理插件包、Skills、Extensions、提示词模板、主题和预置 Markdown 上下文。

```text
启动 Pi → 输入 /manager → 管理资源 → 返回当前对话
```

**不需要另开独立管理器，不在 Pi 内嵌套启动第二个 Pi。** 使用 TypeScript 严格类型检查，只使用 Pi 公共扩展/SDK 接口，不修改 Pi 源码、模块缓存或内部注册表，不做热卸载。

## 安装

需要 **Node.js 22.19+**、Git 和已安装的 Pi；当前在 **Pi 1.3.0** 验证。

```bash
git clone https://github.com/meatRoll/pi-manager.git ~/.pi-manager/manager
cd ~/.pi-manager/manager
node dist/index.js install --yes
```

`dist/` 已随仓库提交，克隆下来即可直接运行，无需构建（`npm ci` 只用于开发）。安装器用官方 `pi install` 注册**两个**包：

| 包 | 内容 | 更新方式 |
|---|---|---|
| `git:github.com/meatRoll/pi-manager` | 管理器本体（`/manager`） | `pi update --extensions` |
| `~/.pi-manager/pi-package` | 已发布的资源（包、Skills、提示词、主题、上下文） | 在 `/manager` 里按 **P** |

**这一步会在 Pi agent settings 中增加两个包声明。** 不复制或替换原有包、凭证、会话、模型和项目配置。源码目录只用于运行安装器，之后可以删除；已存在的管理器声明会被跳过（`PI_MANAGER_SELF_SOURCE=none` 可完全跳过）。

退出 Pi，在你的项目目录重新启动：

```bash
cd /你的项目目录
pi
```

然后在 **Pi 输入框**中输入：

```text
/manager
```

安装后 `npm start` 只是启动普通 `pi`。源码目录之后可以删除：注册的管理器包是 Pi 自己管理的 Git 安装，已发布预设是自包含快照。

### 把已发布快照放到另一块盘

每次发布都会复制几百 MB，而只有最新一份是活的。可以只重定向发布目录，profiles 留在原处：

```bash
export PI_MANAGER_PUBLISH_DIR=/Volumes/big-disk/pi-manager-packages   # 写进 shell 配置
node dist/index.js install --yes     # 发布到新位置并注册新路径
pi remove ../../.pi-manager/pi-package   # 删掉它报告的旧声明
```

`install --yes` 会打印需要删除的旧 `pi-package` 声明。写入范围被限制在 manager home 加这个目录内，且不得与 `~/.pi`、manager home 或 `profiles/` 重叠。

### 更新

```bash
pi update --extensions                                      # 管理器本体（git 包）及其他扩展
pi update git:github.com/meatRoll/pi-manager                 # 或只更新管理器
node ~/.pi-manager/manager/dist/index.js self-update --yes   # 从源码目录做同样的事
```

然后重启 Pi。Pi 内等效入口是 **More → Update pi-manager from GitHub**。资源变更另走一条路：在 `/manager` 里改完后按 **P** 发布。自更新遇到工作区改动、分离 HEAD、或 `origin` 不是本仓库时会拒绝——不会 merge/rebase，也不会碰你的暂存包、资源或预设。

GitHub 仓库公开；`package.json` 的 `private: true` 只防止误发布到 npm。npm 上同名包属于其他项目，**不要使用 `npm install -g pi-manager` 或 `pi install npm:pi-manager`**。也不要额外执行 `pi install git:github.com/meatRoll/pi-manager`：那会和已发布快照一起注册第二个 `/manager`。请使用上面的 clone + `install --yes`。

### 不注册，先试用

```bash
npm ci
npm run build
pi -e ./dist/extension.js
```

只在这次 Pi 启动提供 `/manager`。可以编辑暂存预设并发布快照，但普通 Pi 启动不会加载快照，直到执行安装器完成注册。不要同时加载直接扩展和已注册包，否则会重复注册 `/manager`。

## 在 Pi 中使用

打开 `/manager` 会**直接进入默认暂存预设**（例如 `mine`）；默认项不存在时，回退到已有的 loaded/published 预设或第一个预设。没有预设时选择 **+ Create profile**。按 **S** 切换预设或新建；切换编辑对象不会发布或改变当前 Pi。

此处 profile 表示**资源预设的暂存区**，不是切换当前 Pi 的凭证、会话或 agentDir。

```text
pi-manager / mine                         [S switch preset]
loaded: mine · next start: mine
Unpublished changes · P publish for next start

[All]  Extensions  Skills  Context  Packages  More

[x] meatRoll/pi-inspect-image · src/index.ts   extensions · package
[x] handoff.ts                             extensions · standalone · owned
[x] pptx-preview                           skills · standalone · owned
[x] APPEND_SYSTEM                          context · standalone · owned

Space toggle · Enter preview · E edit · A add · P publish
←→ / Tab category · S switch preset · / search · Esc close
```

底部提示是**上下文相关**的：只列出当前分类与当前选中行真正可用的键。`E edit` / `Del delete` 只在 manager 拥有的副本上出现；包的行显示 `Space toggle package · Enter package menu`；`More` 分类的行显示 `Enter run action`。

- **空格**直接启停所选资源/包，只改暂存。**Enter**直接预览资源，选中包则打开操作菜单。**E** 编辑管理器副本；**Del** 确认后删除副本。外部/包内原文件仍只读。
- **←→** 或 **Tab / Shift+Tab** 在同一页切换分类。**/** 搜索（Enter 结束输入，再按一次打开）；每个分类在预览、编辑、启停后保留选中项和搜索条件。**Esc** 先清空搜索，再退出。预览支持 `↑↓`、`PgUp` / `PgDn`。
- **A** 向当前分类添加；**P** 确认后发布。其他进程修改后按 **R** 刷新。终端面板先显示，资源发现与完整内容比较放在后台；资源列表先可操作，检查结束前标题显示 **Checking publication…**，之后再提示未发布修改或无法确定的状态，不冒充当前会话已生效。关闭或切换会取消只读检查。本地外部包只是引用，不追踪历史副本。
- **More** 收拢模板、主题、预设管理/默认项、包导入、全部更新、恢复、日志、复制/删除、manager-only 发布及说明。
- RPC 客户端使用同样的扁平资源列表，通过明确的分类/操作对话框交互，不依赖终端快捷键。首个列表只等资源 metadata，不再等待完整内容比较；RPC 无法修改已经打开的对话框，检查结果会在下次对话框中显示。
- 包内 Extension 显示为 `包标签 · src/index.ts`，便于区分同名入口。Git 包优先使用**实际配置的仓库**（如 `meatRoll/pi-image-gen`），不使用可能残留的上游 manifest 名称；非 GitHub 来源保留主机名。npm 包使用配置中的包名（保留 scope）；本地包若有独立 Git 仓库，则只读使用其 `origin` 仓库标签（不访问网络）；否则使用 manifest 名称或配置路径，不会借用父目录仓库或可能残留的 manifest 仓库 URL。包列表保持相同标签，原始 manifest 名称仍可在包详情中查看。独立文件名不变；这些只是显示标签，不会重命名文件、修改来源或改变资源 ID。
- 导入 Skill 选择包含 `SKILL.md` 的目录。导入资源会复制文件，之后编辑管理器副本不改原文件。
- Pi 自己发现的用户级资源（例如 `~/.agents/skills`）显示为 `user-level · read-only`：不能在预设里启停或编辑，发布时也不导出——Pi 每次启动都会自己加载，这样快照保持自包含。
- 包来源支持 `npm:name@version`、`git:github.com/owner/repo@ref`、本地路径。本地包是**外部引用**，不复制、不安装依赖、不删除其原目录。
- 包操作和删除需确认。安装脚本仍有当前用户权限。

### 编辑 → 发布 → 重启

1. 在暂存 profile 中修改包、资源开关和上下文。
2. 按 **P**，确认 **Use on next Pi start?**（RPC 中选 **Publish for next Pi start**）。
3. 正常退出 Pi，再重新启动。注册的本地包会在启动时提供选中的 extensions、skills、模板、主题和上下文。
4. 再打开 `/manager`，标题分别显示**当前 loaded** 和**下次启动 next start** 的预设。

发布会将管理器拥有的包/资源复制到独立快照。继续编辑或删除暂存 profile 不会删掉当前 Pi 使用的资源。外部本地包仍然只是引用，其自身文件变化不在此隔离范围内。快照暂不自动清理。

选中预设是在当前普通 Pi 环境中**追加受管资源**，不会屏蔽原有个人/项目/共享资源，不改变项目信任，不切换凭证、模型配置或会话存储。资源名称冲突遵循 Pi 原有规则。选择 **More → Use manager only on next Pi start** 可在下次启动只加载管理器，不再导出预设资源。

扩展不调用 `/reload`，不操作已加载的注册表，也不承诺立即卸载。发布后请完整重启，尤其是 extension 变化。你自行执行 `/reload` 属于 Pi 原生行为，不是管理器的事务恢复。

## 导入已有 Pi 包

将个人 Pi settings 里已经声明、已经安装的包导入管理器：

1. 新建一个**空的**暂存 profile，例如 `mine`。
2. 选择 **More → Import packages from current Pi**，在确认框核对来源 agent 目录。
3. 核对导入的包和资源清单。管理器自身的 bundle 会被跳过。
4. 验证后再切换：备份来源 `settings.json`，经明确确认后只移除其中已迁移的包声明，再按 **P → Use on next Pi start?** 发布 profile。保留管理器 bundle 声明和原始包目录。重启 Pi，确认 loaded profile。

**导入只生成暂存副本，不会自动完成切换。** 不发布、不删除默认声明，也不改变当前 Pi。若保留原声明又加载发布副本，可能重复加载 extension，造成命令/工具冲突，甚至导致 Pi 无法启动；明确处理重复声明之前，不要启用发布副本。需要回退时，发布 manager-only、恢复备份中的原声明，再重启。

导入将来源 agent 拥有的整个 `npm/`、`git/` 目录复制到新的包版本代，离线校验，不下载、不安装依赖、不执行 extension。导入期间请停止来源包的并发安装/更新。缺失的安装、外部 symlink、linked Git worktree 会被拒绝，不静默重装。保留包资源过滤器；相对本地包路径按原 settings 文件目录解析，仍是**外部引用**，不复制、修改或删除其文件。

只导入包声明及 `npmCommand` / `httpProxy` 包管理配置，不复制凭证、会话、模型、用户指令、独立资源或项目配置。已有包历史的 profile 不能被覆盖导入，请新建空 profile。

可选 CLI 等价操作（同样只写暂存区）：

```bash
node dist/index.js profile create mine
node dist/index.js migrate mine --yes
# 或明确指定已有 Pi agent 目录：
# node dist/index.js migrate mine /path/to/agent --yes
```

默认来源依次为 `PI_MANAGER_SOURCE_AGENT_DIR`、`PI_CODING_AGENT_DIR`、`~/.pi/agent`。

## 预置上下文

切到 **Context** 页签，按 **A** 创建或导入 Markdown；选中上下文后按 **E**，使用 Pi 自己的编辑器编辑副本。

发布时，上下文内容与资源路径绑定到同一份启动快照。扩展通过公共 `before_agent_start` 事件中的独立 prompt section 追加这些内容；不覆盖 `AGENTS.md`、`CLAUDE.md`、`SYSTEM.md`、其他扩展的 section 或 Pi 整个系统提示词。

暂存编辑不会悄悄改变当前已加载快照的指令。发布并重启后才使用新内容；关闭上下文也不会删除会话历史中的消息。

## 包恢复

包操作在独立 Node worker 中调用 Pi 公共 `DefaultPackageManager`。worker 只处理包文件，**不是另一个 Pi 对话，也没有独立终端界面**。

1. 获取暂存 profile 独占锁。
2. 将受管 npm/Git 文件复制到候选版本代，不硬链接当前文件。
3. 在候选目录安装、更新或卸载。
4. 校验包文件、manifest、所有权和资源路径，不执行 extensions。
5. 记录内容摘要，用单次原子替换暂存 `settings.json` 切换包路径和过滤器，保留上一代。

提交前失败时，当前暂存引用和受管包文件保持不变。**More → Package generations / restore** 离线校验上一代摘要，再恢复包和过滤配置；之后仍需发布并重启 Pi，才会使用恢复的版本。

恢复不覆盖上下文、独立资源、凭证、模型文件、会话或默认/项目配置。本地外部包只恢复**引用**，不恢复历史文件内容。旧代受管文件改变或丢失时拒绝恢复，不静默联网下载其他版本。

整包关闭将四类资源过滤器设为 `[]` 并保存原条目，重新启用恢复原过滤器。不使用 `autoload: false` 充当整包禁用，因为 Pi 对它有独立的增量过滤语义。“更新所有包”不会更新 Pi 本身。

### 限制

- 这不是 OS 沙箱或宿主机完整事务。第三方扩展/脚本仍有用户权限，外部写入、网络请求、数据库和 Pi 内存状态不能撤销。
- 文件发现/校验不保证第三方代码、Skill 或主题运行时一定加载成功。
- 受管快照内的依赖 symlink 会重定位；拒绝指向外部的 symlink、特殊文件和 linked Git worktree。导入资源拒绝 symlink。
- 不完整的旧基线允许初始化，但不宣称可恢复；缺失的包声明不能被发布成误导性的空预设。
- 提供当前/上一代切换，不提供任意历史选择。版本代及发布快照保留，会额外占磁盘。
- 强制结束可能留下 `.lock` 或候选目录。确认相关 Pi/npm/Git 子进程全部退出后再手动清理，不自动抢占未知锁。
- 原子文件替换是正常操作的发布边界，不是整个磁盘断电持久性的事务保证。

## 存储和写入边界

```text
~/.pi-manager/
├── state.json
├── profiles/<name>/
│   ├── settings.json              暂存包声明和资源过滤器
│   ├── manager.json               上下文及管理器 metadata
│   ├── resources/                 可编辑的导入副本
│   ├── .packages/<generation>/    包文件、锁文件和摘要
│   └── .operations/               包操作日志
└── pi-package/
    ├── package.json               原子发布点，向 Pi 注册一次
    └── .snapshots/<id>/           独立包/资源文件和上下文
```

**安装是“不改默认 Pi settings”的明确例外**：官方 `pi install` 增加本地管理器包声明。注册后的管理操作写自己的目录，不反复改默认 Pi settings。

扩展不会自动导入默认 Pi 的资源；明确执行的包导入对来源只读。不改外部原文件、项目 `.pi`、父 shell 环境、Pi 源码/安装目录，也不复制凭证。npm/Git 缓存和第三方脚本仍可能在外部写入。

当前 Pi 继续使用它自己的登录和会话。旧 CLI 隔离 profile 中的凭证、会话不会自动被 Pi 内扩展采用或共享。旧启动器正在使用某个暂存目录时，管理器锁仍会拒绝修改；无法可靠检测外部手动启动的进程。

## 更新和卸载

更新源码后：

```bash
npm ci
npm run install:pi -- --yes
# 重启 Pi
```

使用官方命令移除注册（如设置了 `PI_MANAGER_HOME`，替换对应路径）：

```bash
pi remove "$HOME/.pi-manager/pi-package"
```

再重启 Pi。此操作移除声明，不删除管理数据或源码。手动删除保留数据前先确认备份、停止相关进程。

## 可选维护 CLI

CLI 保留用于自动化及旧隔离 profile 维护，**不再是主要入口**；打开 `/manager` 不需要它。

```bash
node dist/index.js --help
node dist/index.js package versions review
node dist/index.js package rollback review --yes
```

旧独立 TUI 显式使用 `node dist/index.js tui`，CLI 不带参数改为显示帮助。旧 `profile run` 仍可启动隔离子进程，但 `/manager` 扩展不会调用它。CLI 修改同样需要回到 `/manager` 发布，才能影响注册的预设。

如果之前装过全局 `pi-manager`，它仅是可选维护命令，更新方式：

```bash
npm pack --offline
npm install --global ./pi-manager-1.0.0.tgz --offline --ignore-scripts --no-audit --no-fund
pi-manager install --yes
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `PI_MANAGER_HOME` | 默认 `~/.pi-manager`，不可与默认 Pi 重叠；安装及启动 Pi 时使用相同值。 |
| `PI_MANAGER_PI` | 安装器/旧 CLI 使用的 Pi 可执行文件，默认 `pi`。 |
| `PI_MANAGER_SDK_PATH` | worker 使用的公共 Pi SDK 包目录/入口；默认自动检测。 |
| `PI_MANAGER_SOURCE_AGENT_DIR` | 明确导入包时的可选来源 agent 目录；否则使用当前 Pi agent 或 `~/.pi/agent`。 |
| `PI_MANAGER_EDITOR` | 仅供旧 CLI 外部编辑；Pi 内直接使用 Pi 编辑器。 |

代理沿用进程环境，不改 npm registry 或 Pi proxy 配置。命令要求 agent 空闲，支持 Pi 交互 UI 或实现原生对话框的 RPC 客户端；print/JSON 模式不会打开管理器。打开、关闭管理器不调用模型。

## 开发和测试

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`src/` 和 `test/` 均为 TypeScript。NodeNext 的 `.js` 导入解析到 `.ts` 源码。`dist/`、`.test-dist/`、`node_modules/` 不提交 Git。

`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 运行时由 Pi 提供，声明为可选 peer 和开发依赖，**不打包额外运行时副本**。分发包包含编译产物、两种 README 和版本说明。

测试覆盖命令注册、无 UI/忙碌/重复打开防护、单页面板快捷键/搜索/选中项/缩放、发布状态比较、原生对话框/编辑器、只读包迁移和失败清理、启动快照上下文、独立发布和失败发布、版本摘要恢复、symlink 与资源过滤。真实 Pi 集成在临时 agent 目录安装，检查 `/manager` 及导出的 extension、模板和 Skill 加载，并确认返回同一会话、不调用模型。真实 npm 测试使用 loopback registry，无需模型 API key。

## 不做的功能

热卸载、runtime monkey patch、在线切换凭证/agentDir、市场索引、OS 沙箱、外部副作用回滚、任意历史选择、自动清理快照、可靠取消整棵安装子进程树、单资源精确 token 计数。

## 许可证

[MIT](LICENSE)。
