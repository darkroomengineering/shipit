# ship

One release tool for every native app. Run `ship beta` in an app's folder and the latest `main` on GitHub is built, uploaded to TestFlight (and Google Play internal testing for Android), tagged, and sent to your external testers. Run `ship release` and the newest beta goes to App Review (or Play production). A nightly job can do the second step for you.

Mac apps that update through Sparkle get the same two commands: `ship beta mac` signs, notarizes and publishes a DMG and its appcast (see [Mac direct download](#mac-direct-download)). Mac App Store apps do too: `ship beta macAppStore` uploads a signed installer package to TestFlight and `ship release macAppStore` sends it to App Review (see [Mac App Store](#mac-app-store)). Both Mac lanes build with Xcode or with the app's own build command, so a Rust or other non-Xcode app ships the same way.

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

| Lane | iOS | Android | Mac | Mac App Store | Command |
| --- | --- | --- | --- | --- | --- |
| Beta | TestFlight, external groups, Beta App Review | Play internal track | Notarized DMG on the app's Sparkle feed | TestFlight | `ship beta` |
| Release | Beta, then App Review (App Store) | Beta, then Play production | The beta (one feed, nothing to promote) | Beta, then App Review (Mac App Store) | `ship release` |

**Beta.** `ship beta` always builds from a clean worktree of `origin/main`, so uncommitted work never ships. A repository with no `origin` remote builds its local `main` and pushes nothing (tags and version bumps stay local). It:

1. Fetches `main` and reads the version.
2. Asks App Store Connect whether that version is still open, for iOS and for the Mac App Store. Once App Review approves a version it takes no more builds, so ship opens a pull request, `chore: start version X`, that bumps the patch number on `main`. The build already carries the new version, and a new version builds every platform. Until the pull request is merged, `ship release` keeps waiting on iOS (Android promotes the newest internal build as before), and later betas reuse the same pull request and build only the platforms asked for. This needs the `gh` CLI, signed in.
3. Takes one UTC instant for the whole run and derives both build numbers from it (see below).
4. Runs your `checks` in the worktree, then builds.
5. Uploads, tags the commit `v<version>-<build>`, pushes the tag.
6. For iOS, waits for Apple's processing, writes "What to Test", adds the build to each `externalGroups` group, and submits it for Beta App Review. An older build of the same version still waiting in Beta App Review is expired so the new one is not blocked.

**Release.** `ship release` runs `ship beta` first, then submits, so one command takes main all the way to review. A platform whose build of main's head commit is already uploaded (its build tag names that platform) skips the build, so a re-run or a quiet night never uploads a duplicate. If the build fails, nothing is submitted. It then sends the newest processed TestFlight build of the current version to App Review, with notes made from the `feat:`, `fix:` and `perf:` commits since the live build. A submission still waiting for review is withdrawn and replaced, so each night's release carries every build of the day. On Android it promotes the newest internal build to production and replaces a production release that is still in review, carrying its notes over.

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
| `version` | Where the version lives. `{ "file": "VERSION" }` for a plain file, `{ "file": "app.json", "json": "expo.version" }` for JSON, `{ "file": "project.yml", "yaml": "settings.base.MARKETING_VERSION" }` for YAML, `{ "file": "App.xcodeproj/project.pbxproj", "regex": "MARKETING_VERSION = ([0-9.]+);" }` for anything else (the first capture group; every match must agree). Edits are targeted: JSON keeps its formatting, YAML changes every line whose key matches the last segment (XcodeGen files often repeat `MARKETING_VERSION` per target), and a regex rewrites every match. |
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
| `ios.listing` | Optional repo-relative store listing, read from main: a JSON file or a fastlane metadata folder (see `ios.listingFormat`). `ship listing` pushes all of it; each App Review submission also sends its description and keywords. Both stores' descriptions get "A sidequest by Darkroom Engineering Incubator." as their last line unless they already have it. |
| `ios.listingFormat` | `json` (default) or `fastlane`. See [Store listing](#store-listing). |
| `ios.update` | Expo only. Turns on `ship update`: `channel`, a pinned `easCli` (`"eas-cli@23.1.0"`), optional `environment` (passed as `eas update --environment`), `nativeInputs` (repo-relative git pathspecs for everything that changes the binary) and optional `envCheck` (`{ "key", "value" }`). See [Over-the-air updates](#over-the-air-updates). |
| `android.dir` | Folder with `gradlew`. |
| `android.versionCodeProperty` | Gradle property that receives the version code (`-P<name>=<code>`). |
| `android.playKey` | Play service account JSON. Without it a bundle is built and left in `~/Desktop/<Name>-Android/` for a manual upload. |
| `versionFiles` | More files that carry the version: `{ "file", "json" }`, `{ "file", "yaml" }`, `{ "file", "regex" }` (the first capture group is the version) or `{ "file" }` for a plain file. Validated only; nothing stamps them yet. |
| `changelog` | Repo-relative changelog file, default `CHANGELOG.md`. The mac lane requires a section for the version and puts it in the update window. |
| `buildNumber` | `"time"` (default): the UTC time of the run, see [Build numbers](#build-numbers). `"githubRun"`: the GitHub Actions run, for apps whose feed already carries run-derived builds. |
| `secrets` | `{ "name", "path" or "env", "onePassword", "restoreHint" }` for each secret the release needs: where it lives, the 1Password item that holds it, and how to get it back. Validated only. |
| `gates` | Shell commands `ship ci` runs in the checkout before any lane. |
| `mac` | Mac app for direct download with Sparkle. See [Mac direct download](#mac-direct-download). |
| `macAppStore` | Mac App Store app. See [Mac App Store](#mac-app-store). |
| `windows` | A Velopack app: see [Windows](#windows). |
| `linux`, `tauri` | Optional `dir`, `copy`, `checks`. No lane yet. |
| `npm` | `package`, and optional `dir`, `copy`, `checks`. No lane yet. |

A config needs at least one target. Asking for a target with no lane (`ship beta linux`) fails with "lane not implemented yet (INC-998/999/1000)", and so does a command run for every target when the config has one of them, so half an app is never released by accident; pass `ios`, `android`, `mac`, `macAppStore` or `windows` to run only those.

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

### Store listing

`ship listing [ios|android] [--dry-run]` pushes the store listing from `ios.listing` on main. It never submits anything for review: the App Store text waits on the version until `ship release` sends it, and the Play edit is committed with `changesNotSentForReview=true`, which asks Play not to send the change for review. Every field is read and checked against the stores' limits (App Store name 30, subtitle 30, keywords 100, promotional text 170, description 4000; Play title 30, short description 80, full description 4000) before either store is called. A dry run reads App Store Connect and prints what would change, and does not contact Play.

- **App Store**, on the version on main, which must still be in preparation: name, subtitle and privacy policy URL; description, keywords, promotional text, support and marketing URLs; the copyright, always "© <year> Darkroom Engineering LLC"; and screenshots, sorted into sets by their pixel size. Only changed fields are written, and a set whose screenshots already match is not uploaded again.
- **Google Play**, en-US: title, short and full description, and phone screenshots (2 to 8).
- **App Privacy** answers are checked and printed but not sent: App Store Connect takes them only from a signed-in Apple ID, not the API key ship uses. Enter them in App Store Connect.

`json` is nocam's `shared/store/listing.json`: `name`, `subtitle`, `promotionalText`, `keywords`, `description`, `supportUrl`, `marketingUrl`, `privacyPolicyUrl`, and `play` with `shortDescription`, `fullDescription` and an optional `title` (the name otherwise). Optional `screenshots: { "ios": dir, "android": dir }` and `privacy` (a fastlane `app_privacy_details.json`) are repo-relative, or `~`/absolute paths for screenshots generated outside the repo.

`fastlane` is a deliver metadata folder such as `ios/fastlane/metadata`: `en-US/*.txt` for the App Store, supply's `android/en-US/*.txt` and `android/en-US/images/phoneScreenshots/` for Play, screenshots from `../screenshots/en-US/`, and App Privacy from `../app_privacy_details.json`.

### Build numbers

One instant per run. iOS and Mac get `yyyyMMddHHmm` in UTC. Android gets minutes since the Unix epoch minus 29,000,000 (the formula nocam already uses). The Android code maps back to the same iOS-style build number, which is how `ship release` finds the release tag for a Play build.

With `"buildNumber": "githubRun"` the build number comes from the GitHub Actions run instead, as Programa's release workflow makes it: the CI run id and attempt plus the release attempt for a `workflow_run` release, `<run id>001001` for a push, `<run id>001<attempt>` for a manual run. Programa's feed already holds these 17-digit builds, and a `yyyyMMddHHmm` build could never pass them. Such an app releases from CI; a dry run on a Mac falls back to the time and says so, and a real run refuses.

### Expo apps

The Expo build is the shell script in `lib/expo-ios.sh`. It runs `expo prebuild`, `pod install` with Hermes built from source under Apple's `tar` (GNU tar leaves `._*` files in frameworks), archives, checks the archive for stray `._*` files, fixes Hermes' `MinimumOSVersion`, generates its dSYM, checks dSYM coverage for the embedded frameworks, and exports or uploads. The clean worktree needs `node_modules`, so `ship beta` runs `bun install --frozen-lockfile` first. Expo apps reuse one worktree between runs (`~/Library/Caches/shipit/<app>-<hash>/worktree`), reset to the commit being built, so Pods and Xcode's derived data stay warm; untracked files are cleaned and ignored files are kept.

### Over-the-air updates

Over-the-air updates are for JavaScript and asset changes only. Anything native (modules, pods, patches, config plugins, the Expo SDK, `runtimeVersion`) ships as a store build through `ship beta`, after a `runtimeVersion` bump. An update reaches every build with the same runtime version, so JavaScript that needs native code those builds lack can crash them.

`ship update "what changed"` publishes the checkout's JavaScript bundle with `bunx <easCli> update --channel <channel> --non-interactive` from the Expo project folder (the parent of `ios.dir`). EAS updates are unsigned unless the account is on Expo's Enterprise plan, so these guards are what tie a published bundle to a reviewed commit. It refuses to publish when:

- the working tree has uncommitted or untracked changes, or a tracked file is marked assume-unchanged or skip-worktree;
- `HEAD` is not `origin/main` after a fetch (a repository with no `origin` is refused);
- a path in `nativeInputs` changed since the commit that set the current `expo.runtimeVersion` in `app.json`. That commit is found by parsing every revision of `app.json`: it is the oldest commit of the newest unbroken run with the current value, so reformatting `app.json` never moves it. A revision that is not valid JSON, or a shallow clone that cannot reach the commit, is refused. `runtimeVersion` must be a literal string, not a policy;
- with `envCheck`, a `.env*` file in the Expo project folder (except `*.example`) sets `key` to anything other than `value`, including an empty value. These files are gitignored, so the clean-tree check cannot see them, but Expo inlines them into the bundle.

Every guard runs and prints its result, so one run lists every problem. Then it runs `bun install --frozen-lockfile`, runs every guard again (and refuses if `HEAD` moved), and publishes with the message `what changed (<short sha>)`. `--dry-run` runs every guard and prints the install and publish it skipped. `SHIP_ALLOW_NATIVE_DIFF=1` publishes despite native changes, after you have confirmed none of the listed files changes the binary; the message gets ` [native-diff-override]`.

## Mac direct download

`ship beta mac` builds main in a clean worktree, as the phone lanes do, and publishes a Developer ID signed, notarized DMG to the app's Sparkle feed. `ship release mac` runs the same beta: a Mac app has one feed and no channels yet, so the published beta is the release and there is nothing to promote. Steps, in order:

1. **Preflight.** `CHANGELOG.md` (or `changelog`) has a section for the version, headed `## 1.2.3` or `## [1.2.3] - date`. The build number is higher than every build in the published appcast, read from `feedUrl` (builds compare as whole numbers of any length). The Sparkle private key matches `publicKey`: in CI the key in `SPARKLE_PRIVATE_KEY` is checked before anything runs, on a Mac the keychain key (`generate_keys --account <sparkleAccount> -p`) right after Swift packages resolve, before the build. A `command` build names where Sparkle's tools are (below). The hosting is ready (below). Any failure stops the run.
2. **Stamp and build.** For an Xcode build, `xcodegen generate` first when `kind` is `xcodegen`, then `xcodebuild archive` with `MARKETING_VERSION`, `CURRENT_PROJECT_VERSION` and `ARCHS` set and signing off. For a `command` build, `build` runs with `bash -c` from the repository root, with `SHIP_VERSION` and `SHIP_BUILD_NUMBER` set, and must leave the app at `app`; ship copies it and sets `CFBundleShortVersionString` and `CFBundleVersion` itself. The app must embed Sparkle either way. ship writes `feedUrl` and `publicKey` into the app's `SUFeedURL` and `SUPublicEDKey` (the keys must already be in its Info.plist) and checks the bundle id, version and build.
3. **Sign** inside-out with the hardened runtime and a timestamp: Sparkle's XPC services (keeping their entitlements), `Autoupdate`, `Updater.app` and the framework, then each `sign` entry (with its `helperEntitlements`), then the app with `entitlements`. Never `--deep`, which would copy the app's entitlements onto every helper. Then `codesign --verify --deep --strict`.
4. **Verify.** The app carries every `requiredEntitlements` key and no `forbiddenEntitlements` key; `sign` entries without their own entitlements carry neither; Sparkle's parts and `sign` entries with `helperEntitlements` keep their own but no forbidden key; the main executable and each `binaries` entry hold exactly `architectures` (`lipo -archs`).
5. **Notarize** the app with `notarytool` and staple it, so a copy dragged out of the DMG works offline, and check it with `spctl -a -vv`.
6. **DMG** with `hdiutil`: the app and an Applications link, signed, notarized, stapled and checked with `spctl`.
7. **Appcast.** Sparkle's `generate_appcast` (from `SPARKLE_BIN`, then `sparkleBin`, then the app's SwiftPM artifacts) extends the published appcast, makes deltas from the newest `deltas` releases, embeds the CHANGELOG section as the update notes, and signs the archive and, when the app sets `SURequireSignedFeed`, the feed. Each build's DMG is `<dmg base>-<build>.dmg`, a URL that never changes, because Sparkle rejects an archive whose bytes changed under a signed URL (error 4005). The appcast is checked, never edited, and kept as `appcast-<build>.xml` in `~/Library/Caches/shipit/<app>-<hash>/appcasts/` and on the host, for rollback.
8. **Upload** archives first, then `appcast-<build>.xml`, then `appcast.xml`, then the stable `dmg` name, so the feed never names a file that is not there. On GitHub an archive that already exists stops the upload, since `gh` uploads it without `--clobber`; on R2 `aws s3 cp` would overwrite it, so there only the per-build names keep archives apart.
9. **Tag** `v<version>-<build>`, as every lane does.

`--dry-run` prints every command it would run and runs none of them; it reads the public feed to check the build number and reports what a real run would refuse, then keeps printing. `--skip-upload` runs everything through the appcast, notarization included, and prints the uploads instead of running them; nothing is published or tagged. `ship ci` runs the mac lane as a dry run, like every lane.

```jsonc
{
  "name": "Programa",
  "version": { "file": "GhosttyTabs.xcodeproj/project.pbxproj", "regex": "MARKETING_VERSION = ([0-9.]+);" },
  "changelog": "CHANGELOG.md",
  "buildNumber": "githubRun",
  "mac": {
    "scheme": "programa",
    "bundleId": "com.darkroom.programa",
    "app": "Programa.app",
    "architectures": ["arm64"],
    "feedUrl": "https://github.com/darkroomengineering/programa/releases/latest/download/appcast.xml",
    "publicKey": "K4pw6WgryZqN0NI9t/FaNdroYWdSSuy2gejC3utPCQQ=",
    "entitlements": "programa.entitlements",
    "sign": ["Contents/PlugIns/ProgramaDockTilePlugin.plugin", "Contents/Resources/bin/programa", "Contents/Resources/bin/programa-mcp"],
    "requiredEntitlements": ["com.apple.security.cs.allow-jit", "com.apple.security.device.camera"],
    "forbiddenEntitlements": ["com.apple.security.cs.disable-library-validation"],
    "binaries": ["Contents/Resources/bin/programa"],
    "dmg": "programa-macos.dmg",
    "hosting": { "type": "github", "repo": "darkroomengineering/programa", "tag": "rolling" },
    "checks": ["git submodule update --init --recursive", "./scripts/download-prebuilt-ghosttykit.sh"]
  }
}
```

browsee's feed stays on R2:

```jsonc
"mac": {
  "kind": "xcodegen",
  "dir": "mac",
  "scheme": "browsee",
  "bundleId": "com.darkroom.browsee",
  "app": "browsee.app",
  "feedUrl": "https://updates.browsee.app/appcast.xml",
  "publicKey": "/v8xMtkp3VzK22CyAGfZTkbyW0u+5haIT+uEZ7nu970=",
  "sparkleAccount": "browsee",
  "notaryProfile": "browsee-notary",
  "entitlements": "mac/Support/browsee.entitlements",
  "sign": [
    "Contents/Frameworks/Chromium Embedded Framework.framework/Versions/A/Libraries/*.dylib",
    "Contents/Frameworks/Chromium Embedded Framework.framework",
    "Contents/Frameworks/browsee Helper (GPU).app",
    "Contents/Frameworks/browsee Helper (Renderer).app",
    "Contents/Helpers/browsee-mcp"
  ],
  "helperEntitlements": {
    "Contents/Frameworks/browsee Helper (GPU).app": "mac/Support/browsee Helper (GPU).entitlements",
    "Contents/Frameworks/browsee Helper (Renderer).app": "mac/Support/browsee Helper (Renderer).entitlements"
  },
  "dmg": "Browsee.dmg",
  "hosting": { "type": "r2", "bucket": "browsee-updates", "accountId": "<account id>", "profile": "browsee-r2" }
}
```

| Key | Meaning |
| --- | --- |
| `mac.kind` | `xcodeproj` (default) builds the project in `dir`; `xcodegen` runs `xcodegen generate` first; `command` runs `build` instead of Xcode. |
| `mac.scheme` | Xcode scheme. Required for `xcodeproj` and `xcodegen`, refused for `command`. |
| `mac.build` | `command` only: the shell command that builds the app, run from the repository root with `SHIP_VERSION` and `SHIP_BUILD_NUMBER` set, such as `scripts/bundle.sh`. |
| `mac.bundleId` | The bundle id the built app must have. |
| `mac.dir`, `mac.copy`, `mac.checks` | As for iOS. `checks` run in the worktree before the build, so they can also fetch what the build needs. |
| `mac.app` | Xcode builds: the built bundle's name, default `<name>.app`. `command`: required, the repo-relative path the command leaves the app at, such as `target/release/codigo.app`; its last segment is the bundle name. |
| `mac.architectures` | `arm64` and/or `x86_64`. Default `["arm64"]`. Passed to an Xcode build as `ARCHS`, and verified for every build. |
| `mac.sparkleBin` | Folder with Sparkle's `generate_keys` and `generate_appcast`, for an app that does not get them from SwiftPM. `~` expands; a relative path is in the repository. `SPARKLE_BIN` wins over it. A `command` build needs one of the two. |
| `mac.feedUrl` | The app's `SUFeedURL`. Required. ship never changes it; it must be a URL the hosting serves. |
| `mac.publicKey` | The app's `SUPublicEDKey`, the key installed copies trust. Required. ship never changes or regenerates it. |
| `mac.sparkleAccount` | Keychain account of the Sparkle private key on a Mac. Default `ed25519`, Sparkle's own default. |
| `mac.entitlements` | Repo-relative entitlements file for the app. |
| `mac.sign` | App-relative nested code to sign before the app, deepest first, such as helpers and command-line tools. `*` matches within one path segment (`Contents/Frameworks/browsee Helper*.app`). Each entry must exist. Sparkle's parts are signed without listing them. |
| `mac.helperEntitlements` | Entitlements files for `sign` entries, keyed by the same path. |
| `mac.requiredEntitlements`, `mac.forbiddenEntitlements` | The entitlement allow and deny lists checked after signing. |
| `mac.binaries` | More Mach-O files whose architectures are checked, besides the main executable. |
| `mac.notaryProfile` | `notarytool` keychain profile for runs on a Mac. Without one, and always when `CI` is set, notarytool uses the App Store Connect key from [Credentials](#credentials). |
| `mac.deltas` | Previous releases generate_appcast makes delta updates from. Default 1. |
| `mac.dmg` | The stable download name, always the newest DMG. Default `<name>-mac.dmg`. Set it when the app already publishes another name (`Browsee.dmg`, `programa-macos.dmg`). |
| `mac.hosting` | `{ "type": "github", "repo", "tag" }`: archives on one GitHub release, with the feed at `releases/latest/download/appcast.xml` (the release must be the latest) or `releases/download/<tag>/appcast.xml`; uploads with `gh`. `{ "type": "r2", "bucket", "accountId", "profile" }`: an R2 bucket served at the feed's domain, with the feed at `/appcast.xml`; uploads with the `aws` CLI, and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` win over the profile. |

Signing and Sparkle need, besides the App Store Connect key:

| What | On a Mac | In CI |
| --- | --- | --- |
| Developer ID Application certificate | In the keychain; ship picks team `APPLE_TEAM_ID` (default ZNHHMX2RP6), or set `SIGN_IDENTITY` | Imported into the runner's keychain before ship runs; set `SIGN_IDENTITY` |
| Notarization | `xcrun notarytool store-credentials <notaryProfile>` once | The App Store Connect key (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `KEY_PATH`) |
| Sparkle private key | Login keychain, account `sparkleAccount` | `SPARKLE_PRIVATE_KEY`, written to a mode-600 file for generate_appcast and deleted after |
| Hosting | `gh auth login`, or the aws profile | `GH_TOKEN` with contents write, or the aws keys |

## Mac App Store

`ship beta macAppStore` builds main in a clean worktree, packages it for the Mac App Store and uploads it to App Store Connect, where it lands in TestFlight. `ship release macAppStore` runs that beta, then sends the newest processed build of the version to App Review exactly as iOS does (same notes, same withdraw-and-replace of a submission still in review), on the app's macOS platform and without a store listing. The lane is a port of codigo's `scripts/appstore.sh`. Steps, in order:

1. **Preflight.** The provisioning profile exists, the App Store Connect key loads, and the keychain has the team's store identities: `Apple Distribution` (or `3rd Party Mac Developer Application`) for the app and `3rd Party Mac Developer Installer` (or `Mac Installer Distribution`) for the package. `APP_STORE_IDENTITY` and `APP_STORE_INSTALLER_IDENTITY` override the lookup.
2. **Build** unsigned, as the mac lane does: an Xcode archive, or `build` from the repository root with `SHIP_VERSION` and `SHIP_BUILD_NUMBER` set.
3. **Fill in the app.** The profile becomes `Contents/embedded.provisionprofile`, `privacyManifest` becomes `Contents/Resources/PrivacyInfo.xcprivacy`, and `plutil -replace` writes each `infoPlist` entry, then `CFBundleShortVersionString` and `CFBundleVersion`. The bundle id must be `bundleId`.
4. **Sign** the app with the hardened runtime, a timestamp and `entitlements`, remove quarantine attributes (App Store Connect refuses them), verify the signature, and check the main executable holds exactly `architectures`. Only the app itself is signed: an app with embedded frameworks or helpers needs them signed by its build, or verification fails.
5. **Package** with `productbuild --component <app> /Applications`, signed with the installer identity, and check it with `pkgutil --check-signature`.
6. **Validate and upload** with `xcrun altool --validate-app`, then `--upload-package --wait`, authenticated with the App Store Connect key from [Credentials](#credentials). altool can exit 0 when App Store Connect refuses the package, so a log line with `UPLOAD FAILED`, `BUILD-STATUS: FAILED`, `IMPORT-STATUS: FAILED` or `ERROR ITMS-` fails the run. Logs are in `~/Library/Caches/shipit/<app>-<hash>/appstore-<build>/`.
7. **Tag** `v<version>-<build>`, as every lane does.

`--dry-run` prints every command and runs none. `ship beta macAppStore --skip-upload` stops after validation and tags nothing; `ship release` takes `--skip-upload` only for the mac lane, since a store release would otherwise submit an older build. `ship ci` runs the lane as a dry run.

codigo's block, a Rust app built by `cargo` through its own script:

```json
"macAppStore": {
  "kind": "command",
  "build": "scripts/bundle.sh",
  "app": "target/release/codigo.app",
  "bundleId": "dev.darkroom.codigo",
  "entitlements": "assets/appstore/codigo.entitlements",
  "privacyManifest": "assets/appstore/PrivacyInfo.xcprivacy",
  "provisioningProfile": "~/.appstoreconnect/codigo/codigo_Mac_App_Store.provisionprofile",
  "infoPlist": {
    "CFBundleDisplayName": "codigo",
    "CFBundleInfoDictionaryVersion": "6.0",
    "CFBundleSupportedPlatforms": ["MacOSX"],
    "LSMinimumSystemVersion": "13.0",
    "ITSAppUsesNonExemptEncryption": false,
    "NSHumanReadableCopyright": "Copyright 2026 Darkroom Engineering LLC"
  }
}
```

| Key | Meaning |
| --- | --- |
| `macAppStore.kind`, `scheme`, `build`, `app`, `bundleId`, `architectures`, `dir`, `copy`, `checks` | As for `mac`. |
| `macAppStore.entitlements` | Required. Repo-relative entitlements file; the store needs at least the App Sandbox. |
| `macAppStore.provisioningProfile` | Required. The Mac App Store provisioning profile. `~` expands; a relative path is in the repository. |
| `macAppStore.privacyManifest` | Repo-relative `PrivacyInfo.xcprivacy` copied into the app. |
| `macAppStore.infoPlist` | Info.plist keys written before signing: strings, `true`/`false`, or arrays of strings. Use it for what the store needs and the build leaves out, such as `LSMinimumSystemVersion` and `ITSAppUsesNonExemptEncryption`. |

## Windows

`ship beta windows` builds a Velopack installer and update feed, signs them, and puts them on a GitHub release. Velopack only builds on Windows, so the lane runs on a GitHub Actions Windows runner:

- **On Windows** (a runner, or `ship ci` there) ship builds in the clean worktree: runs `publish`, installs the pinned `vpk` and runs `vpk pack`, which signs every binary it packs, `Update.exe` and `Setup.exe` with Azure Artifact Signing. It then checks `Get-AuthenticodeSignature` reports `Valid` for `Setup.exe` and for the main exe inside the full package (vpk signs a copy of `publishDir`, so the folder itself stays unsigned), copies `Setup.exe` to a stable `<packId>-x64-setup.exe` and a versioned `<packId>-<version>-<build>-x64-setup.exe`, checks the copies are byte-identical (SHA-256) and still `Valid`, and uploads them with the feed (`releases.win.json` and the `.nupkg`) to `release.tag` in `release.repo`. Packages go up before the stable name and the feed, so the feed never names a file that is not there yet. A release that does not exist yet is created as a draft and published only after every lane passed and the build is tagged. `ship release windows` publishes it again, also when it skips the build because main's head already carries a windows tag, so a beta that tagged but failed before publishing is finished by the next release.
- **On a Mac** ship dispatches the app's `workflow` with `gh workflow run`, passing the version, build number, commit and a fresh `dispatch_id`, and follows that run with `gh run watch`. The caller's `run-name` must include `inputs.dispatch_id`: ship finds its own run by that id, never by time, and fails if it does not show up within a minute. The runner builds that commit as that build into the same release and leaves tagging and publishing to the Mac run, so every lane of one run shares one build number and one release.
- **`--dry-run`** on a Mac prints every command the dispatch and the runner would run and calls nothing remote. On Windows it builds and packs without signing and prints the uploads it skipped.

Velopack's version is `<version>-build.<build>`, so every build is an update even when the version has not moved. Each build uploads full packages only; delta packages are not made yet.

```jsonc
"windows": {
  "dir": "windows",                       // where publish runs
  "publish": "dotnet publish Mesinyer.Windows/Mesinyer.Windows.csproj -c Release -r win-x64 -p:Platform=x64 --self-contained true -o publish",
  "publishDir": "publish",                // relative to dir; vpk packs this folder
  "packId": "Mesinyer",                   // Velopack id; never change it, installed copies update by it
  "packTitle": "Mesinyer",                // default packId
  "mainExe": "Mesinyer.Windows.exe",
  "runtime": "win-x64",                   // or win-arm64, win-x86
  "channel": "win",                       // default win
  "vpk": "1.2.161",                       // same version as the Velopack NuGet package in the app
  "workflow": "ship-windows.yml",         // default; the caller workflow below
  "release": { "repo": "darkroomengineering/mesinyer-releases", "tag": "rolling" },
  "signing": {                            // null or absent: unsigned, with a warning on every run
    "endpoint": "https://eus.codesigning.azure.net/",
    "account": "darkroom",
    "profile": "darkroom-public",
    "publisher": "Darkroom Engineering"   // default
  }
}
```

`publish` runs in PowerShell with `SHIP_VERSION`, `SHIP_BUILD_NUMBER` and `SHIP_COMMIT` set; chain several commands with `&&` so a failure stops it. `copy` and `checks` apply on the Windows runner only.

**Signing.** Without `signing` the installer ships unsigned and SmartScreen warns everyone who runs it; ship says so on every run. Signing uses the `sign` CLI against Azure Artifact Signing (formerly Trusted Signing) with the Azure CLI login that `azure/login` makes over OIDC, as Programa's `docs/windows-signing.md` sets up: an Artifact Signing account and Public Trust certificate profile, an Entra app registration with a federated credential for the app repository's `main` branch, and the "Trusted Signing Certificate Profile Signer" role. A `signing` block with no Azure login fails the build instead of shipping unsigned.

**The caller workflow.** Each app adds `.github/workflows/ship-windows.yml`, which `ship beta windows` dispatches and which also runs by hand from the Actions tab:

```yaml
name: ship-windows
run-name: ship windows ${{ inputs.dispatch_id || github.sha }}
on:
  workflow_dispatch:
    inputs:
      version: { type: string, default: "" }
      build: { type: string, default: "" }
      commit: { type: string, default: "" }
      dispatch_id: { type: string, default: "" }
      dry-run: { type: boolean, default: false }
permissions:
  contents: write
  id-token: write
jobs:
  windows:
    uses: darkroomengineering/shipit/.github/workflows/windows-lane.yml@main
    with:
      version: ${{ inputs.version }}
      build: ${{ inputs.build }}
      commit: ${{ inputs.commit }}
      dry-run: ${{ inputs.dry-run }}
      azure-client-id: ${{ vars.AZURE_CLIENT_ID }}
      azure-tenant-id: ${{ vars.AZURE_TENANT_ID }}
      azure-subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
    secrets:
      shipit-token: ${{ secrets.SHIPIT_TOKEN }}     # read access to darkroomengineering/shipit
      release-token: ${{ secrets.RELEASES_TOKEN }}  # write access to release.repo when it is another repository
```

shipit is private, so its Actions settings must allow access from the organization's repositories, and the runner checks it out with `shipit-token`. Run by hand with no inputs, the workflow is a whole `ship beta windows` on the runner: it picks the build number, tags and publishes. With `dry-run` it runs `ship ci windows`. Packages are kept as a run artifact either way.

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

`ship nightly` scans `~/Developer/*/ship.json` and `~/Developer/*/*/ship.json`, so apps grouped in a folder such as `~/Developer/@darkroom` are found too. It skips `node_modules`, `.worktrees` and dot folders, and does not look inside a project for more projects. Set `SHIPIT_PROJECTS` to scan another folder. For each project it runs `ship release` when `nightly` is `true` (which builds main first when it has commits no beta carries yet), and a keep-alive beta when `ios.keepAlive` is due. Projects run one after another and one failure never stops the others; the exit code is non-zero if any failed, and a macOS notification names them. With `--dry-run` it reports what would run and builds nothing.

```sh
ship install-launchd --dry-run   # print the agent
ship install-launchd             # write ~/Library/LaunchAgents/com.frz.shipit.nightly.plist
```

The agent runs `ship nightly` at 03:00 with a PATH that includes `/opt/homebrew/bin` and `~/.bun/bin`, and with GitHub over HTTPS using `gh auth git-credential`, because the SSH agent can refuse to sign while the Mac is locked. The command writes the file only. It prints the `launchctl bootstrap` and `bootout` commands to load it and to unload the older per-app agents; run those yourself. Logs go to `~/Library/Logs/shipit-nightly.log`.

## Other commands

- `ship ci`: for CI runners; on Windows it builds the windows lane (see [Windows](#windows)). It refuses unless the checkout is clean and `HEAD` is `origin/main` after a fetch, records that commit, runs `gates`, builds every lane from that commit as a dry run (the mac lane prints its plan), and checks `origin/main` has not moved before it would publish. Publishing is not wired in yet, so it releases nothing.
- `ship update "what changed"`: publishes main as an over-the-air update for Expo apps; see [Over-the-air updates](#over-the-air-updates).
- `ship status`: the latest TestFlight build and its beta review state, App Store version states, and Play internal and production versions.
- `ship doctor`: tools (`xcodebuild`, `xcodegen` or `pod`, `bun`, `java` for Android), credentials, the key file, the App Store Connect app, each external group, the Play key, and for Expo apps a warning when `ios/.xcode.env.local` points `NODE_BINARY` at a node that no longer exists.

Only one `ship` run works on an app at a time; a second exits with code 75.
