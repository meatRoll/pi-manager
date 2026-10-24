# pi-manager

**English** | [简体中文](README.zh-CN.md)

A **Pi extension** for managing packages, skills, extensions, prompt templates, themes, and preset Markdown context **inside Pi**.

```text
Start Pi → /manager → manage resources → return to the same conversation
```

No separate manager process or nested Pi session is required. Written in **TypeScript** with strict type checking; uses Pi's public extension/SDK APIs only. No Pi source patches, module-cache tricks, or hot unloading.

## Install

Requires **Node.js 22.19+** and Pi. Tested with **Pi 1.3.0**.

```bash
git clone https://github.com/meatRoll/pi-manager.git
cd pi-manager
npm ci
npm run install:pi -- --yes
```

The installer builds the project, creates a manager-owned local Pi package under `~/.pi-manager/pi-package`, then registers it with the official `pi install <path>` command. **This deliberately adds one package declaration to your Pi agent settings.** It does not copy or replace existing packages, credentials, sessions, models, or project files.

Restart Pi in your working project:

```bash
cd /path/to/your-project
pi
```

Then type **inside Pi**:

```text
/manager
```

`npm start` simply starts normal `pi` after installation. Keep the checkout in place because the registered package points to its compiled implementation. After moving it or updating the code, run `npm ci` and `npm run install:pi -- --yes` again, then restart Pi.

The GitHub repository is public. `package.json` remains `private: true` to prevent accidental npm publication: the npm name belongs to another project. **Do not use `npm install -g pi-manager` or `pi install npm:pi-manager`.** Installing the raw Git URL is not the supported setup path because generated `dist/` files are not committed; use the checkout/build/install commands above.

### Try without permanent registration

```bash
npm ci
npm run build
pi -e ./dist/extension.js
```

This provides `/manager` for one invocation only. You can edit staging profiles and publish a snapshot, but ordinary Pi starts will not load that snapshot until you run the installer. Do not load the direct extension and the registered bundle together: they both register `/manager`.

## Use inside Pi

Open `/manager`, select **+ Create profile**, then enter a name such as `review`.

Here a profile is a **staging resource preset**, not a way to switch the running Pi's credentials, sessions, or agent directory.

```text
/manager
├── review                         Staging resource preset
│   ├── Use on next Pi start       Publish a detached snapshot
│   ├── Packages                   Add / update / enable / disable / remove
│   ├── Skills
│   ├── Context files              Create / import / edit inside Pi
│   ├── Extensions
│   ├── Prompt templates
│   ├── Themes
│   ├── All resources              Preview / toggle / edit owned copies
│   ├── Package generations / restore
│   ├── Package operation logs
│   ├── Copy profile
│   └── Delete staging profile
├── + Create profile
├── Use manager only on next Pi start
└── About / loading instructions
```

- Use Pi-native lists, input dialogs, and the multi-line editor. `Enter` opens an item; `/` searches (press Enter to finish searching, then again to open). `Esc` returns or clears search first. Preview screens support `↑↓` and `PgUp` / `PgDn`.
- Package detail and resource menus contain explicit **Enable / Disable** actions. The standalone UI's Space-toggle behavior is not required here.
- Skill imports select a directory containing `SKILL.md`. Resource imports copy files, so editing a manager-owned copy does not edit the original.
- Package sources accept `npm:name@version`, `git:github.com/owner/repo@ref`, and local paths. Local packages remain external references: no dependency installation, copying, or deletion of their original directories.
- Package operations and deletion ask for confirmation. Installation scripts have your user permissions.

### Save, publish, restart

1. Edit packages, resource switches, and context in a staging profile.
2. Select **Use on next Pi start (publish snapshot)**.
3. Exit Pi normally and start it again. The registered local package supplies the selected extensions, skills, templates, themes, and context at startup.
4. Open `/manager` again. Its header distinguishes the **loaded** preset from the selection published for the **next start**.

Publishing copies owned package/resource bytes into a detached snapshot. Editing or deleting the staging profile does not remove files used by the live session. External local packages remain references, so their own edits are not isolated. Snapshots currently have no automatic garbage collection.

A selected preset **adds managed resources to your normal Pi environment**. It does not suppress existing personal/project/shared resources, change project trust, or switch credentials/model configuration/session storage. Names can conflict with existing resources; normal Pi collision rules apply. Choose **Use manager only on next Pi start** to stop exporting preset resources on the next launch.

The extension does not call `/reload`, manipulate active runtime registries, or promise immediate unloading. Use a full restart after publishing, particularly for extension changes. Running `/reload` yourself uses Pi's native behavior and is not a transactional rollback.

## Context

Create or import Markdown under **Context files**. The native Pi editor edits the manager-owned copy.

On publication, enabled context contents are bound to the same startup snapshot as the resource paths. The extension adds them through a dedicated public `before_agent_start` prompt section. It does not overwrite `AGENTS.md`, `CLAUDE.md`, `SYSTEM.md`, other extensions' sections, or Pi's whole prompt.

Staging edits do not silently change an already loaded snapshot's instructions. Publish and restart to use them. Disabling context cannot remove historical messages already saved in a conversation.

