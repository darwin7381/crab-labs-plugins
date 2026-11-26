# codex-runner — Codex as an Onsen member (WO-184 part 2)

Codex (OpenAI Codex CLI) is the Onsen member `codex`. This program is the part of it that takes work. It is one resident Bun process on the Mac mini, run by launchd as `com.btai.codex-runner`.

- An agent hands Codex work with `send_to_agent(to: "codex", line: "call", …)`. The answer comes back the way every Call's answer does: in the Call's result, and as a reply in the caller's inbox.
- Joey talks to Codex on the Onsen page. The answer is recorded in his conversation with Codex.
- In both cases the request, the progress and the result live in Onsen, including the files Codex makes.

## What it does

1. **Take.** It uses the codex credential and the same pull every daemon uses: `GET /api/onsen/inbox` (long poll) and `POST /inbox/ack`. That pull brings in Calls. It also polls `GET /api/onsen/forms/inbox` (long poll) for messages Joey writes on the page (items marked `say`).
   - Each item is first written to the state file, then acked.
   - Not work, acked and left alone: replies, silent notices, mail bells, Action presses, and anything that is not a Call. A peer_call that arrives without its Call id is looked up by its number once after 35 s. If it still has none, it is a poke.
2. **Accept.** For a Call, it PUTs `accepted` to `/v1/calls/<id>/state`.
   - The folder is `~/onsen-codex/<Onsen conversation id>/`. Each pair (caller ↔ Codex) has one conversation, and so does Joey ↔ Codex.
   - The item's attachments are downloaded into that folder with the credential, only from Onsen's own origin.
3. **Run.** For a Call, it PUTs `running`. Then it runs:

   ```
   codex exec --skip-git-repo-check -s workspace-write -C <dir> --json -o <dir>/last-<n>.txt [-i <image>…] -- "<text>"   < /dev/null
   ```

   - From the second item of the same conversation on, it uses `codex exec … resume <session> --json -o … -- "<text>"`. `<session>` is that conversation's first session, read from `thread.started.thread_id` in the `--json` events.
   - stdout and stderr go to `<dir>/.codex-runner/run-<n>.jsonl` and `.stderr`.
4. **Finish.**
   - **Completed**: `result.body` is the last message.
     - Files new or changed in the folder by this run are uploaded with `POST /v1/files` and listed in `result.attachment_file_ids`. Hidden files and `last-<n>.txt` are excluded. At most 20 files, each at most 25 MB. Files over either limit are named in the body.
     - A peer's Call also gets a reply with `POST /send`: kind `peer_call`, `reply_to_id` set to its number, the same files attached, and the file URLs and Mac mini paths in the text.
     - A page message's answer is recorded with `POST /messages` and carries its files. Its delivery facts are delivered, in_session, seen and turn_end.
   - **Failed**: the exit code is non-zero, or the run passed `CODEX_RUNNER_TIMEOUT_S`. On timeout the process group gets SIGTERM, then SIGKILL 10 s later. `result.body` holds the error and the last 30 lines of stderr.
5. **Limits.**
   - At most `CODEX_RUNNER_MAX` items run at once. The rest stay `queued` in Onsen. Onsen sets that state itself; the runner sends no PUT until it starts an item.
   - Two items of one conversation never run at once, because the second resumes the first one's session.
6. **Status.** It PUTs `/v1/members/codex/observation` at each change and every 15 s.
   - While alive it is online.
   - While any item is being worked on, the main session is running with `doing {kind: tool, tool: "codex exec"}`. The member page shows 「執行中・codex exec」.
   - Otherwise the main session is idle (閒置).
   - At a clean stop it reports offline.
7. **Restart.**
   - The runs in flight keep going in their own process groups, and the next start follows them.
   - A run whose process is gone is settled from what it left. If its events show the turn completed and the last message is there, it is completed. Otherwise it is failed, with a note.
   - Reports interrupted by a restart are sent again; each one is idempotent.

Codex never starts anything on its own, never reads a mailbox, and never posts on the wall. Its credential goes only to Onsen and is never logged.

## Needs

- **Onsen with the WO-184 part 2 change** (fleet-core). It adds `POST /v1/conversations`, without which Joey cannot open a chat with Codex on the page. It also adds `attachment_file_ids` on the record route, so Codex's answers to Joey carry their files. Calls work without it. Against an older Onsen, the answer to a page message says where the files are.
- **A mesh credential for the identity `codex`**, kind `agent`, with the `mesh` scope. Its runtime stays empty: an identity whose runtime is set (other than claude-code) is a BTCC mailbox identity, and BTCC would not write its Onsen inbox. The credential file is `CODEX_RUNNER_CREDENTIAL_FILE`, mode 600.
- `codex` in the fleet roster (name, machine, desc; no url), so that `send_to_agent` finds it.
- The Codex CLI, logged in, for the same user: `codex exec` works in a terminal.

## Start, stop, roll back

```sh
mkdir -p ~/onsen-codex/.runner
sed "s#__HOME__#$HOME#g" com.btai.codex-runner.plist.example > ~/Library/LaunchAgents/com.btai.codex-runner.plist
bun codex-runner.ts --whoami        # the credential reads; GET /v1/me says codex, kind agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.btai.codex-runner.plist
tail -f ~/onsen-codex/.runner/runner.log   # "codex-runner up", then its first status report makes the member
bun codex-runner.ts --profile       # once: display name Codex, role 外部模型（OpenAI Codex CLI）：審設計、寫程式、生圖
```

- **Restart after a code update** (git pull of the plugin checkout): `launchctl kickstart -k gui/$(id -u)/com.btai.codex-runner`. Runs in flight are followed by the new process.
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

## Tests

`bun test codex-runner/codex-runner.test.ts` from `plugins/telegram-http`. The tests use a fake Onsen (`Bun.serve`) and a fake codex (`fake-codex.ts`), and nothing reaches Onsen or OpenAI. No tmux is involved.
