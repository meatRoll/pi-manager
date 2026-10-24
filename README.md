# pi-manager

**English** | [简体中文](README.zh-CN.md)

An independent **TUI manager and launcher for Pi profiles, packages, and context resources**. Manage skills, extensions, prompt templates, themes, and Markdown context without patching Pi or registering an extension in your default Pi setup.

Written in **TypeScript** with strict type checking. The compiled CLI has no third-party runtime dependencies.

## Quick start

Requires **Node.js 22.19+** and an installed Pi with its public SDK. Currently tested with **Pi 1.3.0**.

```bash
git clone https://github.com/meatRoll/pi-manager.git
cd pi-manager
npm ci
npm start
# Or build once and run the compiled CLI directly:
npm run build
node dist/index.js
```

Choose **+ Create profile**, give it a name such as `review`, add packages or resources, then select **Run Pi**.

The repository is public. `package.json` intentionally keeps `private: true` to prevent accidental npm publication: the npm name is already taken by another project. **Do not install with `npm install -g pi-manager`.**

### Install the global command

After installing development dependencies with `npm ci`, pack this project and install the local archive. `npm pack` automatically builds the TypeScript sources first; packing and local installation can run offline.

```bash
npm pack --offline
npm install --global ./pi-manager-0.4.0.tgz --offline --ignore-scripts --no-audit --no-fund
pi-manager --version
```

Then launch it from the project you want Pi to work on:

```bash
cd /path/to/your-project
pi-manager
# Or launch a particular profile directly:
pi-manager profile run review
```

Pi inherits your current working directory. This installation is a standalone copy of the packed version; rebuild, repack, and reinstall after source changes. For development, you can instead run `npm run build` followed by `npm link --offline`; rebuild after changing `.ts` files.

The CLI examples below use the installed `pi-manager` command. From a source checkout, substitute `node dist/index.js` after building.

### TUI controls

- `↑` / `↓`, `PgUp` / `PgDn`: navigate.
- `Enter`: open details or perform an action.
- `/`: search; press `Enter` to finish typing, then again to open a result.
- `Space`: toggle a package or resource.
- `Esc`: go back; clear an active search first.
- Preview pages support vertical and horizontal scrolling.

```text
Profiles
└── review
    ├── Run Pi
    ├── Packages
    │   └── package details / resource switches / uninstall
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

Package installation shows available metadata and asks you to acknowledge third-party code risks. Uninstalling and deleting resources also require confirmation. The TUI runs independently, not inside Pi.

## Isolation boundaries

The manager stores its own persistent state under `~/.pi-manager/`:

```text
~/.pi-manager/
├── state.json
└── profiles/
    └── review/
        ├── settings.json       # Native Pi settings for this profile
        ├── manager.json        # Context and manager metadata
        ├── resources/          # Imported resource copies
        ├── .packages/          # Owned generations; do not overwrite active files
        │   └── <generation>/
        │       ├── npm/        # Packages, manifests, and lockfiles for this generation
        │       ├── git/        # Owned Git package copies
        │       ├── settings.json
        │       └── generation.json
        ├── npm/                # Legacy layout may remain; copied, not moved/deleted
        ├── git/                # Legacy layout may remain
        ├── sessions/           # Profile-specific sessions
        ├── auth.json           # Created by Pi when you log into this profile
        └── .operations/        # Package operation logs
