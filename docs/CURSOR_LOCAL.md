# Linear to local Cursor

Cyrus can receive a Linear delegation and execute Cursor's SDK on the same
machine as the checkout. Cursor supplies inference through the selected account.
Git operations use the checkout's existing local credentials and remotes.

This configuration uses Cyrus's own Linear application and webhook receiver.
The account and repository connections in Cursor Cloud Agents are separate.

## Configure the execution account

Use the existing [self-hosted Linear onboarding](./SELF_HOSTING.md) to create
and authorize a private OAuth application in the intended Linear workspace.
Provide a public HTTPS endpoint for `/callback` and `/linear-webhook`. The app
requests write access and the ability to be assigned and mentioned. Keep the
webhook signing secret and OAuth credentials outside source control.

Keep both the HTTPS endpoint and local Cyrus service available. Mac sleep,
logout, expired credentials, and a stopped tunnel can interrupt delivery. Name
the person responsible for those services before expecting unattended work.

Authenticate Cyrus with the SDK's supported browser flow:

```sh
cyrus self-auth-cursor --email you@example.com --team-id 123456
```

The command verifies the account before saving an expiring key in Cyrus's own
owner-only credential store. It preserves the global SDK login and records
`cursorAccountEmail` and `cursorTeamId` in the Cyrus configuration. Existing CLI
sign-in alone does not establish SDK authentication.
Never reuse an unrelated provider's credential as a fallback. Confirm the
selected account and the billed Team with a bounded acceptance task before
activating unattended issue processing.

Add these fields to the existing Cyrus configuration. Replace the example Team
and model with values for the authenticated Cursor account:

```json
{
  "defaultRunner": "cursor",
  "allowedRunners": ["cursor"],
  "maxConcurrentSessions": 1,
  "cursorTeamId": 123456,
  "cursorAccountEmail": "you@example.com",
  "cursorDefaultModel": "your-cursor-model-id",
  "cursorSettingSources": ["user", "project"],
  "publicationPolicy": { "mode": "local-only" }
}
```

`allowedRunners` restricts Cyrus's provider selection and runner factory,
including stored sessions. A session belonging to a different provider stops
with an error. A Claude model selected within Cursor still uses Cursor's
provider. Project permission settings remain loaded even when user settings
are enabled. Team selection is passed to both new and resumed SDK sessions.
When `cursorAccountEmail` is configured, a live account lookup must match before
any SDK agent is created or resumed. Account verification does not prove the
eventual billing entry. Check that separately during acceptance.
The Cursor adapter does not implement automatic model fallback. A model failure
does not authorize switching to a different provider. Leave the legacy
`cursorDefaultFallbackModel` setting unset for this configuration.

## Install complete workflows

Use the workflow project's maintained installer in the base checkout. Install
the full package, its supporting scripts, and its declared runtime dependencies.
Keep the chosen version recorded with the deployment configuration.

For a package that installs `_bmad` and `.agents/skills`, configure:

```json
{
  "workspaceSupportPaths": ["_bmad", ".agents/skills"]
}
```

Cyrus stages configured support paths from the repository into the task
worktree before skill discovery. Missing source paths or conflicting worktree
files stop startup. Complete skill folders retain their scripts and assets.
An isolated `SKILL.md` is insufficient for BMAD because its entrypoint invokes
`_bmad/scripts/render_skill.py` from the task's project root. Verify `uv` and the
package's Python requirements during installation.

The issue brief should explicitly select `bmad-build-auto` for a feature or
demo, or `bmad-deep-recon` unattended with rendered HTML for research. Require a
separate agent to inspect the actual final working demo or rendered report
after substantive edits. This remains a delivery requirement to demonstrate
in acceptance, rather than a guarantee supplied by skill discovery alone.

## Restrict publishing

Start with `local-only`. After checking the destination and runtime credentials,
branch publication can be configured explicitly:

```json
{
  "publicationPolicy": {
    "mode": "branch-only",
    "repositoryUrl": "https://github.com/example/private-project.git"
  }
}
```

Cyrus verifies that `origin` has exactly the configured push destination before
starting a session. Both policies suppress automatic PR and stop hooks that
would publish. They add instructions and tool denials for known publishing
commands and API tools. The existing verification and orchestration guidance
honors local-only and branch-only completion without requesting a PR or MR.

These controls reduce accidental publishing. Arbitrary shell programs and
broad credentials can reach destinations beyond the configured remote. Use
repository-scoped credentials and appropriate tool/network restrictions before
unattended work. Existing user hooks also need review for publication actions.

## Start and recover work

Delegate or assign an issue to the Cyrus agent in Linear. A custom status alone
does not configure an event trigger. Start acceptance with one issue at a time.
Cyrus creates issue worktrees, and Cursor rejects simultaneous use of the same
worktree's permission configuration.

Waiting dependency sessions are saved without copying repository credentials.
After restart, Cyrus checks the current issue and dependency state before
resuming them. An unavailable issue tracker keeps work waiting. Closed or
canceled work is not started again. A crash during an uncertain start pauses
automatic replay until an explicit resume resolves the ambiguity.

Received stop and unassignment events remove saved waiting work. Recovery checks
issue and session terminal states. It does not separately verify delegate
ownership after an offline unassignment, so that case remains an acceptance
requirement before unattended activation. Explicit resume after an uncertain
start is manual supervision and should be counted.

## Acceptance before activation

Check a real feature or demo and a rendered research report through the full
Linear-to-Cursor flow. Verify the actual Team usage, publication destination,
independent final review, and recovery after interruption. Record every manual
rescue. Local unit tests and an F1 mock drive establish integration behavior
without establishing model quality, account billing, or live webhook delivery.
