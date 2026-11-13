# darky-body runner scripts

darky-body is the studio Mac that runs GitHub Actions jobs for the org's private repos. The rules are in [docs/standard.md](../docs/standard.md#9-the-studio-mac-runner-darky-body). Access details (SSH, accounts) live in the private Linear doc for INC-1077, not here.

## Add a runner

Run on darky-body as an admin, with a one-hour registration token from `gh api -X POST orgs/darkroomengineering/actions/runners/registration-token`:

```sh
sudo RUNNER_TOKEN=... ./add-runner.sh darky-body-ci-6 xcode-27,ci,darky-body
```

It copies an existing runner install, registers it in the `macbook-private` group, and starts it as a login LaunchAgent in the `runner` user's session. GitHub's own `svc.sh install` adds `SessionCreate`, which runs the job in a separate security session where the login keychain is locked; the script leaves it out.

## Move a repo's CI to darky-body

From the repo root:

```sh
python3 -I path/to/shipit/runner/convert-workflows.py --write .github/workflows/*.yml
```

It changes each ubuntu job to `runs-on: ${{ fromJSON(vars.CI_RUNNER || '"<old label>"') }}` and prints `KEEP` with the reason for jobs that need Linux. Without `--write` it only prints the plan.
