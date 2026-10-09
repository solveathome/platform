import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SCIENTIFIC_IDENTITY_V2, EXECUTION_IDENTITY_V2, RECEIPT_IDENTITY_V2,
  parseScientificIdentityV2, scientificIdentityV2, parseExecutionIdentityV2, executionIdentityV2,
  parseReceiptIdentityV2, receiptIdentityV2 } from '../src/lib/lean-identity-v2.ts';
import { parseVerificationPlan, fingerprint } from '../src/lib/verification.ts';
import { leanStatementBinding } from '../src/lib/lean-verification.ts';
import { leanFixture } from './fixtures/lean.mjs';

// Synthetic data only: no compiler, model, account, authenticated receipt or real proof execution.
const sha = x => createHash('sha256').update(x).digest('hex');
const art = (path, data) => ({ path, sha256: sha(data), bytes: Buffer.byteLength(data) });
const clone = x => structuredClone(x);
function scientific() {
  return { schema: SCIENTIFIC_IDENTITY_V2, paper_slug: 'identity-fixture',
    manuscript: art('paper.md', 'Synthetic claim'), statement_bundle: art('statements.json', 'Synthetic exact types and definitions'),
    axiom_policy: ['propext','Classical.choice','Quot.sound'],
    claims: [{ id: 'claim', locator: 'Claim 1', declaration: 'Fixture.main', target: 'Main.lean', coverage: 'full', assumptions: [] }],
    source_artifacts: [art('Main.lean', 'Synthetic source'), art('Definitions.lean', 'Synthetic definitions')],
    proof_artifacts: [{ artifact: art('proof.export', 'Synthetic proof data'), claim_ids: ['claim'] }],
    semantic_dependencies: [{ name: 'Lean', revision: 'a'.repeat(40), source_kind:'source-archive', source: art('sources/lean.tar', 'Synthetic pinned core source') }] };
}
function execution() {
  return { schema: EXECUTION_IDENTITY_V2, validator: art('checker.py', 'Synthetic reviewed adapter'),
    tools: [{ name: 'lean', revision: 'a'.repeat(40), source_kind:'source-archive', source_sha256: sha('Lean source'), binary_sha256: sha('Lean binary') }],
    invocation: art('invocation.json', 'Synthetic reviewed invocation and configs'),
    package_artifacts:[art('checker.py','Synthetic reviewed adapter'),art('invocation.json','Synthetic reviewed invocation and configs')],
    runtime_paths: { package: '/package', support: '/support', tools: '/tools/bin', exports: '/exports', scratch: '/scratch', lean_prefix: '/opt/lean' },
    isolation: { policy_sha256: sha('Synthetic strict policy'), network: 'none', unprivileged: true, root_readonly: true,
      inputs_readonly: true, compilation_separate: true, no_host_mounts: true, no_secrets: true, capabilities: [], no_new_privileges: true },
    resources: { memory_bytes: 4 * 1024**3, cpu_count: 2, pids: 256, wall_seconds: 1200, scratch_bytes: 7 * 1024**3, log_stream_bytes: 8 * 1024**2 } };
}
function receipt(observation) {
  return { schema: RECEIPT_IDENTITY_V2, scientific_identity: scientificIdentityV2(scientific()),
    execution_identity: executionIdentityV2(execution()), observation: art('receipts/observation.json', JSON.stringify(observation)) };
}

test('different machine observations have the same science and contract, distinct immutable receipt identities', () => {
  const a = receipt({ fixture_only: true, namespace_inode: 10, container_id: 'fixture-a', ip: '127.0.0.1', environment: 'fixture-A' });
  const b = receipt({ fixture_only: true, namespace_inode: 20, container_id: 'fixture-b', ip: '::1', environment: 'fixture-B' });
  assert.equal(a.scientific_identity, b.scientific_identity);
  assert.equal(a.execution_identity, b.execution_identity);
  assert.notEqual(receiptIdentityV2(a), receiptIdentityV2(b));
});

test('validator, tools, invocation, layout, policy and resource changes affect execution without changing science', () => {
  const base = execution(), science = scientificIdentityV2(scientific());
  for (const mutate of [e => e.validator.sha256 = sha('other adapter'), e => e.tools[0].binary_sha256 = sha('other binary'),
    e => e.invocation.sha256 = sha('other invocation'), e => e.runtime_paths.tools = '/tools/released',
    e => e.isolation.policy_sha256 = sha('other reviewed policy'), e => e.resources.cpu_count = 1]) {
    const e = clone(base); mutate(e); assert.notEqual(executionIdentityV2(e), executionIdentityV2(base));
    assert.equal(scientificIdentityV2(scientific()), science);
    const r = receipt({ fixture_only: true }); const changed = { ...r, execution_identity: executionIdentityV2(e) };
    assert.notEqual(receiptIdentityV2(r), receiptIdentityV2(changed));
  }
});

