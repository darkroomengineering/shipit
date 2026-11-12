# Release standard

Every Darkroom Incubator app releases with `ship`. The standard that says how lives in Linear:
[Release standard: how every Incubator app ships](https://linear.app/darkroomengineering/document/release-standard-how-every-incubator-app-ships-38b2ccc8e74b).
That document is the source of truth. This page only tracks what shipit implements from it.

## TODO

This list names the topics the shipit tickets (INC-980, INC-997 to INC-1000, INC-1004) cover. Replace it with
the document's own section titles, and link each one, the next time someone copies from it.

- [ ] Targets and lanes: iOS, Android, Mac direct download, Mac App Store, Windows, Linux, Tauri, npm
- [ ] `ship.json` fields for version files, changelog, secrets and gates
- [ ] Releasing from CI: only a clean checkout of the current `origin/main` ships
- [ ] Store listings, including the shared credit line
- [ ] Nightly releases and TestFlight keep-alive
- [ ] Version bumps after App Review approval
