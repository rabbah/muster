import cron, { type ScheduledTask } from 'node-cron';
import type { Agent } from '@mastra/core/agent';
import {
  MessagingClient,
  type ConversationStream,
} from '@astropods/messaging';
import { getSkill, rewriteSlashDispatch } from './skills';
import { CRON_RESOURCE_ID, CRON_THREAD_PREFIX } from './memory-cleanup';

const SLACK_BODY_MAX_CHARS = 35_000;

type Schedule = { skill: string; cron: string };

// Parse the MUSTER_SCHEDULES env var. Format: comma-separated entries of the
// form `<skill>:<cron>`. The skill name is the part before the first `:`; the
// rest of the entry (which contains spaces for cron's 5 fields) is the cron
// expression. Malformed entries are logged and skipped.
//
// Example:  digest:0 9 * * *,sweep:0,15,30,45 * * * *
function parseSchedules(raw: string): Schedule[] {
  const out: Schedule[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) {
      console.warn(`[muster] malformed schedule "${trimmed}" — expected <skill>:<cron>`);
      continue;
    }
    const skill = trimmed.slice(0, colon).trim();
    const cronExpr = trimmed.slice(colon + 1).trim();
    if (!skill || !cronExpr) {
      console.warn(`[muster] malformed schedule "${trimmed}"`);
      continue;
    }
    out.push({ skill, cron: cronExpr });
  }
  return out;
}

function slackChannel(): string | undefined {
  return process.env.SLACK_CHANNEL?.trim() || undefined;
}

const jobs: ScheduledTask[] = [];
const running = new Set<string>();

let agent: Agent | null = null;
let client: MessagingClient | null = null;
let clientReady: Promise<void> | null = null;
let conv: ConversationStream | null = null;

function setupBidiStream(): void {
  conv = client!.createConversationStream();
  conv.on('error', (err: Error) => console.error('[muster] bidi conversation stream error:', err));
  conv.on('reconnecting', (evt: { attempt: number; delayMs: number; reason?: string }) => {
    console.warn(`[muster] bidi stream reconnecting (attempt ${evt.attempt} in ${evt.delayMs}ms)${evt.reason ? `: ${evt.reason}` : ''}`);
  });
  conv.on('reconnected', (evt: { attempt: number }) => {
    console.log(`[muster] bidi stream reconnected after ${evt.attempt} attempt(s)`);
  });
}

/**
 * Push a proactive AgentResponse to the messaging service with a
 * conversation_id the Slack adapter recognises (channel id, optionally
 * `<channel>-<thread_ts>`). The service broadcasts unmatched conversation
 * ids to all adapters; the Slack adapter accepts on conversation_id format
 * and posts. END is what actually triggers the post.
 *
 * The bot must be a member of the channel — otherwise Slack returns
 * `not_in_channel` and the post is dropped.
 */
function postToSlack(channelId: string, body: string): void {
  if (!conv) {
    console.warn('[muster] cannot post to Slack — bidi stream not open yet');
    return;
  }
  const truncated = body.length > SLACK_BODY_MAX_CHARS
    ? body.slice(0, SLACK_BODY_MAX_CHARS) + `\n…[truncated ${body.length - SLACK_BODY_MAX_CHARS} chars]`
    : body;
  conv.sendAgentResponse({
    conversationId: channelId,
    content: { type: 'REPLACE', content: truncated },
  });
  conv.sendAgentResponse({
    conversationId: channelId,
    content: { type: 'END', content: '' },
  });
}

async function runScheduled(skillName: string): Promise<void> {
  if (running.has(skillName)) {
    console.warn(`[muster] skipping scheduled run of "${skillName}" — previous run still in flight`);
    return;
  }
  running.add(skillName);
  const startedAt = Date.now();
  try {
    if (!getSkill(skillName)) {
      console.warn(`[muster] scheduled fire for "${skillName}" but skill is missing`);
      return;
    }
    if (!agent) {
      console.error(`[muster] scheduled fire for "${skillName}" but agent not initialised`);
      return;
    }

    // Apply the same /<skill> rewrite SlashDispatchAdapter does for chat, so
    // the LLM gets the skill content inlined and doesn't have to call the
    // run_skill tool to load it.
    const prompt = rewriteSlashDispatch(`/${skillName}`) ?? `/${skillName}`;
    const convId = `${CRON_THREAD_PREFIX}${skillName}:${startedAt}`;

    const result = await agent.generate(prompt, {
      memory: { thread: convId, resource: CRON_RESOURCE_ID },
    });
    const output = (result.text ?? '').trim();
    const durationMs = Date.now() - startedAt;
    console.log(`[muster] scheduled run of "${skillName}" completed (${durationMs}ms)\n${output}`);

    const channel = slackChannel();
    if (channel && output) {
      postToSlack(channel, `:robot_face: *muster* ran \`${skillName}\` (${durationMs}ms)\n\`\`\`\n${output}\n\`\`\``);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    console.error(`[muster] scheduled run of "${skillName}" failed (${durationMs}ms):`, msg);
    const channel = slackChannel();
    if (channel) {
      postToSlack(channel, `:warning: *muster* — \`${skillName}\` failed (${durationMs}ms)\n\`\`\`\n${msg}\n\`\`\``);
    }
  } finally {
    running.delete(skillName);
  }
}

export async function initScheduler(theAgent: Agent): Promise<void> {
  agent = theAgent;

  const raw = process.env.MUSTER_SCHEDULES?.trim();
  if (!raw) {
    console.log('[muster] MUSTER_SCHEDULES not set — no cron jobs registered');
    return;
  }

  const addr = process.env.GRPC_SERVER_ADDR || 'localhost:9090';
  client = new MessagingClient(addr);
  client.on('reconnecting', (evt: { attempt: number; delayMs: number; reason?: string }) => {
    console.warn(`[muster] messaging client reconnecting (attempt ${evt.attempt} in ${evt.delayMs}ms)${evt.reason ? `: ${evt.reason}` : ''}`);
  });
  client.on('reconnected', (evt: { attempt: number }) => {
    console.log(`[muster] messaging client reconnected after ${evt.attempt} attempt(s)`);
  });

  clientReady = client.connectWithRetry({
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitter: true,
  });
  clientReady
    .then(() => {
      setupBidiStream();
      console.log('[muster] messaging client connected; bidi conversation stream open');
      const channel = slackChannel();
      if (channel) {
        // Boot-time smoke test: prove the egress path before the first cron
        // tick. If this post never lands, the cron post won't either —
        // check the messaging-sidecar logs for routing or `not_in_channel`.
        postToSlack(channel, ':wave: muster scheduler online');
      }
    })
    .catch((err) => console.error('[muster] messaging client connect failed permanently:', err));

  for (const { skill, cron: cronExpr } of parseSchedules(raw)) {
    if (!cron.validate(cronExpr)) {
      console.warn(`[muster] invalid cron "${cronExpr}" for skill "${skill}" — skipping`);
      continue;
    }
    if (!getSkill(skill)) {
      console.warn(`[muster] schedule references unknown skill "${skill}" — skipping`);
      continue;
    }
    const task = cron.schedule(cronExpr, () => { void runScheduled(skill); });
    jobs.push(task);
    console.log(`[muster] scheduled "${skill}" at "${cronExpr}"`);
  }
  console.log(
    `[muster] scheduler started with ${jobs.length} job(s) (messaging connect in background, slack post ${slackChannel() ? `→ ${slackChannel()}` : 'disabled'})`,
  );
}
