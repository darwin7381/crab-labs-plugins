# codex-runner — Codex as an Onsen member (WO-184 part 2)

Codex (OpenAI Codex CLI) is the Onsen member `codex`. This program is the part of it that takes work. It is one resident Bun process on the Mac mini, run by launchd as `com.btai.codex-runner`.

- An agent hands Codex work with `send_to_agent(to: "codex", line: "call", …)`. The answer comes back the way every Call's answer does: as a reply linked to the Call.
- Joey talks to Codex on the Onsen page. The answer is recorded in his conversation with Codex.
- In both cases the request, the progress and the result live in Onsen, including the files Codex makes.

## What it does

1. The runner peeks at `GET /v1/members/codex/items`. When a worker and the Item’s thread are free it takes that Item by ID. Other work waits in Onsen. A member still on pull logs the refusal and retries after 60 seconds. A competing connector waits 45 seconds.
2. Calls use their thread’s Codex session. A Call without a thread starts a new one and its reply carries the new thread. Page and Telegram messages use the chat’s existing session, or the Onsen conversation if the message has no chat. The request, quoted context and attachments come from the Item granted by take.
3. The runner reports `in_session` when it accepts a job, then downloads attachments, prepares the repository and starts `codex exec`. Its member observation renews held Item IDs every 15 seconds, including during intake pauses. At most `CODEX_RUNNER_MAX` sessions run concurrently.
4. A peer receives a reply linked to the Call and thread. A person receives a reply in their conversation. Alerts and schedules record their result on the Call. Once work finishes, the runner spools `Call.result` and a `completed` Item report with the confirmed response message IDs. A failed job records outcome `failed`. Three successful reply responses without a valid ID end the job with a diagnostic in its report.
5. The report spool and session state survive restart. The runner observes surviving children, checks the saved events and final message for exited children, and retries unfinished replies with the same identity.

## Codex's own home

The member runs with a Codex home of its own, not the Mac's personal one (Chiron 08:49Z note 2). Until 0.29.2's runner it used the personal setup: 26 enabled plugins (Gmail, Google Drive, GitHub, Slack, Notion, Cloudflare, context7, browser and computer use among them), the `node_repl` and `computer-use` MCP servers, 15 skills in `~/.codex/skills` and 8 in `~/.agents/skills`, the personal `AGENTS.md`, a notify hook and memories.

- `CODEX_HOME=~/onsen-codex/.codex-home` and `HOME=~/onsen-codex/.codex-home/home` for the child. `HOME` matters because Codex reads `$HOME/.agents/skills` whatever its home is.
- `config.toml` keeps only the personal `model` and `model_reasoning_effort` lines. It has no MCP servers and no plugins, and it turns off apps, hooks, memories, browser and computer use, and the bundled skills. Image generation stays on.
- The login is the personal home's `auth.json`, through a symlink, and `auth.lock` is linked too. That way there is one login and one refresh token. Codex writes a refreshed token through the link (`resolve_auth_file`) and takes the same lock. A copy would be a second holder of the same refresh token, and when either side refreshed, the other would be logged out.
- The child's environment has none of the runner's settings (`CODEX_RUNNER_*`, `ONSEN_*`).
- If the home is missing, each item fails with a note that names `--setup`. It never falls back to the personal setup. `CODEX_RUNNER_CODEX_HOME=inherit` opts back into the inherited home on purpose.
- `--setup` makes it once and is safe to run again:

  ```sh
  bun codex-runner.ts --setup          # writes config.toml, links auth.json and auth.lock, copies the runner's session rollouts, says "ready"
  bun codex-runner.ts --setup --force  # writes config.toml again, replaces a non-link auth.json
  ```

  It also copies the rollout files of the sessions the runner already has (from `state.json`) into the new home, so a thread started before the switch still resumes. It never reads or prints the login.

## Needs

