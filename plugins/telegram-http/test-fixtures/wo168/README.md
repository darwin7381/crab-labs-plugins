# WO-168 stage two: real screens

Every file is a real pane, not a drawing.

- `cc-*.ansi` / `cc-*.plain` / `cc-*.info`: Claude Code 2.1.322 on txmonster, 2026-11-26T05:5xZ.
  - Started with `--safe-mode --strict-mcp-config` in a scratch folder, on a PRIVATE tmux server (`-S`, TMUX unset). Nothing was sent to the model.
  - `.ansi` is `capture-pane -p -e -S -60`; `.plain` is `capture-pane -p`; `.info` is `pane_current_command, pane_in_mode, pane_height, history_size`.
  - Screens: the trust prompt (`01-start`: cursor on "No, exit"; `01b`: on "Yes"), the idle box with the dim suggestion (`02`, `04`), typed text (`03`), the model picker (`05`), the effort slider (`09`).
- `lab-*.txt`: Chiron's labelled screens (`claude-chiron/knowledge/tg-dialogue/screen-eval/`, labels in its `labels.json`), copied as they are.
- `refusal-fallback-*.txt` and `yes-no-confirm-*.txt`: from `claude-epeius/knowledge/wo168-menu-screens/` (its README gives every source and capture command). Edits are only these:
  - the capture commands' own header lines are dropped (`claude-cadmus`, `=== … ===`);
  - `yes-no-confirm-3` keeps the first of its two panes;
  - task-list titles under the menus are replaced by `task N` (the rows and their glyphs stay);
  - the Telegram group id in `yes-no-confirm-1` is zeroed.
