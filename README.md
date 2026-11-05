# pi-manager

**English** | [简体中文](README.zh-CN.md)

**v1.7.4 — manage Pi's global providers, models, defaults, and enabledModels from one tab or CLI.** [Release notes](CHANGELOG.md) · [GitHub Releases](https://github.com/meatRoll/pi-manager/releases)

A **Pi extension** for managing packages, skills, extensions, prompt templates, themes, preset Markdown context, and Pi's global model configuration **inside Pi**.

```text
Start Pi → /manager → manage resources → return to the same conversation
```

No separate manager process or nested Pi session is required. Written in **TypeScript** with strict type checking; uses Pi's public extension/SDK APIs only. No Pi source patches, module-cache tricks, or hot unloading.

## Install

Requires **Node.js 22.19+**, Git, and Pi. Tested with **Pi 1.3.0**.

```bash
git clone https://github.com/meatRoll/pi-manager.git ~/.pi-manager/manager
cd ~/.pi-manager/manager
node dist/index.js install --yes
```

Compiled `dist/` is committed, so a clone runs as-is and needs no build step (`npm ci` is only for development). The installer registers **two** packages with the official `pi install` command:

| Package | Contents | Updated by |
|---|---|---|
| `git:github.com/meatRoll/pi-manager` | the manager itself (`/manager`) | `pi update --extensions` |
| `~/.pi-manager/pi-package` | published resources only (packages, skills, prompts, themes, context) | **P** inside `/manager` |

**This deliberately adds two package declarations to your Pi agent settings.** It does not copy or replace existing packages, credentials, sessions, models, or project files. The checkout is only needed to run the installer; registers already skip a manager declaration that exists (`PI_MANAGER_SELF_SOURCE=none` skips it entirely).

Restart Pi in your working project:

```bash
cd /path/to/your-project
pi
```

Then type **inside Pi**:

```text
/manager
```

`npm start` simply starts normal `pi` after installation. The checkout can be deleted afterwards: the registered manager package is a Git installation owned by Pi, and the published preset is a self-contained snapshot.

### Move published snapshots to another disk

Every publication copies hundreds of megabytes and only the newest snapshot is live. Keep profiles where they are and move the publication directory once:

```bash
node dist/index.js config publish-dir /Volumes/big-disk/pi-manager-packages
node dist/index.js install --yes     # publishes there and registers the path
pi remove <the declaration it prints as superseded>
```

The saved path lives in `~/.pi-manager/state.json` and applies to every launch, including apps that start Pi without a shell. `PI_MANAGER_PUBLISH_DIR` still overrides it for a single run, and `pi-manager config publish-dir --unset` returns to the default. Run `pi-manager config` to see the effective directory, where it came from, and whether Pi is actually loading it. Publishing refuses an unreachable mount instead of recreating the directory on the boot disk.

### Clean old snapshots

Publishing keeps old snapshots so the previous startup state remains available, but it does not delete history automatically. Preview cleanup first, then add `--yes` to remove everything beyond the active snapshot and the newest retained copies:

```bash
node ~/.pi/agent/git/github.com/meatRoll/pi-manager/dist/index.js prune --keep 2
node ~/.pi/agent/git/github.com/meatRoll/pi-manager/dist/index.js prune --keep 2 --yes
```

`--keep 2` retains two snapshots total, including the snapshot currently referenced by `package.json`. The command refuses to remove anything if that active snapshot is missing. Use a larger `--keep N` when you need more rollback points.

### Update

```bash
pi update --extensions                                     # the manager (git package) + others
pi update git:github.com/meatRoll/pi-manager                # or just the manager
node ~/.pi-manager/manager/dist/index.js self-update --yes  # same thing from a checkout
```

Then restart Pi. Inside Pi the same action lives in **More → Update pi-manager from GitHub**. Resource changes are separate: stage them in `/manager` and press **P** to publish. Self-update refuses a dirty tree, a detached HEAD or an unrelated `origin` — it never merges, rebases, or touches your staged packages, resources or presets.

The GitHub repository is public. `package.json` remains `private: true` to prevent accidental npm publication: the npm name belongs to another project. **Do not use `npm install -g pi-manager` or `pi install npm:pi-manager`.** Do not also run `pi install git:github.com/meatRoll/pi-manager`: that registers a second copy of `/manager` next to the published bundle. The clone plus `install --yes` path above is the supported one.

