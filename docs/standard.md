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
vigilia draft/finalize + aliases ──── rolling release, latest.json ──────────────┤
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
| browsee | Release notes from `CHANGELOG.md`, required before a release runs and shown in the update window. Delta updates. A runbook for a lost signing key. |
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
- **Phone apps** release from CI too, on the studio Mac runner. `ship beta` from a laptop (a clean worktree of main) is for emergencies only.
- The same `ship` code runs locally and in CI. An app's CI calls the reusable workflows in `darkroomengineering/shipit/.github/workflows` (for example `windows-lane.yml`) through a small caller workflow.

## 2. The stages

Every lane runs the same steps in order:

1. **Preflight:** the tree is clean, HEAD is main, the build number is higher than the published one, and `CHANGELOG.md` has a section for this version.
2. **Stamp** the version and build number.
3. **Build** and **sign**. Mac apps build with Xcode or with their own build command (codigo's `scripts/bundle.sh` runs `cargo`); ship signs the result either way.
4. **Verify** the result before anything is uploaded (see gates below).
5. **Package and upload:** notarize and staple for Mac direct download, a signed installer package for the Mac App Store, upload to the store for phones.
6. **Draft.** Every platform's output goes into one draft release.
7. **Finalize** each platform that passed: publish it, update its stable download name and update feed, then tag.

Platforms share the version but don't block each other. A platform that fails keeps its previous build public until its lane passes, so a flaky Windows build never holds back the Mac release.

`ship release` runs the whole beta first and submits that build, so one command takes main to the stores.

## 3. Versions and notes

- One version per release across all platforms. The build number comes from one source per release (the CI run or the build time), so it only goes up and every platform shares it.
- `CHANGELOG.md` is required. Its section for the version becomes the update window text, the GitHub release notes and the store "What's new".
- `ship` never pushes to main without a person. Version bumps go through a release PR or a tag; an agent proposes major, minor or patch from the changelog and a person merges it.
- Every PR with a user-visible change adds a line under `## Unreleased` in `CHANGELOG.md`, written for users. The release turns that section into the version's section.

## 4. Rolling releases

Every app ships as a rolling release. Store builds follow the store's own tracks; everything downloaded from us follows these rules:

- **Two channels, beta and rolling.** Every green build on main publishes to `beta`. `ship promote` (one click in Actions) moves that build to `rolling`, which everyone gets. Testers join beta with a "Get beta updates" toggle in the app; there is no separate beta download. People and agents may promote whenever the build is ready; there is no minimum time on beta. Hotfixes go through beta like everything else.
- **Leaving beta doesn't downgrade.** Someone who turns the toggle off stays on the beta build until rolling passes it, so any data migration in a beta build must be one the next rolling build can also run.
- **One feed and one release for both channels.** `beta` and `rolling` are channels in the same update feed and the same release (Sparkle channels on Mac). The feed URL never changes. A beta build doesn't replace the stable download name; `ship promote` moves it. Older releases, drafts and assets are deleted once the new one is published. Nobody downloads an old build.
- **Formats:** `.dmg` on macOS, `.apk` on Android, `.exe` on Windows, `.AppImage` on Linux. Nothing else (no `.msi`, `.deb` or `.zip`).
- **Store apps:** a Mac app in the Mac App Store keeps its direct `.dmg` too. An Android app in Google Play does not also publish an `.apk`.
- **Updater files ride along.** The files installed copies update from stay on the release next to the download: Sparkle's `appcast.xml`, Tauri's `latest.json` with its `.sig` and `.app.tar.gz`, and Velopack's `releases.win.json` and `.nupkg`. They are replaced with each build like everything else.
- **Every rolling release updates over the air.** An app that can be downloaded from us has an update feed, and installed copies pick up the new build on their own.
- **Every update notification shows a changelog.** The prompt opens a view with this version's `CHANGELOG.md` section, so people see what changed before they install.
- **A bad build is fixed forward.** Revert on main and release again; the new build replaces the bad one. There is no rollback to an old artifact, because none is kept.
- **Delta updates come from the current build.** Before replacing it, the release job downloads the current rolling build and makes the delta from it.

Store tracks: TestFlight (internal-only by default, external with a flag) for iOS and the Mac App Store, and the Play internal track. `ship release` submits the beta build to the store.

## 5. Updates

Over the air first; store releases for major updates.

- **Mac direct download:** Sparkle 2 with EdDSA signatures, a signed feed, update verification before extraction, and delta updates.
- **Windows:** Velopack. Velopack has no update window of its own, so the app shows the changelog itself.
- **Android direct download:** an in-app updater that checks the release feed, shows the changelog, and installs the new `.apk`. It needs the install-packages permission, so the Play build leaves it out.
- **Vigilia (Tauri):** the Tauri updater with `latest.json`. Vigilia is the one app that keeps its own release pipeline; `ship` has no Tauri lane.
- **Expo apps:** `ship update` publishes EAS Update, with guards against native changes and a dirty tree. Whether a change can go over the air or needs a store build is decided per release: an agent reviews the diff since the last store build, and anything touching native code, native dependencies or permissions goes through the store.
- **Native phone apps:** remote config and content only, because Apple and Google don't allow downloaded code.

Existing update feed URLs and update signing keys never change, like bundle IDs. Changing either strands every installed copy.

## 6. Downloads and hosting

- New apps publish to GitHub Releases. When the source is private, they publish to a public `<app>-releases` repo.
- Apps with an existing feed keep it where it is (browsee stays on R2 at updates.browsee.app).
- Every release has stable download names that always point at the newest build: `<App>-mac.dmg` on Mac and `<packId>-x64-setup.exe` on Windows, each next to a copy named for the current build that the update feeds point at. Vigilia keeps its own names, including Linux. A `latest.json` manifest lists the version, notes and links, and the website reads it for its download buttons.

## 7. Signing and secrets

- **Mac:** Developer ID, notarized and stapled, under team ZNHHMX2RP6.
- **Mac App Store:** Apple Distribution for the app and 3rd Party Mac Developer Installer for the package, with the app's provisioning profile embedded, under the same team.
- **Windows:** Azure Artifact Signing, which signs in CI without a stored certificate. Until it is set up, Windows builds ship unsigned and people click through the SmartScreen warning.
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

## 9. The studio Mac runner

Mac and iOS jobs for private repos run on the studio Mac, a GitHub Actions self-hosted runner in the org. Public repos stay on GitHub's hosted runners, which are free for them and keep fork PRs off the studio machine.

- **Two runner instances.** `studio-release` takes only release workflows, so releases never queue behind CI. `studio-ci` takes PR builds and tests.
- **Workflows pick it through a variable:** `runs-on: ${{ vars.MAC_RUNNER || 'macos-26' }}`. When the studio Mac is offline, an agent may point `MAC_RUNNER` at GitHub's hosted runners for a release that is waiting, then switch it back. CI waits for the studio Mac; switching CI to paid minutes needs a person.
- **Xcode:** versions are installed side by side and each workflow names the one it needs. Installing or updating Xcode or macOS, and rebooting, is a person's job. Agents may clear build caches and old simulators.
- **Health:** a weekly job on the runner posts disk space, uptime and installed Xcode versions to Slack.
- The signing certificate arrives from GitHub secrets during a run, goes into a temporary keychain, and is deleted when the run ends.

## 10. Who does what

| | Agents | People |
| -- | -- | -- |
| Publish to beta | Yes | Yes |
| `ship promote` to rolling | Yes | Yes |
| `ship release` (submit for store review) | No | Yes |
| Store review rejections | Draft the reply | Send it |
| Version bump | Propose in the release PR | Merge it |
| Switch `MAC_RUNNER` to hosted runners | For a waiting release | Anything |
| New app: App Store record, bundle ID, 1Password items, domains | Prepare everything | Create them |
| Update Xcode or macOS on the runner | No | Yes |

## 11. New apps

- Bundle IDs are `engineering.darkroom.<app>`. Existing apps keep theirs (`com.darkroom.*`, `com.frz.*`, `com.arzafran.*`), since a bundle ID can never change.
- Private source publishes to a public `<app>-releases` repo.
- Apps support the current OS and the one before it.

## 12. Store listings

The listing lives in the repo: name, subtitle, description, keywords, URLs, screenshots and privacy answers,
including the credit line "A sidequest by Darkroom Engineering Incubator." `ship listing` pushes it and never
submits for review.

## 13. ship itself

`ship` meets the same bar: tests in CI, no unattended pushes to main, and this file kept current.

## What doesn't change

- Bundle IDs, package names, update feed URLs and update signing keys.
- An app's working pipeline keeps running until its `ship` lane reaches parity on a real release.
