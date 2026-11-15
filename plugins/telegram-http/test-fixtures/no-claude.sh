#!/bin/sh
# The lane binary of the test suite (test-preload.ts sets LANES_CLAUDE_BIN to it): a test that starts a lane without its own fake gets a failed run at once,
# never a real claude (a model call, and a process that outlives the test run). It answers like a claude run that failed.
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"no claude in tests (test-fixtures/no-claude.sh)"}'
exit 1
