# ship: one release tool for every native app

## Functional DAG

```
inputs                         build                          migrate (parallel)                 verify
─────────────────────────────  ─────────────────────────────  ─────────────────────────────────  ──────────────────────────────
nocam pipeline (asc.ts,        ┐                              ┌ minecompanion + pokefolio (expo) ┐
  distribute, nightly, submit, │                              │                                  │
  open-version, notes, play)   ├─ shipit core ── ship doctor ─┼ nocam (ios + android + nightly)  ├─ `ship doctor` + `ship beta
minecompanion/pokefolio expo   │  (bun CLI)      + dry runs   │                                  │   --dry-run` green in all 6,
  archive + dSYM checks        │                              └ chess-trainer, antocam, mareas   ┘   old scripts gone, one
decisions (below)              ┘                                                                     launchd job
```

## Decisions (from the user, 2026-10-12)

- Both lanes: `ship beta` (TestFlight / Play internal) and `ship release` (App Review / Play production).
- Standalone repo `~/Developer/shipit`, `ship` on PATH via `bun link`. Each app has a `ship.json`.
- iOS and Android (Android is nocam only today).
- Nightly App Store submission is opt-in per app (`"nightly": true`); nocam on, the rest off.
- Version moves automatically: once App Review approves a version, the next `ship beta` opens a `chore: start version X` pull request that bumps the patch, and builds the new version. `ship version minor|major` for bigger jumps.
- MineCompa's EAS workflow is removed. chess-trainer leaves Xcode Cloud (the user disables the workflow in App Store Connect).

## Shape

`ship.json` (per app, repo root):

```jsonc
{
  "name": "MineCompa",
  "nightly": false,
  "version": { "file": "app.json", "json": "expo.version" },   // or { "file": "VERSION" } or { "file": "project.yml", "yaml": "settings.base.MARKETING_VERSION" }
  "checks": ["bun run lint", "bun run typecheck"],
  "notesPaths": ["src", "assets"],                                // commits touching these become release notes
  "credentials": "~/.config/pokefolio/asc.env",                  // optional; default ~/.config/shipit/asc.env
  "ios": {
    "kind": "expo",                                               // expo | xcodegen
    "dir": "ios",                                                 // xcodegen project dir; expo prebuild output
    "scheme": "MineCompa",
    "bundleId": "com.frz.minecompanion",
    "externalGroups": ["Familia"],                                // added + sent to Beta App Review on every beta
    "copy": [],                                                   // gitignored files copied into the build worktree
    "preArchive": null,                                           // optional project hook script, run in the worktree
    "keepAlive": null                                             // e.g. "75d": nightly re-uploads before TestFlight's 90-day expiry
  },
  "android": { "dir": "android", "package": "com.frz.nocam", "versionCodeProperty": "nocam.versionCode",
               "playKey": "~/.config/nocam/play-service-account.json", "copy": ["android/local.properties"] }
}
```

Commands: `beta`, `release`, `version`, `nightly`, `status`, `doctor`, `install-launchd`. All writes have `--dry-run`.

Build numbers: one UTC instant per run. iOS `yyyyMMddHHmm` (exceeds every existing number), Android minutes since 2025-02-20 (nocam's formula). Every beta is tagged `v<version>-<build>` and the tag pushed; release notes are feat/fix/perf subjects between tags, filtered to `notesPaths`.

Builds always come from a clean worktree of `origin/main`. Uncommitted work never ships.

## Risks

- Expo archive is the fragile part (Apple tar, `._*`, Hermes dSYM, Xcode 27 patches). Port minecompanion's script verbatim; prove it with a dry run before deleting anything.
- The auto version bump never pushes to main: it opens a pull request after an approval, and iOS `ship release` waits until someone merges it.
- Two launchd agents (nocam nightly, antocam keep-alive) are replaced by one; install it only after nocam's branch is merged, or nocam's night run breaks.
- Real uploads are run by the user (`! ship beta`); agent runs stop at dry runs.
