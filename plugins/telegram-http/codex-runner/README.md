# codex-runner — Codex as an Onsen member (WO-184 part 2)

Codex (OpenAI Codex CLI) is the Onsen member `codex`. This program is the part of it that takes work. It is one resident Bun process on the Mac mini, run by launchd as `com.btai.codex-runner`.

- An agent hands Codex work with `send_to_agent(to: "codex", line: "call", …)`. The answer comes back the way every Call's answer does: in the Call's result, and as a reply in the caller's inbox.
- Joey talks to Codex on the Onsen page. The answer is recorded in his conversation with Codex.
- In both cases the request, the progress and the result live in Onsen, including the files Codex makes.

## What it does

1. **Take.** It uses the codex credential and the same pull every daemon uses: `GET /api/onsen/inbox` (long poll) and `POST /inbox/ack`. That pull brings in Calls and replies to Codex's answers. It also polls `GET /api/onsen/forms/inbox` (long poll) for messages Joey writes on the page (items marked `say`).
   - Each item is first written to the state file, then acked.
   - Not work, acked and left alone: silent notices, mail bells, Action presses, and anything that is neither a Call nor a reply. A peer_call that arrives without its Call id is looked up by its number once after 35 s. If it still has none, it is a poke.
2. **Session.** A Codex session belongs to a thread, not to a whole conversation (Chiron's ruling, mesh 12527, 11-26 08:21Z; the same rule as our own agents, where a thread belongs to one session).
   - An agent's item that carries a thread (`payload.thread` or `refs.thread`) belongs to that thread's session. The first item starts it and the next ones resume it.
   - An item that carries no thread starts a new session with a new thread `codex#t-<12 hex>`. The answer carries that thread: the reply's `payload.thread` and `refs.thread`, and a line in the Call's result.
   - So the caller's `reply_to` of the answer resumes that session, because its daemon fills in the thread of the message it answers. A send with `thread=codex#t-…` resumes it too.
   - With Onsen 0.29.2 such a reply is a Call of its own in that thread, because Codex takes work (`members.takes_work`, declared by the runner at start): it gets accepted, running and completed, and its files on the result. Against an older Onsen it is a follow-up without a Call, and its answer still comes back as a reply.
   - Joey on the page has one session per DM, ongoing.
3. **Accept.** For a Call, it PUTs `accepted` to `/v1/calls/<id>/state`.
   - The session's folder is `~/onsen-codex/<Onsen conversation id>/<sub>/`. `<sub>` is the item's thread, `call-<id>` for a session started by a Call with no thread, or `dm` for Joey's DM. Two sessions never share a folder, so neither sees the other's new files.
   - The item's attachments are downloaded into that folder with the credential, only from Onsen's own origin.
4. **Run.** For a Call, it PUTs `running`. Then it runs:

   ```
   codex exec --skip-git-repo-check -s workspace-write -C <dir> --json -o <dir>/last-<n>.txt [-i <image>…] -- "<text>"   < /dev/null
   ```

   - The next items of a session use `codex exec --skip-git-repo-check -s workspace-write -C <dir> resume <session> --json -o … -- "<text>"`: `-s` and `-C` before `resume`, `--json`, `-o` and `-i` after it. `<session>` comes from `thread.started.thread_id` in the `--json` events of the session's first run.
   - stdout and stderr go to `<dir>/.codex-runner/run-<n>.jsonl` and `.stderr`.
5. **Finish.**
   - **Completed**: `result.body` is the last message.
     - Files new or changed in the folder by this run are uploaded with `POST /v1/files` and listed in `result.attachment_file_ids`. Hidden files and `last-<n>.txt` are excluded. At most 20 files, each at most 25 MB. Files over either limit are named in the body.
     - A peer's item also gets a reply with `POST /send`: kind `peer_call`, `reply_to_id` set to its number (for a follow-up without one, the number of the Call that started the session), the session's thread, the same files attached, and the file URLs and Mac mini paths in the text.
     - Always. An incoming `no_reply` means the caller owes Codex no answer; it never keeps Codex's answer to that work back (Chiron 08:49Z: a `reply_to` is always sent `no_reply`, and its answer reached no one).
     - A page message's answer is recorded with `POST /messages` and carries its files. Its delivery facts are delivered, in_session, seen and turn_end.
   - **Failed**: the exit code is non-zero, or the run passed `CODEX_RUNNER_TIMEOUT_S`. On timeout the process group gets SIGTERM, then SIGKILL 10 s later. `result.body` holds the error and the last 30 lines of stderr.
   - However codex ends, its process group gets SIGTERM, then SIGKILL 10 s later, so nothing it started lives on (Chiron 08:49Z note 3).
6. **Limits.**
   - At most `CODEX_RUNNER_MAX` items run at once, across sessions. The rest stay `queued` in Onsen. Onsen sets that state itself; the runner sends no PUT until it starts an item.
   - Two items of one session never run at once, because two resumes would interleave its history. The second waits for the first.
7. **Status.** It PUTs `/v1/members/codex/observation` at each change and every 15 s.
   - While alive it is online.
   - While any item is being worked on, the main session is running with `doing {kind: tool, tool: "codex exec"}`. The member page shows 「執行中・codex exec」.
   - Otherwise the main session is idle (閒置).
   - At a clean stop it reports offline.
8. **Restart.**
   - The runs in flight keep going in their own process groups, and the next start follows them.
   - A run whose process is gone is settled from what it left. If its events show the turn completed and the last message is there, it is completed. Otherwise it is failed, with a note.
   - Reports interrupted by a restart are sent again; each one is idempotent.

Codex never starts anything on its own, never reads a mailbox, and never posts on the wall. Its credential goes only to Onsen and is never logged.

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

- **Restart after a code update** (git pull of the plugin checkout): `launchctl kickstart -k gui/$(id -u)/com.btai.codex-runner`. Runs in flight are followed by the new process. The first start of a runner with Codex's own home needs `--setup` before it.
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
| `CODEX_RUNNER_STATE_DIR` | `<root>/.runner` | `state.json`, `onsen-inbox.json`, `runner.pid` |
| `CODEX_RUNNER_LOG` | `<state dir>/runner.log` | also on stderr (launchd's err log) |
| `CODEX_RUNNER_MAX` | `3` | runs at once |
| `CODEX_RUNNER_TIMEOUT_S` | `1800` | a run's limit; `CODEX_RUNNER_KILL_GRACE_S` (10) between SIGTERM and SIGKILL |
| `CODEX_BIN` | `codex` | the plist gives the Homebrew path |
| `CODEX_RUNNER_SANDBOX` | `workspace-write` | `-s` |
| `CODEX_RUNNER_AGENT` | `codex` | the member name (must be the credential's identity) |
| `CODEX_RUNNER_WAIT_S` | `25` | the long polls |
| `CODEX_RUNNER_CODEX_HOME` | `<root>/.codex-home` | Codex's own home (`CODEX_HOME` for the child); `inherit`: the inherited one |
| `CODEX_RUNNER_CHILD_HOME` | `<codex home>/home` | the child's `HOME` |
| `CODEX_RUNNER_AUTH_FROM` | `~/.codex` | `--setup`: the personal home whose `auth.json` is linked and whose sessions are carried over |

## Tests

`bun test codex-runner/codex-runner.test.ts` from `plugins/telegram-http`. The tests use a fake Onsen (`Bun.serve`) and a fake codex (`fake-codex.ts`), and nothing reaches Onsen or OpenAI. No tmux is involved.
