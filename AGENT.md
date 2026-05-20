---
description: Minimal dispatcher agent that runs bundled markdown skill files on deploy-time cron schedules and posts results to Slack.
tags:
  - skills
  - cron
  - mastra
  - anthropic
  - slack
authors:
  - name: Rodric Rabbah
    account: rabbah
capabilities:
  - Loads markdown skill files from a bundled /skills directory at boot
  - Routes chat messages to skills via a run_skill tool or explicit /skill-name slash dispatch
  - Runs skills on cron schedules declared at deploy time via MUSTER_SCHEDULES
  - Invokes the Mastra agent in-process and posts proactive AgentResponses to a Slack channel for scheduled runs
  - Logs scheduled run output to stdout for visibility without persistence
  - Sweeps stale cron-fired conversations from Mastra memory hourly with a 24h TTL
repository: github:rabbah/muster
integrations:
  - Anthropic
  - Slack
  - Mastra
---

## Overview

Runs skills on demand (via chat) or on a schedule.
Skills live as markdown files committed to the repo under `skills/`, 
and cron schedules are declared as a single deploy-time input.

## Usage

### Adding skills

Drop markdown files into `skills/`. The filename (minus extension) becomes
the skill name. Accepted extensions: `.md`, `.markdown`, `.txt`. The first
non-empty line (stripped of leading `#`s) is shown to the LLM as the skill's
description. Rebuild and redeploy for changes to take effect.

### Chatting with the agent

In any Slack channel where the bot is installed, or via any other configured
messaging adapter:

- Ask any question. The agent picks the best matching skill, calls
  `run_skill` to load it, and follows its instructions.
- Prefix a message with `/<skill-name>` to dispatch directly to a specific
  skill, skipping LLM routing. Example: `/example show me what you do`.

### Scheduling skills

Set `MUSTER_SCHEDULES` to a comma-separated list of `<skill>:<cron>`
entries — for example `digest:0 9 * * *,sweep:0,15,30,45 * * * *`. Each
entry's cron part is a standard 5-field expression. Invalid entries (bad
cron, unknown skill) are logged and skipped at boot.

By default `MUSTER_SCHEDULES=example:* * * * *` so a fresh install fires
the bundled example skill every minute. Override (or set to an empty
string) before wiring up real schedules.

### Posting cron results to Slack

Set `SLACK_CHANNEL` to a Slack channel ID (e.g. `C0123456789`) — **not** a
channel name. The bot must be a member of the channel; run
`/invite @<botname>` first, or use a DM channel (`D…` IDs always work).
Slack bot credentials are managed by the platform's Slack adapter, not
declared here.

### Inputs

| Input | Required | Description |
|---|---|---|
| `MUSTER_SCHEDULES` | no | Comma-separated `<skill>:<cron>` entries. Default: `example:* * * * *`. |
| `SLACK_CHANNEL` | no | Slack channel ID to post cron results to. Requires the platform's Slack adapter. |

## Limitations

- **Skills are bundled at build time.** Adding or editing a skill requires
  rebuilding the image and redeploying.
- **Scheduler runs in-process; single replica only.** With multiple agent
  replicas the same cron job fires on each.
- **No persistence of run history.** Cron results go to stdout and
  (optionally) Slack; nothing is stored. Inspect past runs via your log
  pipeline.
- **Mastra memory is in-process.** Each cron fire creates a fresh thread
  in `LibSQLStore({ url: ':memory:' })`; an hourly sweep deletes threads
  older than 24h, but they don't survive a process restart anyway.
- **Bot must be in the target Slack channel.** Posts to channels the bot
  isn't a member of are silently dropped (`not_in_channel`).