test('every scientific byte, definition bundle, proof, dependency, assumption and mapping change changes science', () => {
  const base = scientific();
  for (const mutate of [s => s.manuscript.sha256 = sha('revised manuscript'), s => s.statement_bundle.sha256 = sha('different definition'),
    s => s.source_artifacts[0].sha256 = sha('different source'), s => s.proof_artifacts[0].artifact.sha256 = sha('different proof'),
    s => s.semantic_dependencies[0].revision = 'b'.repeat(40), s => s.semantic_dependencies[0].source.sha256 = sha('other core'),
    s => s.claims[0].assumptions.push('Unproved hypothesis'), s => s.claims[0].locator = 'Claim 2',
    s => s.claims[0].declaration = 'Fixture.other', s => s.claims[0].coverage = 'partial']) {
    const s = clone(base); mutate(s); assert.notEqual(scientificIdentityV2(s), scientificIdentityV2(base));
  }
  const illegal = scientific(); illegal.axiom_policy.push('sorryAx'); assert.throws(() => scientificIdentityV2(illegal));
});

test('scientific fields are strictly closed at every nesting level; machine diagnostics cannot be silently dropped', () => {
  for (const mutate of [s => s.host_ip = '192.0.2.1', s => s.environment = 'fixture host', s => s.manuscript.host_path = 'fixture',
    s => s.statement_bundle.machine = 'fixture', s => s.claims[0].namespace = 1, s => s.source_artifacts[0].container_id = 'fixture',
    s => s.proof_artifacts[0].environment = 'fixture', s => s.proof_artifacts[0].artifact.uid = 10001,
    s => s.semantic_dependencies[0].image = 'fixture', s => s.semantic_dependencies[0].source.host = 'fixture',
    s => s.claims.machine = 'fixture', s => s.axiom_policy.machine = 'fixture']) {
    const s = scientific(); mutate(s); assert.throws(() => parseScientificIdentityV2(s));
  }
});

test('execution contracts reject host-specific fields and unavailable safety conditions', () => {
  for (const mutate of [e => e.namespace_inode = 1, e => e.tools[0].host_id = 'fixture', e => e.runtime_paths.host = 'fixture',
    e => e.runtime_paths.tools = '/computer-fixture/tools', e => e.isolation.container_id = 'fixture',
    e => e.resources.measured_peak = 123, e => e.isolation.network = 'host', e => e.isolation.capabilities.push('NET_ADMIN'),
    e => e.isolation.capabilities.machine = 'fixture',
    e => e.isolation.no_new_privileges = false, e => e.resources.cpu_count = 3, e => e.resources.memory_bytes = 8 * 1024**3]) {
    const e = execution(); mutate(e); assert.throws(() => parseExecutionIdentityV2(e));
  }
});

test('scientific inventories require pinned bytes and coverage of every declared claim', () => {
  for (const mutate of [s => s.source_artifacts = [], s => s.proof_artifacts = [], s => s.semantic_dependencies = [],
    s => s.proof_artifacts[0].claim_ids = [], s => s.proof_artifacts[0].claim_ids = ['unknown'],
    s => s.claims[0].target = 'Missing.lean', s => s.source_artifacts.push(clone(s.source_artifacts[0])),
    s => s.proof_artifacts[0].artifact.path = s.manuscript.path, s => s.source_artifacts[0].path = '../Main.lean',
    s => s.semantic_dependencies[0].revision = 'main', s => s.source_artifacts[0].bytes = NaN]) {
    const s = scientific(); mutate(s); assert.throws(() => parseScientificIdentityV2(s));
  }
});

test('identity normalization is deterministic, order independent for inventories, and preserves exact prose', () => {
  const a = scientific(), b = clone(a); b.source_artifacts.reverse(); b.axiom_policy.reverse();
  assert.equal(scientificIdentityV2(a), scientificIdentityV2(b));
  b.claims[0].locator += ' '; assert.notEqual(scientificIdentityV2(a), scientificIdentityV2(b));
  const parsed = parseScientificIdentityV2(a); assert.equal(scientificIdentityV2(a), scientificIdentityV2(parsed));
  const e = parseExecutionIdentityV2(execution()); assert.equal(executionIdentityV2(execution()), executionIdentityV2(e));
  const r = receipt({ fixture_only: true }); assert.equal(receiptIdentityV2(r), receiptIdentityV2(parseReceiptIdentityV2(r)));
});

test('identity parsing rejects sparse arrays, accessors and caller-supplied authority fields', () => {
  let read = false; const s = scientific(); Object.defineProperty(s, 'paper_slug', { get() { read = true; return 'fixture'; } });
  assert.throws(() => scientificIdentityV2(s)); assert.equal(read, false);
  const sparse = scientific(); delete sparse.source_artifacts[0]; assert.throws(() => scientificIdentityV2(sparse));
  const r = receipt({ fixture_only: true }); r.trusted_execution = true; assert.throws(() => receiptIdentityV2(r));
});

test('legacy statement and verification hashes retain exact fixed vectors; v2 grants no legacy acceptance', () => {
  const p = parseVerificationPlan(leanFixture().plan);
  assert.equal(fingerprint(p), '8d944ff2d2f476a15c5a9410bca0d2730732d72ac334426729ddd043d6647f6d');
  assert.equal(leanStatementBinding(p.lean), 'd5f03aaefbcfc12fb7411e4c7ef93c9459a8182dc15d325ae86456222ae4720b');
  const v2 = clone(p); v2.lean.policy = SCIENTIFIC_IDENTITY_V2; assert.throws(() => parseVerificationPlan(v2));
  assert.throws(() => parseReceiptIdentityV2({ ...receipt({ fixture_only: true }), execution_policy: 'authenticated-contributor-v1' }));
});
