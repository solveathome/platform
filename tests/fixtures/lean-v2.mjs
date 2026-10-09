// Synthetic pinned bytes and portable contracts only. No compiler or proof execution occurs in this fixture.
import {leanFixture,digest} from './lean.mjs';
import {SCIENTIFIC_IDENTITY_V2,EXECUTION_IDENTITY_V2} from '../../src/lib/lean-identity-v2.ts';

export function leanV2Fixture() {
  const artifacts = [
    ['paper.md','Synthetic manuscript: identity claim.','input'],
    ['Statements.lean','Synthetic trusted exact statement and definitions.','input'],
    ['Main.lean','Synthetic formal source for Fixture.main.','target'],
    ['Definitions.lean','Synthetic complete referenced definition source.','input'],
    ['proof.export','Synthetic compiled proof export.','certificate'],
    ['sources/lean.tar','Synthetic pinned complete Lean source.','dependency'],
    ['tools/lean.bin','Synthetic pinned Lean binary.','dependency'],
    ['tools/comparator.source','Synthetic pinned comparator source.','dependency'],
    ['tools/comparator.bin','Synthetic pinned comparator binary.','dependency'],
    ['tools/nanoda.source','Synthetic pinned Nanoda source.','dependency'],
    ['tools/nanoda.bin','Synthetic pinned Nanoda binary.','dependency'],
    ['lean-toolchain','leanprover/lean4:v4.29.0\n','dependency'],
    ['lakefile.toml','name = "fixture"\n','dependency'],
    ['lake-manifest.json','{"packages":[]}\n','dependency'],
    ['checker.py','Synthetic independently reviewed comparator.','checker'],
    ['invocation.json','Synthetic independently reviewed invocation.','dependency'],
    ['isolation.json','Synthetic strict portable isolation policy.','dependency']
  ];
  const artifact = path => {
    const [,content] = artifacts.find(a=>a[0]===path);
    return {path,sha256:digest(content),bytes:Buffer.byteLength(content)};
  };
  const scientific_identity = {
    schema:SCIENTIFIC_IDENTITY_V2,paper_slug:'identity-fixture',
    manuscript:artifact('paper.md'),statement_bundle:artifact('Statements.lean'),
    axiom_policy:['propext','Classical.choice','Quot.sound'],
    claims:[{id:'claim',locator:'Claim 1',declaration:'Fixture.main',target:'Main.lean',coverage:'full',assumptions:[]}],
    source_artifacts:[artifact('Main.lean'),artifact('Definitions.lean'),artifact('lean-toolchain'),artifact('lakefile.toml'),artifact('lake-manifest.json')],
    proof_artifacts:[{artifact:artifact('proof.export'),claim_ids:['claim']}],
    semantic_dependencies:[{name:'Lean',revision:'a'.repeat(40),source_kind:'source-archive',source:artifact('sources/lean.tar')}]
  };
  const execution_identity = {
    schema:EXECUTION_IDENTITY_V2,validator:artifact('checker.py'),
    tools:[{name:'lean',revision:'a'.repeat(40),source_kind:'source-archive',source_sha256:artifact('sources/lean.tar').sha256,binary_sha256:artifact('tools/lean.bin').sha256},
      {name:'comparator',revision:'a'.repeat(40),source_kind:'source-archive',source_sha256:artifact('tools/comparator.source').sha256,binary_sha256:artifact('tools/comparator.bin').sha256},
      {name:'nanoda',revision:'b'.repeat(40),source_kind:'source-archive',source_sha256:artifact('tools/nanoda.source').sha256,binary_sha256:artifact('tools/nanoda.bin').sha256}],
    invocation:artifact('invocation.json'),
    package_artifacts:artifacts.filter(a=>!['paper.md','Statements.lean','Main.lean','Definitions.lean','proof.export','sources/lean.tar','lean-toolchain','lakefile.toml','lake-manifest.json'].includes(a[0])).map(a=>artifact(a[0])),
    runtime_paths:{package:'/package',support:'/support',tools:'/tools/bin',exports:'/exports',scratch:'/scratch',lean_prefix:'/opt/lean'},
    isolation:{policy_sha256:artifact('isolation.json').sha256,network:'none',unprivileged:true,root_readonly:true,
      inputs_readonly:true,compilation_separate:true,no_host_mounts:true,no_secrets:true,capabilities:[],no_new_privileges:true},
    resources:{memory_bytes:4*1024**3,cpu_count:2,pids:256,wall_seconds:1200,scratch_bytes:7*1024**3,log_stream_bytes:8*1024**2}
  };
  const {plan}=leanFixture();
  plan.manifest=artifacts.map(([path,content,role])=>({path,sha256:digest(content),role}));
  plan.targets=['Main.lean'];plan.checker=execution_identity.validator.sha256;
  plan.inputs=[scientific_identity.manuscript.sha256,scientific_identity.statement_bundle.sha256];
  plan.lean={...plan.lean,policy:'lean-comparator-v2',paper_slug:scientific_identity.paper_slug,
    manuscript_sha256:scientific_identity.manuscript.sha256,statement_bundle_sha256:scientific_identity.statement_bundle.sha256,
    toolchain_sha256:artifact('lean-toolchain').sha256,lakefile_sha256:artifact('lakefile.toml').sha256,lake_manifest_sha256:artifact('lake-manifest.json').sha256,
    dependencies:[{name:'Lean',revision:'a'.repeat(40),sha256:artifact('sources/lean.tar').sha256}],
    validator_sha256:plan.checker,external_checker:{name:'nanoda',revision:'b'.repeat(40),sha256:artifact('tools/nanoda.bin').sha256},claims:structuredClone(scientific_identity.claims),
    scientific_identity,execution_identity,statement_review_id:null,execution_review_id:null,
    proof_representations:scientific_identity.proof_artifacts.map(p=>({artifact:structuredClone(p.artifact),descriptor:null,inputs:[structuredClone(p.artifact)],recipe:null})),
    artifact_bindings:artifacts.map(a=>({artifact:artifact(a[0]),representation:{kind:'manifest',path:a[0]}})),
    artifact_roles:artifacts.map(a=>({path:a[0],kind:execution_identity.package_artifacts.some(e=>e.path===a[0])?'execution':'scientific'}))};
  return {plan,artifacts};
}