- **Onsen with the WO-184 part 2 change** (fleet-core). It adds `POST /v1/conversations`, without which Joey cannot open a chat with Codex on the page. It also adds `attachment_file_ids` on the record route, so Codex's answers to Joey carry their files. Calls work without it. Against an older Onsen, the answer to a page message says where the files are.
- **A mesh credential for the identity `codex`**, kind `agent`, with the `mesh` scope. Its runtime stays empty: an identity whose runtime is set (other than claude-code) is a BTCC mailbox identity, and BTCC would not write its Onsen inbox. The credential file is `CODEX_RUNNER_CREDENTIAL_FILE`, mode 600.
- `codex` in the fleet roster (name, machine, desc; no url), so that `send_to_agent` finds it.
- The Codex CLI, logged in, for the same user: `codex exec` works in a terminal.

## Start, stop, roll back

```sh
mkdir -p ~/onsen-codex/.runner
sed "s#__HOME__#$HOME#g" com.btai.codex-runner.plist.example > ~/Library/LaunchAgents/com.btai.codex-runner.plist
bun codex-runner.ts --setup         # Codex's own home (below)
bun codex-runner.ts --whoami        # the credential reads; GET /v1/me says codex, kind agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-runner.plist
tail -f ~/onsen-codex/.runner/runner.log   # "codex-runner up", then its first status report makes the member
bun codex-runner.ts --profile       # once: display name Codex, role 外部模型（OpenAI Codex CLI）：審設計、寫程式、生圖, takes_work
```

- **First take-only deployment**. Quiesce new codex work and let the previous runner finish its jobs, replies, uploads and acks. Stop it only when its queue, workers and outstanding reports have drained. Keep its state directory. The new runner refuses to take over unfinished jobs from the pull version. See the [C7 cutover](../docs/C7-spec.md).
- **Subsequent take-only update** (git pull of the plugin checkout): `launchctl kickstart -k gui/$(id -u)/com.btai.codex-runner`. Runs in flight are followed by the new process. The first start of a runner with Codex's own home needs `--setup` before it.
- **Stop**: `launchctl bootout gui/$(id -u)/com.btai.codex-runner`.
  - Onsen shows Codex offline. Calls sent to it stay queued in Onsen, and the next start takes them.
  - Runs in flight keep going to their end. To stop them as well: `pkill -TERM -f 'codex exec --skip-git-repo-check -s workspace-write -C '"$HOME"'/onsen-codex'`.
- **Roll back**: stop it as above and remove the plist. Nothing else on the machine depends on it.
  - Retiring Codex also needs three more steps: revoke the credential (mesh_admin, A2A-COMMS 寄件人憑證), take `codex` out of the roster, and remove the folder.
  - A bad release: the plugin checkout back to the commit before it, then the restart above.

## Environment

