/**
 * muster — minimal dispatcher agent that runs bundled markdown skill files
 * on deploy-time cron schedules. Sibling-in-spirit to `skillit`, stripped of
 * the admin UI, Redis, and runtime skill management.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY     - injected by the anthropic model
 *   GRPC_SERVER_ADDR      - injected by the Astropods messaging service
 *   MUSTER_SCHEDULES      - optional: comma-separated `<skill>:<cron>` entries
 *                           (set via `ast project configure` at deploy time)
 *   MUSTER_SKILLS_DIR     - optional: override the skills directory (default ./skills)
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { MastraAdapter } from '@astropods/adapter-mastra';
import { serve } from '@astropods/adapter-core';
import { loadSkills, renderInstructions, runSkillTool } from './skills';
import { SlashDispatchAdapter } from './dispatch';
import { initScheduler } from './scheduler';
import { startCronMemoryCleanup } from './memory-cleanup';

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1/traces';
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

loadSkills();

const memory = new Memory({
  storage: new LibSQLStore({ id: 'memory', url: ':memory:' }),
});

startCronMemoryCleanup(memory);

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'muster',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

const agent = new Agent({
  id: 'muster',
  name: 'Muster',
  instructions: () => renderInstructions(),
  model: 'anthropic/claude-sonnet-4-5',
  memory,
  tools: { run_skill: runSkillTool },
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:muster'],
      metadata: { agent_id: 'muster' },
    },
  },
});

new Mastra({
  agents: { muster: agent },
  observability,
});

await initScheduler(agent);

serve(new SlashDispatchAdapter(new MastraAdapter(agent)));
