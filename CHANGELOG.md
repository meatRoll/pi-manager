# Changelog

## Unreleased — `/` focuses the search box from any row

Search was only reachable by pressing **↑** from the first row, so editing a
filter deep in a long list of skills, models or rows meant scrolling all the way
back to the top. **`/`** now focuses the search box from any row in `/manager`
and in every chooser, matching the footer hint the documentation already
advertised. Moving up from the first row still works.

## v2.1.0 — unmanaged packages can be adopted in one step

`doctor` could only report this drift: a package Pi declared directly was outside
the preset, and the fix it suggested (`migrate`) requires an empty preset, so it
never applied to the setups that actually hit the warning.

- **`pi-manager adopt [--profile <name>] [--json] --yes`** stages each source Pi
declares outside the active publication, keeps the filters and disabled state the
user already had, and publishes once. Activation replaces the matching direct
declaration in place, so nothing loads twice; a failed adoption leaves that
declaration untouched.
- The same action is **A** on **More → Doctor**, with a confirmation that lists
the exact sources and explains that install scripts run with the user's
permissions.
- **`doctor --json`** now includes the structured `unmanaged` entries, so an
agent can act on the report instead of scraping the finding text.

## v2.0.0 — agents can install packages without the TUI

`/manager` was the only path that could stage *and* publish, and the CLI stopped
after staging, so an agent asked to install a package had no reachable action
and fell back to `pi install` — which bypasses snapshots, generations and
rollback. This release makes the same transaction callable headlessly, tells
agents about it, and makes drift visible from both interfaces.

- **`pi-manager add <source>… [--profile <name>] [--publish] [--json] --yes`**
  stages npm/Git/local sources in a preset and, with `--publish`, activates the
  snapshot for the next start. Without `--profile` it uses the saved default
  preset and always reports which preset it used. `--yes` acknowledges
  third-party code only and never implies `--publish`.
- **`--dry-run`** on `add` and `publish` resolves sources, compares them with
  the staged preset and the active publication, and writes nothing. It needs no
  acknowledgement, so an agent can show a plan before running install scripts.
- **`pi-manager publish`** is the CLI form of **P**. A failed `add --publish`
  keeps the staged generation, returns `publishError` and exits non-zero.
- **`pi-manager doctor [--json]`** is a read-only drift report: publication
  state, package declarations written outside the manager, a missing snapshot,
  a leftover profile lock, and a bundle registered for another
  `PI_MANAGER_HOME`. The same report is in **More → Doctor** inside `/manager`.
- The package now ships **`skills/pi-manager`** through `pi.skills`, so Pi
  advertises it in every session. It routes "install a package / 装插件" to
  `pi-manager add … --publish` and explicitly rules out `pi install`,
  `pi remove` and hand-edited settings.

## v1.7.5 — A adds packages from every tab

Pressing **A** on Extensions, Skills, Prompt templates or Themes jumped straight
to **Import local resource copy**, and **Packages** was the only tab that asked
for a package source, so adding a package looked impossible from anywhere else.
Those tabs now offer `+ Import local copy (…)` next to `+ Add package`; the
**Context** tab adds `+ Add package` to its existing create/import menu; and
**Packages** still prompts directly. The footer names what **A** does on the
current tab (`A add package`, otherwise `A add…`) instead of a generic `A add`.

## v1.7.4 — Fetched-model checklists open on a selectable row

The fetch checklist now starts on the first model that can still be added. If
the first returned models are already configured, Space previously did nothing
because the cursor sat on a disabled row. When every returned model is already
configured, or the endpoint returns none, the checklist is skipped with a
notice instead of opening a list where nothing can be selected.

## v1.7.3 — Selecting a fetched model no longer jumps the list

Toggling a model in the **Fetch models from endpoint…** checklist rebuilt the
list from the first row, so adding several models meant scrolling back after
every Space. The checklist now keeps the cursor on the row that was toggled;
**A**, **N**, filtering and terminal resizes keep it in place too.

## v1.7.2 — The Models editor workflow is finished

This release carries the v1.7.0 global model-configuration feature and the
v1.7.1 publication reconciliation fix, and finishes the Models tab workflow.

- Providers and Models open as separate pages. **A** adds providers/models;
  list rows contain only data, including when a list is empty. The empty
  provider-models view stays open, and **A** adds a model to that provider.
- Lists focus search by moving Up from the first row. Edit and action menus omit
  search, and `/` is no longer a search shortcut.