### Network proxy

Package downloads, `npm view` inspection and self-update use the manager's proxy
mode, saved in `~/.pi-manager/state.json`:

- **System** (default): proxy variables already in Pi's environment; on macOS
  also the HTTP/HTTPS/SOCKS proxy from Network settings.
- **No proxy**: clears proxy variables for manager child processes and overrides
  Git's `http.proxy` / `https.proxy`, so a global Git proxy cannot leak in.
- **Custom**: an HTTP(S) or SOCKS URL, for example `http://127.0.0.1:7897` or
  `socks5://127.0.0.1:7897`. It overrides ambient variables and Git config.

Set it inside Pi from **More → Network proxy settings…**, or from the CLI:

```bash
pi-manager config proxy
pi-manager config proxy system
pi-manager config proxy none
pi-manager config proxy custom http://127.0.0.1:7897
```

The mode applies to manager operations only: it does not rewrite Pi's own
`httpProxy`, npm registry, or model-provider traffic. Existing `NO_PROXY` is
preserved; otherwise localhost is bypassed by default. On platforms other than
macOS, System uses the process environment, so use Custom if the OS proxy is not
exported. npm downloads work best through an HTTP proxy; SOCKS is mainly useful
for Git. No restart is required for package operations or self-update.

### Try without permanent registration

```bash
npm ci
npm run build
pi -e ./dist/extension.js
```

This provides `/manager` for one invocation only. You can edit staging profiles and publish a snapshot, but ordinary Pi starts will not load that snapshot until you run the installer. Do not load the direct extension and the registered bundle together: they both register `/manager`.

## Use inside Pi

Open `/manager`. It goes straight to your **default staging preset** (for example `mine`), falling back to an existing loaded/published preset or the first available one. If there are no presets, select **+ Create profile**. Press **S** to switch presets or create another; switching the editor does not publish or change the running Pi.

Here a profile is a **staging resource preset**, not a way to switch the running Pi's credentials, sessions, or agent directory.

```text
pi-manager / mine                         [S switch preset]
loaded: mine · next start: mine
Unpublished changes · P publish for next start

[All]  Extensions  Skills  Context  Packages  Models  More

[x] meatRoll/pi-inspect-image · src/index.ts   extensions · package · 1.0.0 · read-only
[x] handoff.ts                             extensions · standalone · owned
[x] pptx-preview                           skills · standalone · owned
[x] APPEND_SYSTEM                          context · standalone · owned

Space toggle · Enter preview · E edit · A add · P publish
←→ / Tab category · S switch preset · / search · Esc close
```

The footer is contextual: it lists only the keys that currently do something. `E edit` / `Del delete` appear only on manager-owned rows, package rows advertise `Space toggle package · Enter package menu`, and `More` rows say `Enter run action`.

