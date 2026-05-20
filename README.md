# muster

Minimal dispatcher agent. Bundles markdown skill files into the image, dispatches
chat messages to them, and optionally runs them on cron schedules declared at
deploy time.

## Quick start

```bash
bun install

# set required properties
ast project configure   # set MUSTER_SCHEDULES if you want any

ast dev
```

In the chat playground (`localhost:3100`):

- Ask any question. The agent picks the best matching skill, calls `run_skill`
  to load it, and follows its instructions.
- Prefix a message with `/<skill-name>` to dispatch directly. Example:
  `/example show me what you do`.

## Adding or changing skills

Drop markdown files into `skills/`. The filename (minus `.md`) becomes the
skill name. Rebuild and redeploy for changes to take effect.

```
skills/
├── example.md       # shipped placeholder — feel free to delete
├── digest.md        # your skills go here
└── triage.md
```

Accepted extensions: `.md`, `.markdown`, `.txt`. The first non-empty line
(stripped of leading `#`s) is shown to the LLM as the skill's description.

## Cron schedules

Set `MUSTER_SCHEDULES` to a comma-separated list of `<skill>:<cron>` entries:

```
digest:0 9 * * *,sweep:*/15 * * * *
```

- The skill name must match a file in `skills/`.
- The cron part is a standard 5-field expression (with the spaces between
  fields — that's why entries are separated by commas, not spaces).
- Invalid entries (bad cron, unknown skill) are logged and skipped at boot.

**Default:** `MUSTER_SCHEDULES=example:* * * * *` fires the bundled `example`
skill every minute so a fresh install has visible activity out of the box.
Override (or set to an empty string) when you're ready to wire up real
schedules — or delete `skills/example.md` and the schedule will be skipped
at boot with a warning.

Each fire sends `/${skill}` through the messaging sidecar so it uses the
exact same dispatch path as a chat user. Output is logged to stdout — view
it with `ast project logs` (dev) or on the agent deployment page.

## Optional: post results to Slack

`muster` declares the platform's built-in `slack` messaging adapter, so Slack
credentials (bot token, app token, signing secret) are managed by Astropods
— **not** by this agent. Configure them once at the platform/CLI level (see
`ast docs`), then set `SLACK_CHANNEL` to the destination channel ID:

```
SLACK_CHANNEL=C0123456789   # use the channel ID, NOT the channel name
```

**How it works.** Each cron fire goes through the agent twice on the
scheduler's bidi `ProcessConversation` stream:

1. The scheduler sends a `Message` with a unique synthetic `conversationId`
   (`cron:<skill>:<timestamp>`) so the agent processes the skill with fresh
   memory.
2. After collecting the agent's response, the scheduler sends a proactive
   `AgentResponse` with `conversationId = SLACK_CHANNEL`. The messaging
   service broadcasts that response to all adapters; the Slack adapter
   recognises the channel-id format and posts.

When `SLACK_CHANNEL` is unset, cron runs still execute and log to stdout;
nothing is posted to Slack.

**Caveats:**

- **Use the channel ID, not the name.** Get it from Slack: right-click the
  channel → View channel details → bottom of the modal. IDs start with `C`
  for public channels, `G` for private, `D` for direct messages.
- **The bot must be a member of the channel.** `chat.postMessage` to a public
  channel where the bot isn't a member returns `not_in_channel`. Run
  `/invite @<botname>` in the channel, or DM the bot (D-channels always work).

Bonus: because the Slack adapter is bidirectional, Slack users can also
**chat with the agent** in any channel where the bot is installed, using the
same `/skill-name` dispatch and LLM routing as the web playground.

> **Caveat:** the scheduler runs in-process. With multiple agent replicas, the
> same job fires on each replica. Run a single replica, or add leader-election.

## Project structure

```
muster/
├── agent/
│   ├── index.ts            # boot, wiring, Mastra agent
│   ├── skills.ts           # load skills/ at boot, instructions, run_skill tool, /slash rewrite
│   ├── dispatch.ts         # AgentAdapter wrapper that handles /slash dispatch
│   ├── scheduler.ts        # parse MUSTER_SCHEDULES, register node-cron jobs, fire via @astropods/messaging
│   └── memory-cleanup.ts   # periodic TTL sweep of stale cron threads from Mastra memory
├── skills/
│   └── example.md          # bundled example skill
├── astropods.yml
├── Dockerfile
└── package.json
```

## Configuration

| Input | Required | Description |
|---|---|---|
| `MUSTER_SCHEDULES` | no | Comma-separated `<skill>:<cron>` entries (deploy-time). Default: `example:* * * * *` (fires the bundled example skill every minute). |
| `SLACK_CHANNEL` | no | Channel ID (preferred) or `#name` to post cron results to. Slack credentials are managed by the platform's Slack adapter, not here. |

| Integration | Type | Environment variable |
|---|---|---|
| Anthropic | Model API | `ANTHROPIC_API_KEY` |

| Interface | |
|---|---|
| Web messaging | Chat playground (`localhost:3100` during dev) |
| Slack messaging | Bidirectional chat in Slack channels; also used as the egress for cron run notifications when `SLACK_CHANNEL` is set |