- Model menus and forms can copy general capabilities from another configured
  model: context/output limits, input limits, modalities, reasoning/thinking,
  cost, cache and sampling. The target's id, name, API, Base URL, headers and
  compatibility stay unchanged.
- The Models tab still cannot switch presets or publish.

## v1.7.1 — Published refs are the refs Pi actually runs

Two gaps in v1.6.0's declarations could leave the running checkout different from
the publication without saying so.

- The installer now reconciles pinned checkouts (`install: true`). Before, a
  `pi install` run republished the declarations but left Pi's copy at whatever
  commit an outside install or manual pull had left it on.
- Publication status compares each pinned Git commit with the checkout Pi loads.
  A drifted copy now reads as **unpublished** instead of claiming the preset is
  current, so `P` re-aligns it.

## v1.7.0 — Pi model configuration is managed from one place

The new **Models** tab and `pi-manager models` CLI edit Pi's global
`models.json` and the model-related keys in `settings.json`. This is agent
configuration, not a staging preset: it is never published, and changes do not
alter the current session.

### Features

- The **Models** tab opens with separate **Providers** and **Models** pages.
  Add providers/models with **A** instead of list rows, including on empty lists
  and from the empty provider-models view. Model menus/forms can copy general
  capabilities from another configured model while preserving the target id,
  name, API, Base URL, headers and compatibility. List pages
  focus search with Up from the first row; edit and action menus omit search,
  and `/` is no longer a shortcut.
- Manage providers, models, and `modelOverrides` with structured forms or
  advanced JSON. Provider keys can be literal, `$ENV_VAR`, or `!command`; the
  command form explicitly warns that it runs locally. Unknown JSON fields are
  preserved.
- Edit `defaultProvider` / `defaultModel` / `defaultThinkingLevel` for new
  sessions, and `enabledModels` for startup selection and model cycling.
  `/model` availability is unchanged.
- **Test endpoint…** sends only `GET {baseUrl}/models` and reports the response.
  **Fetch models from endpoint…** then asks which returned models to add:
  nothing is selected by default, `A` selects all new models, and configured
  models are disabled. Discovery fills known metadata and uses 128000 context,
  16384 output tokens, text-only input, no reasoning, and zero cost when values
  are missing.
- `pi-manager models list|show|validate|edit-json|default|enabled` plus
  `provider add|update|remove|test|fetch`, model `add|update|remove`, and
  `override set|remove`. `--json` and `--reveal` are available for inspection;
  destructive commands require `--yes`.

### Safety

- Pi-style `//` comments and trailing commas are accepted when reading; structured
  saves write normalized JSON and keep the original raw file in the backup.
- Atomic 0600 writes through a temporary file, timestamped backups under
  `~/.pi-manager/backups/agent` (10 kept), and SHA-256 revision checks that fail
  instead of overwriting a file changed outside the manager. Symlinked config
  files are refused.
- No automatic network request, model call, `/reload`, or session-model switch.
  OAuth providers are not auto-discovered; manual model entries remain
  available. `auth.json` and `models-store.json` are untouched.

## v1.6.0 — Publications declare packages instead of copying them

A snapshot used to flatten every package resource into a copied file path, which
lost the declaring repository: labels decayed from `owner/repo:path` to a bare
filename, package grouping disappeared, and `pi update` could no longer reach
them. Publication now exports **declarations**, format 2.

### Features

- Publishing writes the preset's packages into Pi's agent settings through Pi's
  public settings manager, pinning Git sources to the exact commit of the active
  package generation and npm sources to the installed version. Resource filters
  and the settings order are preserved, and declarations a previous publication
  installed are replaced instead of being duplicated.
- Resources the preset owns, plus any package that cannot be pinned (a checkout
  without Git history, an unrecognized source), are still copied into the
  detached snapshot, so a publication never drops resources.
- Manager-only publication removes the declarations the previous publication
  installed and leaves every other declaration untouched.
- The dashboard compares pinned refs as well as files, so a moved commit reads as
  an unpublished change, and the publish confirmation says how many declarations
  will be applied.

### Fixes

- Publishing still refuses to overwrite a publication format newer than this build
  can write, but a format it can produce is now read and rewritten normally.

## v1.5.1 — A newer publication no longer breaks /manager

A build that publishes format 2 (package declarations) left this version unable to
read the active export, so `/manager` failed with "Invalid pi-manager export".

### Fixes

- Both publication readers accept format 1 and format 2 exports, as long as the
  binding names this manager home and a usable snapshot id. Unknown fields are
  ignored rather than rejected.