```

The manager **does not intentionally modify**:

- Your default `~/.pi/agent/settings.json` or its resource directories.
- The Pi installation, source code, or built-in extensions.
- Your project's `.pi/`, `AGENTS.md`, or `CLAUDE.md`.
- Environment variables in your parent shell.
- The original files of imported resources or external local packages.

Package operations use Pi's public **`DefaultPackageManager` SDK** in a separate process, operating on a new candidate generation. After validation, one atomic replacement of the profile's `settings.json` switches package paths and filters together. Pi sees ordinary local package paths; it needs no patch or companion extension. Original npm/Git declarations and generation references live in the manager's settings field, while the UI continues to show the original sources. The manager never invokes Pi's self-update entry point.

Resource discovery also uses the public SDK for manifests, globs, and Pi resource filters. It does not import or execute extension code.

### Not a security sandbox

Configuration isolation is a write convention, **not an OS-level permission boundary**:

- Package installation scripts, loaded extensions, and external editors run with your user permissions.
- npm and Git may use their own caches, credentials, and configuration. They may write outside the manager directory.
- Editing uses a temporary file; saving writes back only to the manager-owned resource copy.
- Default Pi credentials, model configuration, and sessions are not shared automatically. Log into each profile or provide credentials through environment variables.
- Pi may still discover native context such as project `AGENTS.md` / `CLAUDE.md` and shared skills such as `~/.agents/skills`. The default `--no-approve` disables trust-controlled project configuration, not every context discovery mechanism.
- The UI shows the **next-launch configuration**, not the live state of an already running Pi process.

## Package management

```bash
pi-manager profile create review
pi-manager package inspect npm:pi-tool-display
pi-manager package add review npm:pi-tool-display --yes
pi-manager package list review
pi-manager package disable review npm:pi-tool-display
pi-manager package enable review npm:pi-tool-display
pi-manager package update review --yes
pi-manager package remove review npm:pi-tool-display --yes
pi-manager package versions review
pi-manager package rollback review --yes
```

Sources use Pi's formats: `npm:name@version`, `git:github.com/owner/repo@ref`, or an absolute path to a local directory/module. **A local package is a reference:** its files are not copied, its dependencies are not installed, and its original directory is never deleted. Import a resource copy when you want to edit it independently.

Disabling a whole package sets all four resource filters to `[]` and preserves the previous entry in manager metadata (`manager.json` for legacy profiles, `piManagerPackages` in `settings.json` for generation-managed profiles). Enabling restores those exact filters. **`autoload: false` is not used as a whole-package switch**, because Pi gives it separate incremental-filter semantics.

Updating without a source explicitly updates all packages, not Pi itself. CLI package operations require `--yes` to acknowledge third-party code and installation-script risks. Git inspection reports its source only; it cannot verify a manifest or scripts before downloading the repository.

### Stopped-profile generation switching and restore

1. Acquire an exclusive profile lease. Refuse package changes and restore while a manager-launched Pi still uses that profile.
2. Copy owned npm/Git files into a new candidate generation. Copy real bytes, not hardlinks to active files. Relocate internal dependency symlinks; reject external symlinks and linked Git worktrees.
3. Install, update, or remove packages inside the candidate. Validate package files, manifests, resource paths, and ownership without loading extensions. Validation is not a guarantee that third-party code runs correctly.
4. Record content digests, selections, and the previous generation reference. Publish the new paths and filters with one atomic settings replacement. The next Pi launch uses them.
5. Discard the candidate on failure, leaving active package files and references unchanged. Retain the previous generation after success.

Use `package rollback <profile> --yes` or **Package generations / restore** in the TUI:

- Validate the previous generation's digest, paths, and package files offline, then restore its package paths, package selections, and resource filters.
- Do not restore `auth.json`, sessions, models, context files, or standalone resources. Do not change default Pi or project configuration.
- External local packages restore **references only**, not historical file contents. Changes to their original directories cannot be undone by this feature.
- Refuse restore if owned package files changed or disappeared. Never silently download a different version. Generation metadata and lockfiles remain with their generation.
- Restore again to switch back to the generation you just left. The UI supports current/previous switching, not arbitrary historical selection.

The first successful operation on a legacy profile copies an available baseline and leaves its original package directories in place. A copied profile that has declarations but no installed packages can initialize, but it is not advertised as having a complete restorable baseline; missing packages are reported.

**Limits:** this is not a host-wide transaction. External script writes, network requests, database changes, and Pi's in-memory state cannot be undone. Third-party code can still write outside its candidate directory; preventing that requires an OS sandbox.

After switching, native Pi `packages` entries are local generation paths. Use pi-manager for package updates, removal, and restore instead of changing these managed declarations with native Pi package commands. Updating a local path in Pi is not equivalent to updating the original npm/Git source.

Generations are **not automatically garbage-collected** and consume additional disk space. Forced termination can leave candidate directories and a `.lock`. Confirm that all related Pi/npm/Git processes have stopped before manually cleaning them up. Atomic settings replacement is a publication boundary for ordinary operations, not a guarantee of whole-disk transaction durability during power loss.

## Resource management

```bash
pi-manager resource list review
pi-manager resource list review skills --json
pi-manager resource import review skills ./my-skill
pi-manager resource import review prompts ./review.md
pi-manager resource preview review <resource-id>
pi-manager resource disable review <resource-id>
pi-manager resource enable review <resource-id>
pi-manager resource edit review <resource-id>
pi-manager resource remove review <resource-id> --yes
```

Types: `skills`, `extensions`, `prompts`, `themes`, and `context`.

- Preview and toggle individual package resources without modifying package files.
- External/package resources are read-only: import a copy before editing or deleting an individual resource.
- Imports copy files. A skill must be a directory containing `SKILL.md`; an extension directory must contain `index.ts` or `index.js`.
- Imports reject symlinks to avoid accidentally editing or deleting original files through them.
- Native skill frontmatter, themes, and other formats must still satisfy Pi's requirements. Discovery does not imply successful runtime loading.
- Whole-package disable takes precedence over per-resource selections.
- Previews are limited to 128 KiB. The editing flow refuses to overwrite files exceeding that limit.

## Preset context

```bash
pi-manager context create review rules 'Focus on correctness and explain assumptions.'
pi-manager context import review ./guidelines.md
pi-manager context list review
pi-manager context edit review rules
pi-manager context preview review rules
pi-manager context disable review rules
pi-manager context enable review rules
pi-manager context remove review rules --yes
```

Context lives in the profile's `resources/context/*.md`. Enabled files are passed to a new Pi process with **`--append-system-prompt <file>`**, without writing or replacing `AGENTS.md` or `SYSTEM.md`. Disabling affects future launches, not historical messages already saved in a session.

## Copying and launching profiles

```bash
pi-manager profile copy review frontend
pi-manager profile use frontend
pi-manager profile run frontend
pi-manager profile run frontend -- --offline
pi-manager profile delete frontend --yes
```

Copies include settings, manager metadata, imported resources, and context. **Credentials, sessions, installed npm/Git files, and generation references are excluded.** Original npm/Git declarations remain and need installation/resolution in the new profile; the copy does not share writable generation directories. External local sources continue to reference the same external files.

Launching sets child-only `PI_CODING_AGENT_DIR=<profile>` and a separate `PI_CODING_AGENT_SESSION_DIR`. It defaults to `--no-approve`; explicitly forward `--approve` if you need trust-controlled project resources. The manager never changes an existing Pi process's agent directory and does not implement hot unloading.

Manager-launched Pi and mutations share the same profile lease. External manually launched Pi processes cannot be detected. A crash can leave `.lock`: **verify that related Pi/npm/Git processes have exited before removing it manually**. The manager does not automatically take over unknown locks.

## Environment variables

| Variable | Purpose |
|---|---|
| `PI_MANAGER_HOME` | State directory; defaults to `~/.pi-manager`, must not overlap the default Pi directory |
| `PI_MANAGER_PI` | Pi executable; defaults to `pi` |
| `PI_MANAGER_SDK_PATH` | Installed public Pi SDK package directory or entry file; otherwise discovered from Node modules or the installed Pi launcher |
| `PI_MANAGER_EDITOR` | Editor **executable path**; falls back to `VISUAL`, `EDITOR`, then `vi` |

Editor strings are not evaluated by a shell. Use an executable wrapper if your editor needs arguments. Network proxies are inherited from the process environment; the manager does not rewrite Pi's `httpProxy` or npm registry settings.

## Development and tests

```bash
npm ci                # TypeScript and Node types: development dependencies only
npm run typecheck     # Strict checks for source and tests; no emitted files
npm run build         # src/*.ts → dist/*.js
npm test              # Compile into .test-dist/, then run node:test
```

`src/` and `test/` contain TypeScript. ESM imports use `.js` extensions, resolved to `.ts` by TypeScript's NodeNext mode. `dist/`, `.test-dist/`, and `node_modules/` are not committed. Distribution archives contain compiled files and documentation; end users do not need TypeScript to run the CLI.

Tests use temporary manager directories and cover path protection, package/resource filters, CLI behavior, profile copying, context, failure recovery, pre-commit fault injection, and package content digests. Real Pi SDK integration tests run offline. An in-process loopback registry also exercises real npm installation, version replacement, removal, and restore after the registry shuts down, without external network access. SDK-dependent integration tests are skipped if Pi is absent; set `PI_MANAGER_SDK_PATH` if needed. No model API key or model call is required.

## Not implemented

- Marketplace indexing or remote search.
- Comprehensive installation-script approval or sandboxing.
- Reliable cancellation of installations and recovery of entire child-process trees.
- Rollback of external side effects or host-wide transactions.
- Arbitrary historical generation selection or automatic generation cleanup.
- Live profile switching; **hot unloading is explicitly out of scope**.
- Shared global sessions/credentials or automatic exports into default Pi configuration.
- Exact effective-context token counts for individual package resources.

## License

[MIT](LICENSE).
