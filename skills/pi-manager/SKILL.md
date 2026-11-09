---
name: pi-manager
description: Install, add, update or remove Pi packages, extensions, skills, prompt templates and themes through the pi-manager staging preset and snapshot publication, and diagnose why a staged change is not loading. Use whenever the user asks to 装插件, 装扩展, 装 skill or 技能, add or install a Pi package, or install something from npm or git so Pi can use it. Do not use `pi install` or edit settings.json directly for this user's setup.
---

# Install Pi packages through pi-manager

This user manages Pi resources with **pi-manager**. Resources live in a staging
preset and only reach Pi when that preset is published as a snapshot and Pi is
restarted. `pi install` bypasses all of that: no snapshot, no generation
history, no rollback, and the manager will later report the package as drift.

## Find the CLI

This skill ships inside the pi-manager package, so the CLI is at
`<package-root>/dist/index.js`, two directories above this `SKILL.md`. Pi reports
the skill path; resolve the CLI from it, or use `pi-manager` when that command
already exists:

```bash
node <package-root>/dist/index.js doctor --json
```

## Install a package

```bash
node <package-root>/dist/index.js add <source> --publish --yes --json
```

- `<source>` is `npm:name@version`, `git:host/owner/repo@ref`, or an absolute
  local path. Quote sources that contain `@` or spaces.
- Without `--profile`, the saved default preset is used. The JSON result names
  the preset it actually used; do not guess.
- `--publish` is the cutover. It writes the snapshot and its pinned package
  declarations for the **next** Pi start.
- `--yes` acknowledges that third-party code and install scripts run with the
  user's permissions. Keep it: never install a source the user did not name.

If the user only wants to inspect or prepare something, drop `--publish`. The
package is then staged in the preset and nothing changes for Pi until someone
publishes.

## Report the result

Read the JSON instead of assuming success:

- `ok: true` with `published.snapshot` — tell the user to restart Pi, because the
  running session keeps its old snapshot. Do not restart or reload on your own.
- `ok: true` with `published: null` — staged only, and Pi is unchanged.
- `ok: false` with `publishError` — staging succeeded, publication did not. Do
  not re-add; fix the reported cause, then run
  `node <package-root>/dist/index.js publish --json` and report both steps.

Rolling back is `package rollback <preset> --yes`, which restores the previous
generation for the next start. Publishing and rolling back never touch the
already-running Pi.

## When something is not loading

```bash
node <package-root>/dist/index.js doctor --json
```

Report the `findings` entries with `level: "error"` verbatim plus their `hint`.
Common causes: nothing published, snapshot missing on disk, publication made for
a different `PI_MANAGER_HOME`, a stale profile `.lock`, or packages declared in
Pi settings outside the manager.

If `doctor` reports `unmanaged-packages`, do not publish over them. Offer the
migration path described in the hint, and let the user decide before anything is
removed: Pi loads both copies until the duplicates are gone.

## Never do these

- `pi install`, `pi remove`, `pi update` for this user's personal resources.
- Hand-editing `~/.pi/agent/settings.json`, `.pi/settings.json`, or the published
  bundle directory.
- `pi-manager install`, `self-update`, `prune`, or `profile delete` unless the
  user explicitly asked for that operation.
- Retrying a failed package operation blindly; the profile lock is deliberate
  and a stale lock needs a human to confirm no Pi process owns it.