- **Space** toggles the selected resource/package directly in staging. **Enter** previews a resource, or opens package actions. **E** edits an owned copy; **Del** deletes an owned copy after confirmation. External/package originals stay read-only.
- **←→** or **Tab / Shift+Tab** changes category on the same screen. **/** searches (Enter finishes searching; Enter again opens). Each category keeps its selection and search after preview, editing, or toggling. **Esc** clears search first, then closes. Preview supports `↑↓` and `PgUp` / `PgDn`.
- **A** adds to the current category; **P** publishes only after confirmation. **R** refreshes metadata after edits from another process. The terminal panel opens immediately; resource discovery and the full byte comparison run in the background. Rows become usable before that comparison finishes, and the header says **Checking publication…** until a result is known. It then marks unpublished changes or an unknown comparison instead of claiming the live session changed. Closing or switching cancels the read-only work. External local packages are references, not tracked historical copies.
- **Models** edits Pi's **global** model configuration, not the staging preset. It has its own footer (`A add provider · R reload file`), does not publish, and applies only after `/reload` or a restart. See [Models and providers](#models-and-providers-global-not-published).
- **More** groups prompt templates, themes, preset management/default selection, package import, update-all, restore, logs, network proxy, copy/delete, manager-only publication, and help.
- RPC clients receive the same flat resource list with explicit category/action dialogs; terminal-only shortcuts are not required. The first list waits only for resource metadata, not the full byte comparison. Because RPC cannot patch an open dialog, a completed check appears in the next dialog.
- Package extensions display as `package-label · src/index.ts`, so identical entry filenames are distinguishable. Git labels follow the **configured repository** (for example `meatRoll/pi-image-gen`), not a possibly inherited upstream manifest name; non-GitHub hosts stay visible. npm labels use the configured package name, including its scope. Local packages with their own Git checkout use its `origin` repository (read locally, with no network access); otherwise they use the manifest name or configured path. Parent repositories and inherited manifest repository URLs are not used. Package lists use the same labels; raw manifest names remain available in package details. Standalone filenames are unchanged. These are display labels only, not renamed files, sources, or resource IDs.
- Package-origin rows include the installed package version, for example `extensions · package · 1.0.0 · read-only`, so a stale install is visible before launch. Local checkouts without a manifest version show `local`; standalone and context rows stay unversioned.
- Skill imports select a directory containing `SKILL.md`. Resource imports copy files, so editing a manager-owned copy does not edit the original.
- User-level resources that Pi discovers on its own (for example `~/.agents/skills`) appear as `user-level · read-only`. They cannot be toggled or edited from a preset, and publication never exports them: Pi loads them in every session, so the snapshot stays self-contained.
- Package sources accept `npm:name@version`, `git:github.com/owner/repo@ref`, and local paths. Local packages remain external references: no dependency installation, copying, or deletion of their original directories.
- Package operations and deletion ask for confirmation. Installation scripts have your user permissions.

### Models and providers (global, not published)

The **Models** tab edits Pi's global model configuration, not the staging preset:
`~/.pi/agent/models.json` (or `$PI_CODING_AGENT_DIR/models.json`) and
`~/.pi/agent/settings.json`. It is never copied into a publication and does not
change the current session. Use **`/reload` or restart Pi** to apply changes.

The tab opens with separate **Providers** and **Models** entries; **Enter** opens
the list and **Esc** returns. Add providers and models with **A**; they are
shortcuts, not rows in the lists, so **A** also works when a list is empty. In
the model form, **Apply general config from model…** copies context, limits,
modalities, thinking and sampling settings from another configured model while
keeping the target's id, name, API, Base URL, headers and compatibility. On
list pages, move **up from the first row** to focus the search box: type to
filter, **Enter** leaves the box, and **Esc** clears the query or goes back. Edit
and action menus omit the search box. There is no `/` search shortcut.

- Structured editors cover provider fields (`name`, `baseUrl`, `api`, headers,
  compatibility, OAuth, `authHeader`), models, and `modelOverrides`; an advanced
  JSON editor is available for the whole file, one provider/model, or one
  override. Unknown fields are preserved.
- API keys may be literal, `$ENV_VAR`, or `!command`. A command is executed
  locally when Pi resolves the key; the editor warns before accepting one.
- **Defaults** edits `defaultProvider`, `defaultModel`, and
  `defaultThinkingLevel` for new sessions. **Enabled models** edits
  `enabledModels`, which controls startup selection and model cycling;
  `/model` still lists every available model.
- **Test endpoint…** only sends `GET {baseUrl}/models` (Anthropic-compatible
  providers use `/v1/models` when the base URL has no `/v1`; you can also enter a
  custom URL) and reports the returned models. It does not send a chat completion.
- **Fetch models from endpoint…** fetches the same list, then asks which models
  to add. Nothing is selected by default; `A` selects all new models; already
  configured models are shown disabled. Discovery fills known metadata and
  falls back to `contextWindow` 128000, `maxTokens` 16384, input `text`,
  reasoning `false`, and zero cost.
- Pi-style `//` comments and trailing commas are accepted when reading;
  structured saves write normalized JSON (the original raw file is in the
  backup). Writes are atomic, mode 0600, with a timestamped backup under
  `~/.pi-manager/backups/agent` (10 kept). If another process changed the file
  after the editor opened, the save fails with a reload prompt and does not
  overwrite it. Symlinked config files are refused.
- Network actions happen only when you choose them. OAuth providers cannot be
  auto-discovered; add models manually or use the provider's login flow.
  `auth.json` and `models-store.json` are not modified.

The same operations are available from the CLI:

```bash
pi-manager models
pi-manager models list [--json] [--reveal]
pi-manager models provider add local --base-url https://example.com/v1 \
  --api openai-completions --api-key-env LOCAL_KEY
pi-manager models add local --id fast --context-window 200000 --max-tokens 32000 \
  --input text,image --reasoning
pi-manager models default local fast --thinking high
pi-manager models enabled add 'local/*'
pi-manager models provider test local
pi-manager models provider fetch local --add new --yes
```

`--reveal` prints literal keys; `provider test/fetch` with `!command` auth
requires `--yes`. Use `pi-manager models --help` for update, remove, override,
and `edit-json` flags.

### Save, publish, restart

1. Edit packages, resource switches, and context in a staging profile.
2. Press **P** and confirm **Use on next Pi start?** (RPC: **Publish for next Pi start**).
3. Exit Pi normally and start it again. The registered local package supplies the selected extensions, skills, templates, themes, and context at startup.
4. Open `/manager` again. Its header distinguishes the **loaded** preset from the selection published for the **next start**.

Publishing **declares** the preset's packages instead of copying them. Git sources are pinned to the exact commit of the active package generation and npm sources to the installed version, then written into your Pi agent settings through Pi's own settings manager; everything the preset owns (extensions, skills, prompts, themes, context) is still copied into a detached snapshot. This keeps `owner/repo:path` labels, package grouping and `pi update` reachability instead of decaying into anonymous local paths. A package that cannot be pinned (a checkout without Git history, an unrecognized source) falls back to the copied form, so its resources never disappear. The header also compares every pinned commit with the checkout Pi actually loads, so an outside install or manual pull shows as unpublished instead of passing as the published preset. Publishing **manager only** removes the declarations the previous publication installed and leaves every other declaration untouched; a publication that fails to apply leaves the previous one active.

Publishing copies owned resource bytes into a detached snapshot. Editing or deleting the staging profile does not remove files used by the live session. External local packages remain references, so their own edits are not isolated. Publishing leaves history in place; use `pi-manager prune --keep N` to preview old snapshots and add `--yes` to remove them. The active snapshot is always protected.

A selected preset **adds managed resources to your normal Pi environment**. It does not suppress existing personal/project/shared resources, change project trust, or switch credentials/model configuration/session storage. Names can conflict with existing resources; normal Pi collision rules apply. Choose **More → Use manager only on next Pi start** to stop exporting preset resources on the next launch.

The extension does not call `/reload`, manipulate active runtime registries, or promise immediate unloading. Use a full restart after publishing, particularly for extension changes. Running `/reload` yourself uses Pi's native behavior and is not a transactional rollback.

## Import existing Pi packages

To bring the packages already declared in your personal Pi settings into the manager:

1. Create an **empty** staging profile (for example, `mine`).
2. Select **More → Import packages from current Pi**. Review the source agent directory in the confirmation.
3. Review the imported packages and resource inventory. The manager bundle itself is skipped.
4. After verification, plan the cutover: back up your source `settings.json`, explicitly remove only the migrated package declarations from that source, and publish the profile with **P → Use on next Pi start?**. Keep the manager bundle declaration and original package directories. Restart Pi and verify the loaded profile.

**Import is a read-only-source staging operation, not an automatic cutover.** It does not publish, remove default declarations, or alter the running Pi. Leaving original declarations active alongside published copies can load extensions twice and cause command/tool conflicts, including a Pi startup failure. Do not use the published copies until duplicate declarations have been explicitly dealt with. For rollback, use manager-only publication and restore the saved declarations before restarting.

Import copies the existing agent's entire owned `npm/` and `git/` trees into a validated package generation without downloads, dependency installation, or extension execution. Stop concurrent source package installs/updates while importing. Missing installations, external symlinks, or linked Git worktrees are refused rather than silently reinstalled. Package resource filters are preserved. Relative local package paths are resolved from the original settings file and remain **external references**; their files are not copied, edited, or deleted.

Only package declarations plus `npmCommand` / `httpProxy` package-manager settings are imported. Credentials, sessions, models, user instructions, standalone resources, and project configuration are not copied. Profiles with package history cannot be imported over; use a new empty profile instead.

Optional CLI equivalent (also staging-only):

```bash
node dist/index.js profile create mine
node dist/index.js migrate mine --yes
# Or specify a different existing Pi agent directory:
# node dist/index.js migrate mine /path/to/agent --yes
```

The default source is `PI_MANAGER_SOURCE_AGENT_DIR`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.

## Context

Select the **Context** tab and press **A** to create or import Markdown. Select a context and press **E** to edit the manager-owned copy in Pi's editor.

On publication, enabled context contents are bound to the same startup snapshot as the resource paths. The extension adds them through a dedicated public `before_agent_start` prompt section. It does not overwrite `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, other extensions' sections, or Pi's whole prompt.

Staging edits do not silently change an already loaded snapshot's instructions. Publish and restart to use them. Disabling context cannot remove historical messages already saved in a conversation.

## Package recovery

Package mutations use Pi's public `DefaultPackageManager` in a separate Node worker. The worker handles package files only; it is **not another Pi conversation or terminal UI**.

1. Acquire the staging profile's exclusive lease.
2. Copy owned npm/Git files into a candidate generation; never hardlink active files.
3. Install/update/remove within that candidate.
4. Validate package files, manifests, ownership, and resource paths without executing extensions.
5. Record digests and atomically replace one staging `settings.json` to select package paths and filters together. Keep the previous generation.

A failure before commit leaves active staging references and owned package bytes unchanged. **More → Package generations / restore** validates the previous digest offline and switches packages and filters back. Publish afterward and restart Pi to use the restored version.

Restore does not overwrite contexts, standalone resources, credentials, model files, sessions, or default/project configuration. External local packages restore **references only**, never historical source contents. Changed or missing owned snapshot files cause restore to fail rather than silently downloading another version.

Whole-package disable sets all four resource filters to `[]` and preserves the prior entry; enable restores its exact filters. `autoload: false` is not treated as a whole-package switch because Pi gives it different incremental-filter semantics. Updating all packages never updates Pi itself.

### Limits

- This is not an OS sandbox or host-wide transaction. Third-party extensions and scripts have your permissions; their external writes, network requests, database changes, and Pi memory state cannot be undone.
- Validation discovers resource files; it does not guarantee that third-party code or skill/theme content will load successfully at runtime.
- Internal dependency symlinks are relocated into copies; external symlinks, special files, and linked Git worktrees are refused in owned snapshots. Imported resources reject symlinks.
- An incomplete legacy baseline can initialize but is not advertised as restorable. Missing package declarations cannot be published as a misleading empty preset.
- Current/previous generation switching is supported, not arbitrary history selection. Published snapshots stay until the explicit `prune` command removes older ones, so they use extra disk space.
- Forced termination can leave `.lock` or candidate directories. Confirm all related Pi/npm/Git processes have stopped before manual cleanup. Unknown locks are never automatically stolen.
- Atomic file replacement is a publication boundary, not a whole-disk power-failure durability guarantee.

## Storage and write boundaries

```text
~/.pi-manager/
├── state.json
├── backups/agent/                  Timestamped models.json/settings.json backups
├── profiles/<name>/
│   ├── settings.json              Staging Pi package declarations and filters
│   ├── manager.json               Context/resource metadata
│   ├── resources/                 Imported, editable resource copies
│   ├── .packages/<generation>/    Owned package bytes, lockfiles, and digests
│   └── .operations/               Package logs
└── pi-package/
    ├── package.json               Atomic commit point; registered once in Pi
    └── .snapshots/<id>/           Detached package/resource files and context
```

**Installation and the Models tab are explicit exceptions to “do not change default Pi settings”:** the official `pi install` adds the local manager package declaration, and publishing applies package declarations. The Models tab separately writes `~/.pi/agent/models.json` and `settings.json` (or `$PI_CODING_AGENT_DIR`) with atomic replacement, backups under `~/.pi-manager/backups/agent`, and revision conflict checks. Other manager actions write to their own data directory.

The extension does not automatically import default Pi resources. Explicit package import is read-only on the source. It does not edit external originals, rewrite project `.pi` files, copy credentials, modify `auth.json`/`models-store.json`, change the parent shell environment, or modify Pi's source/install directory. npm/Git caches and third-party scripts can still have external side effects.

The current Pi continues to use its normal authentication and sessions. Old CLI-created isolated profile credentials/sessions are not adopted or shared by the in-Pi extension. Profile mutation locks still apply when a legacy manager-launched Pi uses that staging directory; externally launched processes cannot be detected reliably.

## Update and uninstall

After updating the checkout:

```bash
npm ci
npm run install:pi -- --yes
# Restart Pi
```

Remove the registered package using Pi's official command (substitute the path if `PI_MANAGER_HOME` differs):

```bash
pi remove "$HOME/.pi-manager/pi-package"
```

Restart Pi. This removes the declaration, not your managed data or source checkout. Review backups and stop relevant processes before manually deleting retained data.

## Optional maintenance CLI

The command-line interface remains for automation and legacy isolated-profile users. It is **not the primary interface** and is not needed to open `/manager`.

```bash
node dist/index.js --help
node dist/index.js package versions review
node dist/index.js package rollback review --yes
```

The old standalone UI is explicitly `node dist/index.js tui`. Running the CLI without arguments prints help rather than launching a separate TUI. Legacy `profile run` still launches an isolated Pi child; the `/manager` extension never uses it. Resource/package CLI changes also need publication from `/manager` before they affect the registered preset; `pi-manager models` writes the global model config directly and needs only `/reload` or a restart.

If you previously installed a global `pi-manager` command, it is optional. To update that maintenance command after building:

```bash
npm pack --offline
npm install --global ./pi-manager-1.0.0.tgz --offline --ignore-scripts --no-audit --no-fund
pi-manager install --yes
```

## Environment

| Variable | Purpose |
|---|---|
| `PI_MANAGER_HOME` | Manager data; default `~/.pi-manager`, must not overlap default Pi. Use the same value during install and Pi startup. |
| `PI_CODING_AGENT_DIR` | Pi's agent directory; the Models tab reads and writes `models.json` and `settings.json` there. Default `~/.pi/agent`. |
| `PI_MANAGER_PI` | Pi executable used by installer/legacy CLI; default `pi`. |
| `PI_MANAGER_SDK_PATH` | Public installed Pi SDK package/entry for worker operations; otherwise detected automatically. |
| `PI_MANAGER_SOURCE_AGENT_DIR` | Optional source agent directory for explicit package import; otherwise the current Pi agent or `~/.pi/agent`. |
| `PI_MANAGER_EDITOR` | External editor for the legacy CLI and `pi-manager models edit-json`. In-Pi editing uses Pi's editor. |

Manager network proxy is configured from **More → Network proxy settings…** or `pi-manager config proxy`; it is separate from Pi's `httpProxy` and model-provider traffic. Model endpoint Test/Fetch uses the Pi process's network settings, not this proxy mode. The command requires an idle session and interactive Pi UI; an RPC client supporting native dialogs also works. Print/JSON mode does not open the manager. Opening or closing it makes no model call.

## Development and tests

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`src/` and `test/` are TypeScript. NodeNext imports use `.js` extensions resolved to `.ts` sources. `dist/`, `.test-dist/`, and `node_modules/` are not committed.

Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at runtime. They are optional peers and development-only dependencies, **not bundled runtime copies**. Distribution archives include compiled files, both READMEs, and the changelog.

Tests cover command registration, non-UI/busy/reentrant guards, flat dashboard shortcuts/search/selection/resize, publication-status comparisons, native dialog/editor flows, read-only package migration and failure cleanup, snapshot context binding, detached publication, failed publications, package digests/recovery, symlink protection, resource filters, global model config validation/conflicts/backups, model discovery, and the Models tab and CLI. Real Pi integration installs into a temporary agent directory and checks that `/manager`, exported extensions, prompts, and skills load and the command returns to the same session without a model call. npm lifecycle tests use an in-process loopback registry. No model API key is needed.

## Out of scope

Hot unloading, runtime monkey patches, live credential/agent-directory switching, marketplace indexing, OS sandboxing, rollback of external side effects, arbitrary history selection, automatic snapshot cleanup, reliable cancellation of entire installer process trees, and exact per-resource token counts.

## License

[MIT](LICENSE).
