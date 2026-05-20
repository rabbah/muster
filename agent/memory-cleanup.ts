import type { Memory } from '@mastra/memory';

const CRON_CONVO_TTL_MS = 24 * 60 * 60 * 1000;   // keep cron threads for 24h
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;       // sweep every hour
export const CRON_RESOURCE_ID = 'cron-scheduler';
export const CRON_THREAD_PREFIX = 'cron:';

/**
 * Periodically delete stale Mastra threads created by the cron scheduler.
 *
 * Each cron fire creates a fresh thread (`cron:<skill>:<timestamp>`) that is
 * never read again — without cleanup, the in-process LibSQL memory store
 * accumulates one entry per fire forever. Mastra has no built-in TTL, so we
 * filter by the cron resource ID and parse the timestamp encoded in the
 * thread id to drop anything past the TTL.
 */
export function startCronMemoryCleanup(memory: Memory): void {
  const sweep = async () => {
    try {
      const cutoff = Date.now() - CRON_CONVO_TTL_MS;
      const { threads } = await memory.listThreads({
        filter: { resourceId: CRON_RESOURCE_ID },
        perPage: false,
      });
      let deleted = 0;
      for (const t of threads) {
        if (!t.id.startsWith(CRON_THREAD_PREFIX)) continue;
        const parts = t.id.split(':');
        const ts = Number(parts[parts.length - 1]);
        if (!Number.isFinite(ts) || ts >= cutoff) continue;
        await memory.deleteThread(t.id);
        deleted++;
      }
      if (deleted > 0) console.log(`[muster] memory cleanup: deleted ${deleted} stale cron thread(s)`);
    } catch (err) {
      console.error('[muster] memory cleanup failed:', err);
    }
  };

  void sweep();
  setInterval(sweep, CLEANUP_INTERVAL_MS).unref();
}