## Package recovery

Package mutations use Pi's public `DefaultPackageManager` in a separate Node worker. The worker handles package files only; it is **not another Pi conversation or terminal UI**.

1. Acquire the staging profile's exclusive lease.
2. Copy owned npm/Git files into a candidate generation; never hardlink active files.
3. Install/update/remove within that candidate.
4. Validate package files, manifests, ownership, and resource paths without executing extensions.
5. Record digests and atomically replace one staging `settings.json` to select package paths and filters together. Keep the previous generation.

A failure before commit leaves active staging references and owned package bytes unchanged. **Package generations / restore** validates the previous digest offline and switches packages and filters back. Publish afterward and restart Pi to use the restored version.

Restore does not overwrite contexts, standalone resources, credentials, model files, sessions, or default/project configuration. External local packages restore **references only**, never historical source contents. Changed or missing owned snapshot files cause restore to fail rather than silently downloading another version.

Whole-package disable sets all four resource filters to `[]` and preserves the prior entry; enable restores its exact filters. `autoload: false` is not treated as a whole-package switch because Pi gives it different incremental-filter semantics. Updating all packages never updates Pi itself.

### Limits

- This is not an OS sandbox or host-wide transaction. Third-party extensions and scripts have your permissions; their external writes, network requests, database changes, and Pi memory state cannot be undone.
- Validation discovers resource files; it does not guarantee that third-party code or skill/theme content will load successfully at runtime.
- Internal dependency symlinks are relocated into copies; external symlinks, special files, and linked Git worktrees are refused in owned snapshots. Imported resources reject symlinks.
- An incomplete legacy baseline can initialize but is not advertised as restorable. Missing package declarations cannot be published as a misleading empty preset.
- Current/previous generation switching is supported, not arbitrary history selection. Generations and published snapshots are retained and use extra disk space.
- Forced termination can leave `.lock` or candidate directories. Confirm all related Pi/npm/Git processes have stopped before manual cleanup. Unknown locks are never automatically stolen.
- Atomic file replacement is a publication boundary, not a whole-disk power-failure durability guarantee.

## Storage and write boundaries

```text
~/.pi-manager/
├── state.json
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

**Installation is the explicit exception to “do not change default Pi settings”:** the official `pi install` adds the local manager package declaration. After registration, manager actions write to their own data directory, not repeatedly to default Pi settings.

The extension does not import existing default Pi resources into managed profiles, edit external originals, rewrite project `.pi` files, copy credentials, change the parent shell environment, or modify Pi's source/install directory. npm/Git caches and third-party scripts can still have external side effects.

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

The old standalone UI is explicitly `node dist/index.js tui`. Running the CLI without arguments prints help rather than launching a separate TUI. Legacy `profile run` still launches an isolated Pi child; the `/manager` extension never uses it. CLI changes also need publication from `/manager` before they affect the registered preset.

If you previously installed a global `pi-manager` command, it is optional. To update that maintenance command after building:

```bash
npm pack --offline
npm install --global ./pi-manager-0.5.0.tgz --offline --ignore-scripts --no-audit --no-fund
pi-manager install --yes
```

## Environment

| Variable | Purpose |
|---|---|
| `PI_MANAGER_HOME` | Manager data; default `~/.pi-manager`, must not overlap default Pi. Use the same value during install and Pi startup. |
| `PI_MANAGER_PI` | Pi executable used by installer/legacy CLI; default `pi`. |
| `PI_MANAGER_SDK_PATH` | Public installed Pi SDK package/entry for worker operations; otherwise detected automatically. |
| `PI_MANAGER_EDITOR` | External editor for the legacy CLI only. In-Pi editing uses Pi's editor. |

Network proxies are inherited; the manager does not rewrite npm registry or Pi proxy settings. The command requires an idle session and interactive Pi UI; an RPC client supporting native dialogs also works. Print/JSON mode does not open the manager. Opening or closing it makes no model call.

## Development and tests

```bash
npm ci
npm run typecheck
npm run build
npm test
```

`src/` and `test/` are TypeScript. NodeNext imports use `.js` extensions resolved to `.ts` sources. `dist/`, `.test-dist/`, and `node_modules/` are not committed.

Pi supplies `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at runtime. They are optional peers and development-only dependencies, **not bundled runtime copies**. Distribution archives include compiled files and both READMEs.

Tests cover command registration, non-UI/busy/reentrant guards, native dialog/editor flows, snapshot context binding, detached publication, failed publications, package digests/recovery, symlink protection, and resource filters. Real Pi integration installs into a temporary agent directory and checks that `/manager`, exported extensions, prompts, and skills load and the command returns to the same session without a model call. npm lifecycle tests use an in-process loopback registry. No model API key is needed.

## Out of scope

Hot unloading, runtime monkey patches, live credential/agent-directory switching, marketplace indexing, OS sandboxing, rollback of external side effects, arbitrary history selection, automatic snapshot cleanup, reliable cancellation of entire installer process trees, and exact per-resource token counts.

## License

[MIT](LICENSE).
