import type { AgentAdapter, StreamHooks, StreamOptions } from '@astropods/adapter-core';
import { rewriteSlashDispatch } from './skills';

/**
 * Intercepts messages of the form `/<skill-name> ...` and rewrites them so the
 * inner adapter sees a prompt with the skill's instructions inlined. Non-slash
 * messages pass through unchanged so the agent can route them via the
 * `run_skill` tool.
 */
export class SlashDispatchAdapter implements AgentAdapter {
  readonly name: string;

  constructor(private readonly inner: AgentAdapter) {
    this.name = inner.name;
    if (inner.streamAudio) {
      this.streamAudio = inner.streamAudio.bind(inner);
    }
  }

  streamAudio?: AgentAdapter['streamAudio'];

  async stream(prompt: string, hooks: StreamHooks, options: StreamOptions): Promise<void> {
    const rewritten = rewriteSlashDispatch(prompt);
    return this.inner.stream(rewritten ?? prompt, hooks, options);
  }

  getConfig() {
    return this.inner.getConfig();
  }
}
