# Changelog

## v1.0.0 — First stable release

The first stable release of **pi-manager**, a resource manager that runs inside Pi through `/manager`.

### Features

- A native, single-page dashboard that opens the default staging preset directly. Browse categories, search, toggle resources and packages, preview files, edit owned copies, and publish without leaving the conversation. RPC clients have an explicit dialog fallback.
- Progressive loading: the terminal panel appears before discovery completes, and publication comparison runs in the background. Closing or switching cancels read-only work before any action writes files.
- Management of packages, extensions, skills, prompt templates, themes, and Markdown context. Display labels distinguish package entry paths, prefer configured Git repositories over upstream manifest names, and use a local checkout's own Git `origin` when available.
- Explicit import of already installed personal Pi packages into an empty staging preset, preserving resource filters without downloading dependencies or executing extensions. Source declarations stay unchanged; local packages remain external references.
- Detached publication snapshots for the next Pi start, including owned package/resource files and enabled context. Staging edits do not overwrite resources used by the current session.
- Candidate package generations with validation, content digests, atomic selection, and offline restoration of the previous package generation and its filters.
- Staging/published status comparison, confirmation for destructive operations, read-only external resources, symlink checks, and failure cleanup.
- Strict TypeScript, bilingual documentation, and an optional maintenance CLI.

### Compatibility and boundaries

- Requires Node.js 22.19+, Git, and Pi; tested with Pi 1.3.0.
- Uses public Pi extension/SDK APIs. No Pi source patches, module-cache manipulation, automatic reload, or hot unloading.
- Uses the existing Pi authentication and conversation. Installation explicitly registers one local manager package; routine manager operations use the manager-owned data directory.
- Imports do not automatically remove source package declarations. Review duplicates before publishing imported copies to avoid loading extensions twice.
- External local packages are references, not historical copies. Recovery cannot undo external side effects. Publish and fully restart Pi to apply resource changes reliably.
- The repository is public, but the package remains private to prevent accidental publication under an unrelated npm name. Install from the checkout using the README; do not install the npm package named `pi-manager`.

### Verification

- Strict type checking and production build.
- 82 automated tests covering the dashboard, cancellation, migration, source-aware labels, publication, package recovery, isolation, and real Pi integration without model calls.

## 简体中文

### v1.0.0 — 首个正式版本

这是 **pi-manager** 的首个正式版：在 Pi 内输入 `/manager` 管理资源，不需要另开管理器或嵌套会话。

- **单页面板**：直接进入默认暂存预设，提供分类、搜索、启停、预览、编辑副本和确认发布；RPC 客户端使用对话框。
- **渐进加载**：面板先显示，资源发现和发布内容比较在后台完成；关闭或切换会取消只读工作，文件修改在后台工作结束后执行。
- **统一资源管理**：管理包、Extensions、Skills、模板、主题和 Markdown 上下文。Git 标签优先使用配置仓库，本地 Git 包读取自身 `origin`，包内入口显示相对路径。
- **明确导入已有包**：将个人 Pi 已安装包导入空暂存预设，保留过滤器，不联网下载、不执行扩展，不删除来源声明；本地包保持外部引用。
- **独立发布快照**：受管包、资源和启用的上下文绑定到下次启动快照，继续编辑暂存不会覆盖当前会话使用的文件。
- **包版本恢复**：通过候选版本代、内容摘要和原子切换管理包，支持离线恢复上一代包与过滤配置。
- **保护边界**：发布状态比较、破坏性操作确认、外部资源只读、symlink 检查和失败清理；只使用 Pi 公共接口，不修改 Pi 源码、不自动 reload、不做热卸载。
- **运行要求**：Node.js 22.19+、Git、Pi；已在 Pi 1.3.0 验证。沿用当前 Pi 登录与会话，日常管理数据写入管理器目录。
- **使用注意**：导入不会自动移除旧声明，发布副本前需处理重复加载。本地外部包不保存历史文件，无法回滚外部副作用；发布后完整重启 Pi。仓库公开，但不发布到同名 npm 包，请按 README 安装。
- **验证**：严格类型检查、生产构建及 82 项自动化测试，覆盖面板、取消、迁移、仓库标签、快照、恢复和无模型调用的真实 Pi 集成。
