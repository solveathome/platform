import { createHash } from 'node:crypto';
export const digest = s => createHash('sha256').update(s).digest('hex');
export function leanFixture() {
  const artifacts = [
    ['validator.txt','Reviewed comparator invocation specification','checker'],
    ['Proof.lean','namespace Example\ntheorem identity (p : Prop) (h : p) : p := h\nend Example\n','target'],
    ['paper.md','# Example\nClaim 1: identity.\n','input'],
    ['Statements.lean','namespace Example\n-- Trusted statement and referenced definitions\nend Example\n','input'],
    ['lean-toolchain','leanprover/lean4:v4.29.0\n','dependency'],
    ['lakefile.toml','name = "example"\n','dependency'],
    ['lake-manifest.json','{"packages":[]}\n','dependency'],
    ['external-checker.txt','Pinned independent checker source bundle fixture','dependency']
  ];
  const manifest = artifacts.map(([path, content, role])=>({path,sha256:digest(content),role}));
  const sha=path=>manifest.find(f=>f.path===path).sha256;
  const plan = {schema_version:1,manifest,targets:['Proof.lean'],claim:'Claim 1 identity.',scope:'Only Claim 1.',assumptions:'Hypothesis p.',checker:sha('validator.txt'),inputs:[sha('paper.md'),sha('Statements.lean')],environment:'Pinned Lean and comparator',command:'Run the reviewed pinned validator in isolation.',expected:'all selected claims checked',supports:'The exact selected declaration is replayed.',coverage:'decisive',coverage_md:'One selected claim.',comparison:'Exact statement equivalence.',availability:{status:'complete',details:'All fixture bytes pinned.',required_sources:[],network:false},cost:{minutes:1,cpu_hours:0.01,ram_gb:1},lean:{policy:'lean-comparator-v1',paper_slug:'example',manuscript_sha256:sha('paper.md'),statement_bundle_sha256:sha('Statements.lean'),statement_review_id:null,toolchain:'leanprover/lean4:v4.29.0',toolchain_sha256:sha('lean-toolchain'),lakefile_sha256:sha('lakefile.toml'),lake_manifest_sha256:sha('lake-manifest.json'),dependencies:[],validator_sha256:sha('validator.txt'),comparator_revision:'a'.repeat(40),external_checker:{name:'nanoda',revision:'b'.repeat(40),sha256:sha('external-checker.txt')},claims:[{id:'claim1',locator:'Claim 1',declaration:'Example.identity',target:'Proof.lean',coverage:'full',assumptions:[]}]}};
  return {plan,artifacts};
}
export function leanEvidence(profile, binding) {
  return {policy:profile.policy,statement_binding:binding,toolchain:profile.toolchain,validator_sha256:profile.validator_sha256,comparator_revision:profile.comparator_revision,external_checker_sha256:profile.external_checker.sha256,audit_sha256:digest('audit'),axioms_sha256:digest('axioms'),sandbox:true,offline:true,clean_environment:true,pinned_inputs:true,export_validated:true,outside_sandbox:true,kernel_checked:true,external_checked:true,claims:profile.claims.map(c=>({id:c.id,declaration:c.declaration,result:'checked',statement_matches:true,axioms:['propext','Classical.choice','Quot.sound'],proof_sha256:digest('proof')}))};
}
