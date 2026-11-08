# Cursor-only local workflow verification

Date: 2026-11-08

Tested implementation: `579cd1b0a805ba142145f1dc5d92623e7c09d47f`

The changed behavior includes provider restrictions, session continuation,
visible startup errors, and publication policy configuration. F1 applies to
these runtime changes. This verification used a local fixture repository and
the Cursor mock. It made no model request or real Linear change.

## Configuration

Built the monorepo with its pinned pnpm 10.33.1. Started the compiled F1 server
with these environment values:

```sh
CYRUS_CURSOR_MOCK=1
CYRUS_DEFAULT_RUNNER=cursor
CYRUS_ALLOWED_RUNNERS=cursor
CYRUS_PUBLICATION_MODE=local-only
CYRUS_PORT=3600
CYRUS_REPO_PATH=/tmp/cyrus-cursor-final-f1-20261108
CYRUS_SENTRY_DISABLED=true
```

The fixture had a local bare Git remote, so Git operations needed no hosting
credentials. Commands below use the compiled F1 CLI through Node.

## Observed scenarios

1. Created an issue with `[repo=f1-test-repo] [agent=cursor] [model=default]`.
   `start-session` selected the configured repository without a question and
   displayed `cursor/default`. The session produced the expected mock response.
   `prompt-session` continued the same session and produced a second response.
   `stop-session` changed the session to complete.
2. Created another issue with `[repo=f1-test-repo] [agent=claude]`.
   Startup refused the excluded provider before creating a runner. The session
   changed to error and displayed fixed guidance to check provider, account,
   repository configuration and local logs. No mock completion appeared.
3. Created an issue with `[repo=f1-test-repo] [agent=cursor]` and
   `[model=claude-sonnet-4-5]`. Activity displayed
   `cursor/claude-sonnet-4-5`, confirming that the model name did not select a
   separate provider. The mock completed and the stop request succeeded.

The final activity data passed explicit assertions for these scenarios. A
separate reviewer inspected the live RPC responses and rendered CLI activity
views. Startup refusal produced an expected diagnostic. The server remained
available throughout the three scenarios.

## Related checks and limits

The monorepo build, typecheck, changed-file formatting and generated schema
checks passed. Unit and integration checks cover account mismatch, separate
credential storage, workflow support files, provider selection, publication
controls, interrupted sessions, and temporary Git artifacts. Separate real Git
fixtures verified that generated hook commands and stale sandbox files stay
out of ordinary commits while user edits survive cleanup.

This drive does not establish live Linear OAuth delivery, Team billing, native
child behavior, model fallback, complete BMAD execution, or final artifact
quality. Those require bounded acceptance before unattended activation. The
Cursor adapter has no automatic model fallback. Publication controls reduce
accidents and require appropriately restricted credentials for unattended use.
