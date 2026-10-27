# Changelog

## v1.3.2 — The publish directory is remembered

v1.3.1 could only redirect publications through an environment variable, so any
launch without it (an app, launchd, an older shell) still read the default path.

### Features

- `pi-manager config publish-dir <path>` saves the publish directory in `state.json`. Precedence is `PI_MANAGER_PUBLISH_DIR`, then saved state, then `<manager home>/pi-package`; `install --yes` saves an exported value and `config publish-dir --unset` returns to the default.
- `pi-manager config` reports the effective layout, where the publish directory came from, whether Pi is registered to load it, and which declarations are superseded. Those declarations are now printed as absolute paths because `pi remove` resolves relative ones against the working directory.
- Publishing refuses an unreachable publish directory (missing or unwritable mount) instead of silently recreating it on the boot disk. A malformed `state.json` falls back to the default rather than breaking loading.

## v1.3.1 — Published snapshots can live on another disk

### Features

- `PI_MANAGER_PUBLISH_DIR` moves only the publication directory (about 440 MB per publish) while profiles stay in the manager home. Writes stay confined to the manager home plus that directory, and the path may not overlap `~/.pi`, the profiles directory, or the manager home itself.
- `install --yes` reports superseded `pi-package` declarations so a moved publication directory can be re-registered with `pi remove` + `install --yes` instead of silently loading two bundles.

## v1.3.0 — The manager installs as its own package

`pi update` can update the manager itself again, and a published snapshot no longer pins one checkout path.

### Features

- The manager registers as its own Pi package (`git:github.com/meatRoll/pi-manager`) instead of generating an `extension.mjs` entry inside every snapshot. `pi update --extensions` (or `pi update <source>`) fast-forwards it like any other Git package, and deleting or moving a checkout no longer strands a published preset.
- The extension reads the `piManager` binding (profile, manager home, published context) from the published bundle on first use and caches it, so "one publication per session" still holds. Publishing now exports resources only.
- `install --yes` registers both packages, skips a manager declaration that already exists, and honours `PI_MANAGER_SELF_SOURCE` (`none` skips the self install). The installer is now the only step that needs the checkout.
- Migration skips an installed `pi-manager` package: importing it would load a second `/manager`.
- Self-update ignores a `package-lock.json` rewrite: Pi runs `npm` when it registers a package, so the lockfile is never a meaningful local change.

## v1.2.0 — Installs straight from Git

Compiled `dist/` now ships in the repository, so a clone runs without a build step, and the manager can update itself from GitHub.

### Features

- `pi-manager self-update --yes` and **More → Update pi-manager from GitHub** fast-forward the manager checkout with `git pull --ff-only`, republish the current preset so the next Pi start loads the same installation, and refuse a dirty tree, a detached HEAD or an unrelated remote instead of merging anything.
- `dist/` is committed: `npm ci` and `npm run build` are development-only steps, and `git pull` alone updates an installation.

## v1.1.0 — Honest dashboard and self-contained publications

Keyboard hints now follow the selected category and row, disabled-package errors say what to do,
publication snapshots no longer reference user-level resources that Pi loads on its own, and the
SDK lookup understands wrapper installations.

### Fixes

- The dashboard footer is now contextual: it only lists shortcuts that apply to the current category and selected row. Package rows advertise their own menu, `More` rows run actions, and `E edit` / `Del delete` appear only for manager-owned copies instead of on every screen.
- Toggling a resource that belongs to a disabled package now explains that the package must be enabled first (Packages tab) instead of the misleading "Enable the package before editing its resources".
- User-level resources Pi auto-discovers (for example `~/.agents/skills`) are labelled `user-level`, are no longer toggleable from a preset, and are excluded from publication snapshots and from the "unpublished changes" comparison. Pi loads them in every session anyway, so exporting them only produced a live path outside the otherwise detached snapshot.
- The migration test no longer depends on resources that happen to exist in the developer's home directory.

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