- Publishing refuses to overwrite a format this build cannot write, so the
  declarations a newer publication installed are never silently dropped.
  `install --yes` still registers both packages and reports that the existing
  publication was left untouched, and self-update surfaces the same reason.

## v1.5.0 — Package downloads can use a managed proxy

GitHub packages could fail when Pi was launched without shell proxy variables,
while a stale global Git `http.proxy` could keep forcing a dead proxy even after
the environment changed.

### Features

- New manager proxy modes: **System** (default; environment variables, plus the
  HTTP/HTTPS/SOCKS proxy from macOS Network settings), **No proxy** (clears
  ambient variables and overrides Git's `http.proxy` / `https.proxy`), and
  **Custom** (an HTTP(S) or SOCKS URL that overrides both).
- The mode applies to package add/update/remove workers, `npm view` inspection,
  self-update, and installer package operations. It does not rewrite Pi's own
  `httpProxy`, npm registry, or model-provider traffic.
- Set it from **More → Network proxy settings…**, the legacy TUI, or
  `pi-manager config proxy [none|system|custom <url>]`. Existing `NO_PROXY` is
  preserved; localhost is bypassed by default. Changes apply without restart.

## v1.4.0 — Installed plugin versions are visible

Package-origin rows stopped at `extensions · package · read-only`, so a stale
extension looked identical to a current one.

### Features

- Dashboard and standalone TUI resource rows now include the installed package
  version, for example `extensions · package · 1.0.0 · read-only`. Local
  checkouts without a manifest version show `local`; standalone and context
  files remain unversioned.
- The version comes from the staging profile inventory, matching the Packages
  tab, so it describes what the next publication would load rather than the
  currently running session.

## v1.3.3 — Old publication snapshots can be pruned

### Features

- `pi-manager prune [--keep N]` previews old publication snapshots; add `--yes` to remove them. The retention count includes the active snapshot, which is always protected, and cleanup refuses to proceed if the active snapshot is missing.
- The default retention is two snapshots, while a larger `--keep N` preserves more rollback points. Publication itself does not delete history.

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

### v2.1.0 — 不在管理器管辖下的包可以一步收编

`doctor` 以前只能报告这种漂移：Pi 直接声明的包不在预设里；而它建议的修法
（`migrate`）要求预设为空，所以恰恰对真正遇到该警告的配置不适用。

- **`pi-manager adopt [--profile <name>] [--json] --yes`** 把 Pi 直接声明、但
不在当前发布里的来源逐个暂存，保留用户原本的过滤器和禁用状态，最后发布一次。
激活会按 identity 原地替换对应的直接声明，不会重复加载；某个包收编失败时，它的
直接声明保持原样。
- `/manager` 的 **More → Doctor** 里按 **A** 是同一动作，确认框会列出具体来源，
并说明安装脚本以用户权限运行。
- **`doctor --json`** 现在包含结构化的 `unmanaged` 条目，agent 可以直接据其行动，
不再需要解析提示文本。

### v2.0.0 — agent 不必打开 TUI 也能装包

此前只有 `/manager` 能同时完成「暂存 + 发布」，CLI 到暂存就停了。于是 agent
被要求装包时没有任何可调用的动作，只能退回 `pi install` —— 绕过快照、generation
和回滚。这个版本把这套事务变成可 headless 调用的，同时让 agent 知道它、让两个
界面都能看见漂移。

- **`pi-manager add <source>… [--profile <name>] [--publish] [--json] --yes`**
  把 npm/Git/本地来源暂存进预设；带 `--publish` 时同时激活下一次 Pi 启动的快照。
  不给 `--profile` 就用已保存的默认预设，并且总会报告实际用了哪个。`--yes` 只表示
  接受第三方代码，不隐含 `--publish`。
- **`--dry-run`**（`add` 与 `publish`）解析来源、与暂存预设和当前发布比较，不写
  任何东西，也不需要 `--yes`，因此 agent 可以在执行安装脚本前先给出计划。
- **`pi-manager publish`** 是 **P** 的命令行形式。`add --publish` 发布失败会保留
  已暂存的 generation，返回 `publishError` 并非零退出。
- **`pi-manager doctor [--json]`** 是只读漂移报告：发布状态、绕过管理器写入 Pi 的
  包声明、快照缺失、残留的预设 `.lock`、bundle 注册在另一个 `PI_MANAGER_HOME` 下。
  `/manager` 的 **More → Doctor** 展示同一份报告。
- 包内通过 `pi.skills` 附带 **`skills/pi-manager`**，Pi 在每次会话都会宣告它。它把
  “装包 / 装插件” 路由到 `pi-manager add … --publish`，并明确排除 `pi install`、
  `pi remove` 和手改 settings。

### v1.7.5 — 每个页签按 A 都能加包

在 Extensions、Skills、Prompt templates、Themes 按 **A** 会直接跳到 **Import local
resource copy**，而询问包来源的入口只存在于 **Packages** 页签，因此在其他页签装包
看起来根本不可能。现在这些页签会同时给出 `+ Import local copy (…)` 与 `+ Add
package`；**Context** 页签在原有的新建/导入菜单里多了 `+ Add package`；**Packages**
仍直接询问来源。页脚也会按当前页签说明 **A** 的作用（`A add package`，其余为
`A add…`），不再笼统显示 `A add`。

### v1.7.4 — 拉取模型的清单从可选行开始

拉取模型的清单现在会从第一个尚未配置的模型开始，所以即使返回列表开头都是已配置
模型，按 Space 也能立即勾选。若返回的模型全部已配置（或返回为空），不再打开无法
勾选的清单，而是直接提示。

### v1.7.3 — 拉取模型后勾选不再跳回列表顶部

在 **Fetch models from endpoint…** 的模型清单里按 Space 勾选后，列表会从第一行
重建，批量添加时每次都要重新滚动。现在勾选、**A**、**N**、搜索过滤和终端尺寸
变化都会保留当前行。

### v1.7.2 — Models 编辑流程完成

本版本包含 v1.7.0 的全局模型配置功能、v1.7.1 的发布引用修复，并完成 Models
分类的交互整理。

- **Providers** 和 **Models** 分成独立页面；使用 **A** 添加 provider/model，列表里只有
  数据项，空列表也适用。空 provider 的 models 页面会保持打开，按 **A** 直接给该
  provider 添加模型。
- 列表在第一行按 **↑** 聚焦搜索；编辑和操作菜单不显示搜索框，`/` 不再是搜索快捷键。
- 模型菜单和编辑表单可以复制另一个已配置模型的通用能力配置：上下文/输出限制、
  输入限制、多模态、reasoning/thinking、cost、cache 和采样参数。目标模型的 id、
  name、API、Base URL、headers 和 compatibility 保持不变。
- Models 分类仍然不能切换预设或发布。

### v1.7.0 — 统一管理 Pi 模型配置

新增 **Models** 分类和 `pi-manager models` CLI，直接管理 Pi 全局的
`models.json`，以及 `settings.json` 中的模型相关键。它属于 agent 配置，不属于暂存
预设，不会发布，也不会改变当前会话。

- 用结构化表单或高级 JSON 管理供应商、模型和 `modelOverrides`。API key 支持
  literal、`$ENV_VAR`、`!command`；命令形式会明确提示将在本机执行。未知 JSON 字段保留。
- 编辑新会话的 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`，以及控制启动
  选择和模型循环的 `enabledModels`；不改变 `/model` 的可用列表。
- **Test endpoint…** 只发送 `GET {baseUrl}/models`；**Fetch models from endpoint…**
  拉取后让你勾选要添加的模型，默认不选，`A` 全选新模型，已配置模型禁用。缺失元数据回退为
  128000 context、16384 maxTokens、纯文本输入、无 reasoning、cost 全 0。
- `pi-manager models list|show|validate|edit-json|default|enabled`，以及
  `provider add|update|remove|test|fetch`、模型 `add|update|remove` 和
  `override set|remove`。支持 `--json`、`--reveal`；破坏性操作需要 `--yes`。
- 读取支持 Pi 风格的 `//` 注释和尾随逗号；结构化保存写规范 JSON，原始文件保留在备份中。
- 原子写入（0600）、`~/.pi-manager/backups/agent` 时间戳备份（保留 10 份）和 SHA-256
  版本校验；文件被外部修改时直接失败而不是覆盖，symlink 配置会被拒绝。
- 不自动联网、不发送对话请求、不自动 `/reload`、不切换当前会话模型；OAuth 供应商不支持
  自动发现；不修改 `auth.json` 和 `models-store.json`。

### v1.5.0 — 包下载可走受管代理

- 新增**系统代理**、**不使用代理**、**自定义代理**三种模式。系统模式在 macOS 上读取“网络”设置，其他平台读取环境变量。
- 作用于包的安装/更新/删除、`npm view` 检查、自更新和安装器；不修改 Pi 自己的 `httpProxy` 或模型请求。
- 在 **More → Network proxy settings…** 或 `pi-manager config proxy ...` 中设置，无需重启。

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
