# ship

One release tool for every native app. Run `ship beta` in an app's folder and the latest `main` on GitHub is built, uploaded to TestFlight (and Google Play internal testing for Android), tagged, and sent to your external testers. Run `ship release` and the newest beta goes to App Review (or Play production). A nightly job can do the second step for you.

Nothing else is needed: no fastlane, no Ruby, no npm packages at runtime. It is Bun, `git`, `xcodebuild` and the App Store Connect and Google Play APIs.

## Install

```sh
cd ~/Developer/shipit
bun install
bun link          # puts `ship` in ~/.bun/bin
ship doctor       # inside any app folder that has a ship.json
```

Run `ship` from the app's folder (where `ship.json` lives, which is also the git root), or from anywhere with `ship -C ~/Developer/myapp <command>`.

## Two lanes

| Lane | iOS | Android | Command |
| --- | --- | --- | --- |
| Beta | TestFlight, external groups, Beta App Review | Play internal track | `ship beta` |
| Release | App Review (App Store) | Play production | `ship release` |

**Beta.** `ship beta` always builds from a clean worktree of `origin/main`, so uncommitted work never ships. A repository with no `origin` remote builds its local `main` and pushes nothing (tags and version bumps stay local). It:

1. Fetches `main` and reads the version.
2. Asks App Store Connect whether that version is still open. Once App Review approves a version it takes no more builds, so ship opens a pull request, `chore: start version X`, that bumps the patch number on `main`. The build already carries the new version, and a new version builds every platform. Until the pull request is merged, `ship release` keeps waiting on iOS (Android promotes the newest internal build as before), and later betas reuse the same pull request and build only the platforms asked for. This needs the `gh` CLI, signed in.
3. Takes one UTC instant for the whole run and derives both build numbers from it (see below).
4. Runs your `checks` in the worktree, then builds.
5. Uploads, tags the commit `v<version>-<build>`, pushes the tag.
6. For iOS, waits for Apple's processing, writes "What to Test", adds the build to each `externalGroups` group, and submits it for Beta App Review. An older build of the same version still waiting in Beta App Review is expired so the new one is not blocked.

**Release.** `ship release` sends the newest processed TestFlight build of the current version to App Review, with notes made from the `feat:`, `fix:` and `perf:` commits since the live build. A submission still waiting for review is withdrawn and replaced, so each night's release carries every build of the day. On Android it promotes the newest internal build to production and replaces a production release that is still in review, carrying its notes over.

**Version.** `ship version` prints the version on `main`. `ship version patch|minor|major` commits and pushes the bump to `main`. Patch bumps after an approval are opened as pull requests during `ship beta`.

**Dry runs.** `--dry-run` on `beta` archives and exports locally (export, not upload) and prints every write it skipped: the upload, the tag, the push, and every App Store Connect or Play change. The App Store Connect and Play clients refuse writes in a dry run, so it cannot upload by accident. The export lands in `~/Library/Caches/shipit/<app>-<hash>/build-<number>/` (the hash keeps two checkouts of similarly named apps apart). Add `--ref <branch>` to a dry run to build a branch before it lands on `main`; real builds refuse it.

## ship.json

At the repo root. Unknown keys are rejected so typos show up.

```jsonc
{
  "name": "MineCompa",
  "nightly": false,
  "version": { "file": "app.json", "json": "expo.version" },
  "checks": ["bun run lint", "bun run typecheck"],
  "notesPaths": ["src", "assets"],
  "notesFile": "RELEASE_NOTES.md",
  "credentials": "~/.config/pokefolio/asc.env",
  "ios": {
    "kind": "expo",
    "dir": "ios",
    "scheme": "MineCompa",
    "bundleId": "com.frz.minecompanion",
    "externalGroups": ["Public Beta"],
    "copy": [],
    "preArchive": null,
    "keepAlive": null,
    "listing": null
  },
  "android": {
    "dir": "android",
    "package": "com.frz.nocam",
    "versionCodeProperty": "nocam.versionCode",
    "playKey": "~/.config/nocam/play-service-account.json",
    "copy": ["android/local.properties"]
  }
}
```

