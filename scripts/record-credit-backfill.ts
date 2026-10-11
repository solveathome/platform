/** Dry run by default. Explicit --apply appends balancing credits; coordinate the production backfill with the release owner. */
import { q, pool, projectTransaction } from '../src/db/index.js';
import { challengeConfig, recordCreditPlan, reconcileRecordCredit } from '../src/lib/challenges.js';
const apply = process.argv.includes('--apply');
const only = process.argv.find(a => a.startsWith('--project='))?.slice('--project='.length);
try {
  for (const p of await q<{ id: string; slug: string }>(`SELECT id, slug FROM problems ${only ? 'WHERE slug = $1' : ''} ORDER BY id`, only ? [only] : [])) {
    const cfg = challengeConfig(p.slug); if (!cfg) continue;
    await projectTransaction(p.id, async () => {
      for (const track of cfg.tracks) {
        const plan = apply ? await reconcileRecordCredit(Number(p.id), p.slug, track) : await recordCreditPlan(Number(p.id), p.slug, track);
        console.log(JSON.stringify({ project: p.slug, track: track.id, applied: apply, changes: plan.filter(r => r.delta !== 0 || !r.managed) }));
      }
    });
  }
} finally { await pool.end(); }