| Variable | Default | |
|---|---|---|
| `CODEX_RUNNER_CREDENTIAL_FILE` | `~/.config/mesh/codex.credential` | the `codex` mesh credential; read again when the file changes |
| `ONSEN_BASE` | `https://core.kbro.ai/api/onsen` | |
| `ONSEN_HOST` | the host name | the member's machine in Onsen (the plist sets `macmini`) |
| `CODEX_RUNNER_ROOT` | `~/onsen-codex` | one folder per conversation |
| `CODEX_RUNNER_STATE_DIR` | `<root>/.runner` | `state.json`, `item-claims.json`, `onsen/spool.jsonl` and its cursor, `runner.pid` |
| `CODEX_RUNNER_LOG` | `<state dir>/runner.log` | also on stderr (launchd's err log) |
| `CODEX_RUNNER_MAX` | `3` | runs at once |
| `CODEX_RUNNER_TIMEOUT_S` | `1800` | a run's limit; `CODEX_RUNNER_KILL_GRACE_S` (10) between SIGTERM and SIGKILL |
| `CODEX_BIN` | `codex` | the plist gives the Homebrew path |
| `CODEX_RUNNER_SANDBOX` | `workspace-write` | `-s` |
| `CODEX_RUNNER_DEV_TIMEOUT_S` | `3600` | a `#dev` item's limit; stopped there, it goes on once in the same session before it counts as failed |
| `CODEX_RUNNER_DEV_REPOS` | the four below | more `#dev` shortcuts, `name=/abs/path,…` (bt-control-center, fleet-core, crab-labs-plugins, Joey-Crablabs-Skills are built in; any absolute path to a local git repo works without one) |
| `CODEX_RUNNER_DEV_PG` | `postgresql://postgres@127.0.0.1:55432` | the throwaway PostgreSQL the `#dev` brief names |
| `CODEX_RUNNER_MODEL`, `CODEX_RUNNER_EFFORT` | unset | the runner's own model and reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`: the CLI's list): every run gets `-m <model> -c model_reasoning_effort="<effort>"`, and `--setup` writes them into Codex's own `config.toml`. Never the personal `~/.codex/config.toml`'s (Chiron mesh 13227). Unset: Codex's own home's config decides |
| `CODEX_RUNNER_DEV_EFFORT` | `max` | the effort of a `#dev` item (Chiron #200750); ordinary calls keep `CODEX_RUNNER_EFFORT`. `ultra` is accepted, not the default (not measured with the sandbox and the time limit) |
| `CODEX_RUNNER_AGENT` | `codex` | the member name (must be the credential's identity) |
| `CODEX_RUNNER_WAIT_S` | `25` | the long polls |
| `CODEX_RUNNER_CODEX_HOME` | `<root>/.codex-home` | Codex's own home (`CODEX_HOME` for the child); `inherit`: the inherited one |
| `CODEX_RUNNER_CHILD_HOME` | `<codex home>/home` | the child's `HOME` |
| `CODEX_RUNNER_AUTH_FROM` | `~/.codex` | `--setup`: the personal home whose `auth.json` is linked and whose sessions are carried over |

## Tests

`bun test codex-runner/codex-runner.test.ts` from `plugins/telegram-http`. The tests use a fake Onsen (`Bun.serve`) and a fake codex (`fake-codex.ts`), and nothing reaches Onsen or OpenAI. No tmux is involved.

## Development items (`#dev`, Chiron mesh 13257)

A Call whose first line is `#dev repo=<name or /abs/path> [branch=<name>]` is a development item:

- **The clone.** Before Codex starts, the runner clones the repo into the item's folder (`./repo`, `git clone --reference <the local copy>` from its origin, so the local copy is only read; a shallow local copy is not used as a reference, the clone then comes from origin alone; the `crab-labs-plugins` shortcut is Epeius's full clone, not the shallow live checkout) and checks out `codex/call-<id>` (or `branch=`) from origin's default branch; a branch already on origin goes on from there. A follow-up in the same session reuses the clone. A name the runner does not know, or a path that is not a git repo: the item fails, saying so.
- **The sandbox.** `workspace-write` plus `sandbox_workspace_write.network_access=true`, so tests can listen on 127.0.0.1 and reach the throwaway PostgreSQL (`CODEX_RUNNER_DEV_PG`). This also opens outbound network; only `#dev` items get it.
- **The brief.** Every `#dev` item starts with a fixed opening: change only `./repo`, small commits, never push or switch to main; never open credential files (`.env`, `*.credential`, `auth.json`, `.secrets`, `mesh-credential`); network only for local tests, its own database name; send nothing to anyone or any live service; the answer lists the commits, what ran here with numbers, what could not run (and why), and the questions for the owner, the two kept apart.
- **The time.** `CODEX_RUNNER_DEV_TIMEOUT_S` (3600 s). Stopped there, the runner goes on once in the same session ("時間到了… 接著做完"); stopped again, it fails.
- **The push.** After the run (completed or failed), the runner pushes that branch to origin: that branch only, never main, never forced. The answer always carries a block with the clone's path, the branch and its base, where it went (`推上去了：<origin> <branch> @ <sha>`) or why not, and the commits. The clone's files are not attached.
