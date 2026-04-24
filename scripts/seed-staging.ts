#!/usr/bin/env tsx
/**
 * Optional helper for cleaning e2e- prefixed rows from the staging tenant (company_id=1).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for staging — NOT production. The script
 * refuses to run if the URL host contains "prod" or "blksails.cn" without the "staging"/"beta"
 * marker, as a belt-and-suspenders guard.
 *
 * Not wired into CI yet. Run manually before/after a big recording session:
 *   pnpm tsx scripts/seed-staging.ts --prune
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const REQUIRED_MARKERS = ['staging', 'beta'];

function guardTarget(url: string): void {
  const host = new URL(url).host;
  const safe = REQUIRED_MARKERS.some((m) => host.includes(m));
  if (!safe) {
    console.error(`[seed] refusing to run against ${host} — expected host containing one of: ${REQUIRED_MARKERS.join(', ')}`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[seed] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    process.exit(1);
  }
  guardTarget(url);

  const args = process.argv.slice(2);
  const prune = args.includes('--prune');
  if (!prune) {
    console.log('[seed] --prune not passed. This script currently only supports --prune.');
    return;
  }

  // Lazy import so this file stays runnable without @supabase/supabase-js in workspaces that
  // haven't needed it yet. Install on demand: `pnpm add -D @supabase/supabase-js -w`.
  const mod = await import('@supabase/supabase-js').catch(() => null);
  if (!mod) {
    console.error('[seed] install @supabase/supabase-js first: pnpm add -D @supabase/supabase-js -w');
    process.exit(1);
  }
  const client = mod.createClient(url, key, { auth: { persistSession: false } });

  const prefix = 'e2e-';
  const companyId = 1;

  // Example: prune invitations table scoped to company_id=1 and email starting with e2e-.
  const { error, count } = await client
    .from('company_invitations')
    .delete({ count: 'exact' })
    .eq('company_id', companyId)
    .ilike('email', `${prefix}%`);

  if (error) {
    console.error('[seed] prune failed:', error.message);
    process.exit(1);
  }
  console.log(`[seed] pruned ${count ?? 0} invitations for company_id=${companyId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
