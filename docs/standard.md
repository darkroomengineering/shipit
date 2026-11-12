# Release standard: how every Incubator app ships

Every Darkroom Engineering Incubator app releases with `ship`. This file is the source of truth; the Linear project
[Sidequest standard](https://linear.app/darkroomengineering/project/sidequest-standard-baseline-releases-sites-credit-b19ad5300c13)
tracks the work to get every app there.

## Functional DAG

```
prereq ── Azure Artifact Signing account for the org (Windows signing)

shipit src/config ─────────────┐
shipit .github/workflows ──────┴── ship.json v2 + `ship ci` + reusable workflow ──┐
                                                                                  │
programa release.yml + scripts ──┐                                                │
browsee mac/scripts/release.sh ──┴── mac lane (Sparkle direct download) ──────────┤
mesinyer windows.yml (Velopack) ──┐                                               │
programa build-windows.ps1 ───────┴── windows lane ───────────────────────────────┤
pokefolio update-production.sh ────── `ship update` (guarded OTA) ────────────────┤
nocam check-permissions + secrets ─── built-in gates + `ship doctor` ─────────────┤
vigilia draft/finalize + aliases ──── channels, promote, rollback, latest.json ───┤
shipit tests ──────────────────────── ship meets its own standard ────────────────┤
codigo scripts/appstore.sh ────────── Mac App Store lane ─────────────────────────┤
                                                                                  └── each app adopts ship ── verify: every app's last release came from `ship` with every gate green
```

## Where each part comes from

Programa has the best desktop pipeline: a green CI run on main starts the release with no manual step, it checks
that the commit is still main's head before and after the build, and it verifies entitlements and architectures
before it publishes. The other apps each do one thing better, and the standard takes it:

| From | What the standard takes |
| -- | -- |
| NoCam | The phone lanes: one `ship beta` for iOS and Android from a clean worktree of main. A 1Password item for every release key, with restore steps. A permission allowlist that fails the build. Store listing kept in the repo. |
| browsee | Release notes from `CHANGELOG.md`, required before a release runs and shown in the update window. Delta updates. Every published appcast kept, so rollback is one command. A runbook for a lost signing key. |
| Vigilia | One run builds Mac, Windows and Linux. The release stays a draft until every platform passes, then "latest" moves. Stable download names and a `latest.json` manifest. |
| Pokefolio | Over-the-air updates that refuse to publish when native code changed or the tree isn't main. |
| Mesinyer | Velopack for the Windows installer and its update feed. |
| codigo | The Mac App Store upload, including the check for rejections that `altool` reports with exit code 0. |
| Wavecast | An internal-only TestFlight upload that skips Beta App Review. |

## 0. Apps are native

Each platform gets native code: Swift on Apple platforms, Kotlin on Android, and a native or GPUI build on Windows and Linux. A cross-platform framework (Tauri, Electron, Expo) is used only where it is measurably faster to build and run. Vigilia (Tauri) is the accepted exception. Metricae and Pokefolio (Expo) ship through `ship` until their native ports replace them.

## 1. Where a release runs

A release always builds from a clean checkout of main's current head, never from a working tree.

- **Desktop apps** release from CI when main goes green. The Windows build needs a Windows runner, so CI is required there anyway.
- **Phone apps** can release from a Mac with `ship beta`, which uses a clean worktree of main. They move to CI once `ship ci` is complete.
- The same `ship` code runs locally and in CI. An app's CI calls the reusable workflows in `darkroomengineering/shipit/.github/workflows` (for example `windows-lane.yml`) through a small caller workflow.

## 2. The stages

Every lane runs the same steps in order:

1. **Preflight:** the tree is clean, HEAD is main, the build number is higher than the published one, and `CHANGELOG.md` has a section for this version.
2. **Stamp** the version and build number.
3. **Build** and **sign**. Mac apps build with Xcode or with their own build command (codigo's `scripts/bundle.sh` runs `cargo`); ship signs the result either way.
4. **Verify** the result before anything is uploaded (see gates below).
5. **Package and upload:** notarize and staple for Mac direct download, a signed installer package for the Mac App Store, upload to the store for phones.
6. **Draft.** Every platform's output goes into one draft release.
7. **Finalize** only when every platform passed: publish, update the stable download names and the update feeds, then tag.

A platform that fails leaves a draft nobody can see, so "latest" never points at a half-finished release.

`ship release` runs the whole beta first and submits that build, so one command takes main to the stores.

## 3. Versions and notes

- One version per release across all platforms. The build number comes from one source per release (the CI run or the build time), so it only goes up and every platform shares it.
- `CHANGELOG.md` is required. Its section for the version becomes the update window text, the GitHub release notes and the store "What's new".
- `ship` never pushes to main without a person. Version bumps go through a release PR or a tag.

## 4. Channels

- **Candidate:** a private draft for every build, kept for rollback (keep the newest five).
- **Beta:** TestFlight (internal-only by default, external with a flag) for iOS and the Mac App Store, the Play internal track, and a Sparkle beta feed for Mac.
- **Production:** `ship promote <build>` moves a beta to production. `ship rollback <build>` puts the previous build back and restores the previous feed.

## 5. Updates

Over the air first; store releases for major updates.

- **Mac direct download:** Sparkle 2 with EdDSA signatures, a signed feed, update verification before extraction, and delta updates.
- **Windows:** Velopack.
- **Vigilia (Tauri):** the Tauri updater with `latest.json`. Vigilia is the one app that keeps its own release pipeline; `ship` has no Tauri lane.
- **Expo apps:** `ship update` publishes EAS Update, with guards against native changes and a dirty tree.
- **Native phone apps:** remote config and content only, because Apple and Google don't allow downloaded code.

Existing update feed URLs and update signing keys never change, like bundle IDs. Changing either strands every installed copy.

## 6. Downloads and hosting

- New apps publish to GitHub Releases. When the source is private, they publish to a public `<app>-releases` repo.
- Apps with an existing feed keep it where it is (browsee stays on R2 at updates.browsee.app).
- Every release has stable download names that always point at the newest build: `<App>-mac.dmg` on Mac and `<packId>-x64-setup.exe` on Windows, each next to a per-build copy. Vigilia keeps its own names, including Linux. A `latest.json` manifest lists the version, notes and links, and the website reads it for its download buttons.

## 7. Signing and secrets

- **Mac:** Developer ID, notarized and stapled, under team ZNHHMX2RP6.
- **Mac App Store:** Apple Distribution for the app and 3rd Party Mac Developer Installer for the package, with the app's provisioning profile embedded, under the same team.
- **Windows:** Azure Artifact Signing, which signs in CI without a stored certificate.
- **Linux:** updater signatures only.
- CI secrets live in a GitHub `release` environment, set once for the org where possible.
- Every secret has a 1Password item. `ship.json` lists them, and `ship doctor` prints how to restore each one on a new Mac.

## 8. Gates

`ship` runs these on every release, and a failure stops it:

- Entitlements match an allow and deny list, and the binaries contain the expected architectures.
- Signatures, notarization and stapling check out (`codesign`, `spctl`, `stapler`). Windows signatures report "Valid".
- The Sparkle key in the keychain matches the app's public key.
- Android permissions match an allowlist.
- A privacy manifest exists on iOS and Mac.
- The app and every helper process have an icon and a display name. Helpers must not show as "browsee Helper (GPU)" in Activity Monitor or Screen Time.
- Store uploads count as failed when Apple returns a rejection, even if the tool exits 0.

## 9. Store listings

The listing lives in the repo: name, subtitle, description, keywords, URLs, screenshots and privacy answers,
including the credit line "A sidequest by Darkroom Engineering Incubator." `ship listing` pushes it and never
submits for review.

## 10. ship itself

`ship` meets the same bar: tests in CI, no unattended pushes to main, and this file kept current.

## What doesn't change

- Bundle IDs, package names, update feed URLs and update signing keys.
- An app's working pipeline keeps running until its `ship` lane reaches parity on a real release.