| Key | Meaning |
| --- | --- |
| `name` | Display name, used in tags, notifications and the Android bundle file name. |
| `nightly` | `true` opts the app into `ship nightly` releases. Default `false`. |
| `version` | Where the version lives. `{ "file": "VERSION" }` for a plain file, `{ "file": "app.json", "json": "expo.version" }` for JSON, `{ "file": "project.yml", "yaml": "settings.base.MARKETING_VERSION" }` for YAML. Edits are targeted: JSON keeps its formatting, and YAML changes every line whose key matches the last segment (XcodeGen files often repeat `MARKETING_VERSION` per target). |
| `checks` | Shell commands run in the build worktree before building. Skip with `--skip-checks`. |
| `ios.checks`, `android.checks` | The same, run only when that platform is being built, after its `copy` files are in the worktree. |
| `notesPaths` | Only commits that touch these paths become release notes. Empty means the whole repo. |
| `notesFile` | Optional repo-relative file of hand-written store release notes, read from main. See [Release notes](#release-notes). |
| `credentials` | An env file with the App Store Connect key. Default `~/.config/shipit/asc.env`. |
| `ios.kind` | `expo` (prebuild, pods, archive) or `xcodegen` (`xcodegen generate`, then archive). |
| `ios.dir` | `xcodegen`: the folder with `project.yml`. `expo`: the native folder, always named `ios`; the Expo project root is its parent, so `apps/mobile/ios` works for a monorepo. |
| `ios.scheme` | Xcode scheme. For `expo` it is also the app folder inside `ios/`. |
| `ios.bundleId` | Resolves the App Store Connect app at runtime. No app ids are stored. |
| `ios.externalGroups` | TestFlight groups that get every beta and go to Beta App Review. Empty skips the whole post-upload step. |
| `ios.copy`, `android.copy` | Gitignored files or folders (repo-relative) copied into the build worktree, such as `AntoCam/Secrets.swift`. A missing one stops the build. |
| `ios.preArchive` | Optional executable (repo-relative, committed). It runs in the worktree after the archive is built and before it is exported or uploaded, and gets `SHIP_ARCHIVE`, `SHIP_VERSION` and `SHIP_BUILD_NUMBER` (expo also gets `SHIP_APP_BUNDLE`). A non-zero exit stops the build before anything leaves the machine. |
| `ios.keepAlive` | `"75d"`: the nightly job re-uploads a beta when the newest TestFlight upload is older than this, before the 90-day expiry. Needs no state file; it reads the upload date from App Store Connect. |
| `ios.listing` | Optional repo-relative JSON file with `description` and `keywords`, sent with each App Review submission. |
| `android.dir` | Folder with `gradlew`. |
| `android.versionCodeProperty` | Gradle property that receives the version code (`-P<name>=<code>`). |
| `android.playKey` | Play service account JSON. Without it a bundle is built and left in `~/Desktop/<Name>-Android/` for a manual upload. |

### Release notes

`ship release` writes store notes from the `feat:`, `fix:` and `perf:` commit subjects since the live build. To write them yourself, set `notesFile` and commit a file like this to main before releasing:

```markdown
# 1.0.7

- Lines here go to both stores

## iOS
- Lines here go to the App Store only

## Android
- Lines here go to Play only
```

The first heading must match the version being released. A file still headed with the previous version, a missing file, or one with no lines for a store falls back to commit subjects, and the log says so. Notes over the store's limit (App Store 4000, Play 500 characters) stop the release instead of being cut. When a Play release replaces one still in review, the file's notes are used as written, without the replaced build's notes added.

### Build numbers

One instant per run. iOS gets `yyyyMMddHHmm` in UTC. Android gets minutes since the Unix epoch minus 29,000,000 (the formula nocam already uses). The Android code maps back to the same iOS-style build number, which is how `ship release` finds the release tag for a Play build.

### Expo apps

The Expo build is the shell script in `lib/expo-ios.sh`. It runs `expo prebuild`, `pod install` with Hermes built from source under Apple's `tar` (GNU tar leaves `._*` files in frameworks), archives, checks the archive for stray `._*` files, fixes Hermes' `MinimumOSVersion`, generates its dSYM, checks dSYM coverage for the embedded frameworks, and exports or uploads. The clean worktree needs `node_modules`, so `ship beta` runs `bun install --frozen-lockfile` first. Expo apps reuse one worktree between runs (`~/Library/Caches/shipit/<app>-<hash>/worktree`), reset to the commit being built, so Pods and Xcode's derived data stay warm; untracked files are cleaned and ignored files are kept.

## Credentials

App Store Connect, from the `credentials` file or the environment:

| Variable | Alternative | Notes |
| --- | --- | --- |
| `ASC_KEY_ID` | `KEY_ID` | |
| `ASC_ISSUER_ID` | `ISSUER_ID` | |
| (derived) | `KEY_PATH` | Defaults to `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` |
| `APPLE_TEAM_ID` | | Defaults to `ZNHHMX2RP6` |

The env file can hold `KEY=value` lines, `export`, quotes, `$HOME` and `~`, and include lines such as `. ~/.config/pokefolio/asc.env`. It is read, never executed. Xcode signs through the same key (`-allowProvisioningUpdates` with the API key), so no Xcode login is needed.

Google Play uses the service account JSON from `android.playKey`. It needs "Release to testing tracks" on the app, and "Release to production" for `ship release`.

## Nightly

`ship nightly` scans `~/Developer/*/ship.json` and `~/Developer/*/*/ship.json`, so apps grouped in a folder such as `~/Developer/@darkroom` are found too. It skips `node_modules`, `.worktrees` and dot folders, and does not look inside a project for more projects. Set `SHIPIT_PROJECTS` to scan another folder. For each project it runs `ship release` when `nightly` is `true`, and a keep-alive beta when `ios.keepAlive` is due. Projects run one after another and one failure never stops the others; the exit code is non-zero if any failed, and a macOS notification names them. With `--dry-run` it reports what would run and builds nothing.

```sh
ship install-launchd --dry-run   # print the agent
ship install-launchd             # write ~/Library/LaunchAgents/com.frz.shipit.nightly.plist
```

The agent runs `ship nightly` at 03:00 with a PATH that includes `/opt/homebrew/bin` and `~/.bun/bin`, and with GitHub over HTTPS using `gh auth git-credential`, because the SSH agent can refuse to sign while the Mac is locked. The command writes the file only. It prints the `launchctl bootstrap` and `bootout` commands to load it and to unload the older per-app agents; run those yourself. Logs go to `~/Library/Logs/shipit-nightly.log`.

## Other commands

- `ship status`: the latest TestFlight build and its beta review state, App Store version states, and Play internal and production versions.
- `ship doctor`: tools (`xcodebuild`, `xcodegen` or `pod`, `bun`, `java` for Android), credentials, the key file, the App Store Connect app, each external group, the Play key, and for Expo apps a warning when `ios/.xcode.env.local` points `NODE_BINARY` at a node that no longer exists.

Only one `ship` run works on an app at a time; a second exits with code 75.
