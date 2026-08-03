#!/usr/bin/env node
/**
 * Propagate a deployment's addresses to every file that hardcodes them.
 *
 * `deployments/<network>.json` and `frontend/.env.local` are written by
 * scripts/deploy.sh, but four other files carry the same addresses by hand:
 * the committed env example, both env blocks in the CI workflow, the README,
 * and the contract reference. Left alone they go stale silently — nothing
 * fails, because the old contracts keep working, so the docs quietly describe
 * a deployment that is no longer the current one.
 *
 * Two mechanisms, because the files differ in kind:
 *
 *   key-anchored  — env-style files, where `NEXT_PUBLIC_REGISTRY_ID` names its
 *                   own value. Rewrites the value, preserves the `=` or `: `
 *                   separator and any quoting. Needs no knowledge of the old
 *                   deployment, so it works even on a first deploy.
 *
 *   literal       — prose files, where an address appears inside tables, links
 *                   and badge URLs. Needs the previous record to know what to
 *                   replace, which deploy.sh snapshots before overwriting it.
 *
 * Usage:
 *   node scripts/sync-addresses.mjs --network testnet --previous <old.json>
 *   node scripts/sync-addresses.mjs --check          # report drift, write nothing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const NETWORK = flag('network', process.env.NETWORK ?? 'testnet');
const CHECK_ONLY = has('check');
const PREVIOUS = flag('previous');

const PASSPHRASES = {
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  mainnet: 'Public Global Stellar Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
};

// ── Load the deployment record ───────────────────────────────────────────────

const recordPath = join(ROOT, 'deployments', `${NETWORK}.json`);
if (!existsSync(recordPath)) {
  console.error(`✗ sync-addresses: no deployment record at ${recordPath}`);
  console.error('  Run scripts/deploy.sh first.');
  process.exit(1);
}

const record = JSON.parse(readFileSync(recordPath, 'utf8'));
const now = {
  network: record.network ?? NETWORK,
  passphrase: record.networkPassphrase ?? PASSPHRASES[NETWORK] ?? PASSPHRASES.testnet,
  registry: record.contracts?.registry ?? '',
  reputation: record.contracts?.reputation ?? '',
  token: record.contracts?.token ?? '',
  wasm: record.escrowWasmHash ?? '',
};

for (const [key, value] of Object.entries(now)) {
  if (!value) {
    console.error(`✗ sync-addresses: ${recordPath} is missing "${key}"`);
    process.exit(1);
  }
}

const before = PREVIOUS && existsSync(PREVIOUS) ? JSON.parse(readFileSync(PREVIOUS, 'utf8')) : null;
const old = before
  ? {
      registry: before.contracts?.registry ?? '',
      reputation: before.contracts?.reputation ?? '',
      token: before.contracts?.token ?? '',
      wasm: before.escrowWasmHash ?? '',
    }
  : null;

// ── Targets ──────────────────────────────────────────────────────────────────

/** Env-style files: the key names its own value, so no history is needed. */
const KEY_ANCHORED = ['frontend/.env.example', '.github/workflows/ci.yml'];

/** Prose files: addresses live inside tables, links and badge URLs. */
const LITERAL = ['README.md', 'docs/contracts.md'];

const VALUES = {
  NEXT_PUBLIC_STELLAR_NETWORK: now.network,
  NEXT_PUBLIC_NETWORK_PASSPHRASE: now.passphrase,
  NEXT_PUBLIC_REGISTRY_ID: now.registry,
  NEXT_PUBLIC_REPUTATION_ID: now.reputation,
  NEXT_PUBLIC_TOKEN_ID: now.token,
};

// ── Rewriters ────────────────────────────────────────────────────────────────

/**
 * Rewrite `KEY=value` / `KEY: value` in place, keeping the separator and any
 * quote style. Commented lines are skipped deliberately — the optional RPC and
 * Horizon overrides are documentation, not deployment state.
 */
function applyKeyAnchored(text) {
  let out = text;
  for (const [key, value] of Object.entries(VALUES)) {
    const pattern = new RegExp(`^([ \\t]*${key}[ \\t]*[:=][ \\t]*)(['"]?)(.*?)\\2[ \\t]*$`, 'gm');
    out = out.replace(pattern, (line, prefix, quote, current) => {
      // Values containing a semicolon must stay quoted in YAML or the parser
      // treats the rest of the line as a comment.
      const needsQuote = quote || (line.includes(':') && value.includes(';'));
      const q = needsQuote ? quote || "'" : '';
      return current === value && quote === q ? line : `${prefix}${q}${value}${q}`;
    });
  }
  return out;
}

function applyLiteral(text) {
  if (!old) return text;
  let out = text;
  for (const key of ['registry', 'reputation', 'token', 'wasm']) {
    const from = old[key];
    const to = now[key];
    if (from && to && from !== to) out = out.split(from).join(to);
  }
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const changed = [];
const drifted = [];

for (const rel of [...KEY_ANCHORED, ...LITERAL]) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    console.log(`  ~ ${rel} — not present, skipped`);
    continue;
  }

  const original = readFileSync(path, 'utf8');
  const updated = KEY_ANCHORED.includes(rel) ? applyKeyAnchored(original) : applyLiteral(original);

  if (CHECK_ONLY) {
    // Drift is "this file does not mention the current deployment", which
    // catches a stale record even when no previous snapshot is available.
    const stale =
      updated !== original ||
      (LITERAL.includes(rel) && (!original.includes(now.registry) || !original.includes(now.reputation)));
    if (stale) drifted.push(rel);
    continue;
  }

  if (updated !== original) {
    writeFileSync(path, updated);
    changed.push(rel);
  }
}

if (CHECK_ONLY) {
  if (drifted.length === 0) {
    console.log(`✓ sync-addresses: every file matches deployments/${NETWORK}.json`);
    process.exit(0);
  }
  console.error(`✗ sync-addresses: ${drifted.length} file(s) do not match deployments/${NETWORK}.json`);
  for (const f of drifted) console.error(`  - ${f}`);
  console.error('\n  Fix with:  node scripts/sync-addresses.mjs --network ' + NETWORK);
  process.exit(1);
}

console.log(`✓ sync-addresses: ${changed.length} file(s) updated to deployments/${NETWORK}.json`);
for (const f of changed) console.log(`  + ${f}`);

if (!old) {
  console.log('\n  No previous record supplied, so prose files were left alone.');
  console.log('  README.md and docs/contracts.md may still name the old contracts —');
  console.log('  run with --check to confirm.');
}
