import assert from 'node:assert/strict';
import {test} from 'node:test';

// A transcript that still carries harness-written identifiers is not scrubbed (issue #28): Claude Code's signed `atis`
// latch value and the account, organisation and bridge ids the brief names. Redacted values pass; opaque ones are named with their line.
const {findHarnessId, findHomePath, redactHarnessIds, redactHomePaths, checkUpload} = await import('../src/lib/files.ts');

test('ownership fields in decoded responses redact opaque historical labels and preserve exact science',()=>{
  for (const key of ['last_released_session','assigned_session','held_by_session']) {
    const inner=`{"${key}":"opaque-legacy-binding","anchor":75053614359224265389282351,"negative_zero":-0,"exponent":1.25e+30,"sha":"${'c'.repeat(64)}","job_id":41}`;
    for (const text of [inner,JSON.stringify({content:inner}),inner+'\n'+inner]) {
      assert.ok(findHarnessId(text));
      const clean=redactHarnessIds(text).text;
      assert.ok(!clean.includes('opaque-legacy-binding'));
      assert.equal(findHarnessId(clean),null);
      for (const token of ['75053614359224265389282351','-0','1.25e+30','c'.repeat(64)]) assert.ok(clean.includes(token));
    }
  }
});

const atis = 'v1.5bd3062313744de1.NvQETbIz66ofBWZ7.8e9298b0.vPSkzMiroJKX_9f9LbjfP7Lv_BFf4saxqJz9JbsbbfUft-hIkVf9eTTFwHG8yQjACV8cU6MsaC4yhPQHBmfArV0WjW10uhR2RXP368DBNWetw35AaJI1JqnCV-27TkTNs3P8Q_feEtQxOg';
const uuid = '0f9c2a1e-4d5b-4c6a-9e8f-1a2b3c4d5e6f';

test('an atis-latch line with its signed value is caught, with the line number', () => {
  const t = `{"type": "message"}\n{"type": "atis-latch", "atis": "${atis}", "sessionId": "[REDACTED]"}\n`;
  assert.equal(findHarnessId(t), 'atis (line 2)');
  assert.equal(findHarnessId(t.replace(/": "/g, '":"')), 'atis (line 2)', 'compact JSON is caught too');
});

test('historical attempt and provider IDs are found inside nested escaped tool strings; redaction preserves usage', () => {
  const attempt = '0123456789abcdef0123456789abcdef';
  const line = JSON.stringify({type:'response_item',payload:{output:JSON.stringify({report_md:`Attempt\n\`${attempt}\`\nThe witness is 2+2=4.`,accountId:uuid})},usage:{input_tokens:12,output_tokens:7},run_id:'public-run-123',return_id:42});
  assert.ok(findHarnessId(line));
  assert.equal(checkUpload('evidence.jsonl',line).ok,false);
  const redacted = redactHarnessIds(line);
  assert.equal(redacted.n,2);assert.equal(findHarnessId(redacted.text),null);
  assert.deepEqual(JSON.parse(redacted.text).usage,{input_tokens:12,output_tokens:7});
  assert.equal(JSON.parse(redacted.text).run_id,'public-run-123');
  assert.match(redacted.text,/2\+2=4/);
  assert.equal(checkUpload('evidence.jsonl',redacted.text).ok,true);
  assert.equal(findHarnessId(`Attempt \`${'a'.repeat(64)}\` is an artifact hash.`),null);
  assert.equal(redactHarnessIds(redacted.text).n,0);
});

test('account, organisation and bridge ids left as UUIDs are caught; redacted ones pass', () => {
  assert.equal(findHarnessId(`{"ownerAccountUuid": "${uuid}", "ownerOrganizationUuid": "[REDACTED]"}`), 'ownerAccountUuid (line 1)');
  assert.equal(findHarnessId(`{"bridgeSessionId":"${uuid}"}`), 'bridgeSessionId (line 1)');
  assert.equal(findHarnessId(`{"ownerAccountUuid": "[REDACTED]", "ownerOrganizationUuid": "[REDACTED]", "bridgeSessionId": "[REDACTED]", "atis": "[REDACTED]"}`), null);
  assert.equal(findHarnessId(`{"type": "atis-latch", "atis": "", "sessionId": "[REDACTED]"}`), null, 'an empty atis is what a clean machine writes');
});

test('the rest of a transcript is not mistaken for an identifier', () => {
  assert.equal(findHarnessId('{"type": "assistant", "message": {"content": [{"type": "text", "text": "the sum over atis is v1.0 of the note"}]}}'), null);
  assert.equal(findHarnessId('prose transcript'), null);
  assert.equal(findHomePath('{"cwd": "~/work"}'), null);
});

test('nested run-context attempt IDs are refused while public IDs, evidence and usage survive redaction', () => {
  const context = {attempt:{id:'0123456789abcdef0123456789abcdef',status:'assigned',job_id:42},job_id:42,return_id:42,finding_id:42,id:42,artifact_hash:'a'.repeat(64),usage:{input_tokens:42,output_tokens:7},evidence:'The finite witness is 17.'};
  for (const output of [context, JSON.stringify(context), JSON.stringify(JSON.stringify(context)), {content:[{type:'text',text:JSON.stringify(context)}]}]) {
    const line=JSON.stringify({type:'response_item',payload:{type:'custom_tool_call_output',output}});
    assert.equal(findHarnessId(line),'attempt.id (line 1)');
    assert.equal(checkUpload('native.jsonl',line).ok,false);
    const repaired=redactHarnessIds(line);assert.equal(repaired.n,1);
    assert.equal(findHarnessId(repaired.text),null);assert.equal(checkUpload('native.jsonl',repaired.text).ok,true);
    assert.match(repaired.text,/The finite witness is 17/);
    assert.match(repaired.text,/a{64}/);
    assert.equal(redactHarnessIds(repaired.text).n,0);
  }
  const repaired=JSON.parse(redactHarnessIds(JSON.stringify(context)).text);
  assert.deepEqual(repaired,{...context,attempt:{...context.attempt,id:'[REDACTED]'}});
  for (const attempt of [JSON.stringify(context.attempt), [context.attempt], [JSON.stringify(context.attempt)]]) {
    const line=JSON.stringify({attempt});
    assert.equal(findHarnessId(line),'attempt.id (line 1)');
    const repaired=redactHarnessIds(line);assert.equal(repaired.n,1);assert.equal(findHarnessId(repaired.text),null);
  }
  assert.equal(findHarnessId(JSON.stringify({id:uuid,artifact_hash:'a'.repeat(32),run_id:uuid,attempt:{id:42}})),null,'generic IDs, public runs and scientific numbers remain public');
});

test('redactHarnessIds replaces the values in place and leaves the line valid JSON', () => {
  const line = `{"type": "atis-latch", "atis": "${atis}", "ownerAccountUuid": "${uuid}", "sessionId": "[REDACTED]"}`;
  const r = redactHarnessIds(line);
  assert.equal(r.n, 2);
  assert.equal(findHarnessId(r.text), null);
  assert.deepEqual(JSON.parse(r.text), {type: 'atis-latch', atis: '[REDACTED]', ownerAccountUuid: '[REDACTED]', sessionId: '[REDACTED]'});
  assert.equal(redactHarnessIds('{"atis": "[REDACTED]"}').n, 0);
});


test('multiline historical attempt headers redact without dropping the following evidence', () => {
  const text='Attempt\n`0123456789abcdef0123456789abcdef`\nThe measured witness is 17.';
  const redacted=redactHarnessIds(text);
  assert.equal(redacted.n,1);assert.equal(findHarnessId(redacted.text),null);
  assert.match(redacted.text,/The measured witness is 17/);
});

test('privacy redaction preserves exact scientific numeric tokens through nested and encoded JSON', () => {
  const anchor='75053614359224265389282351';
  const scientific=`{"attempt":{"id":"0123456789abcdef0123456789abcdef"},"anchor":${anchor},"negative_zero":-0,"decimal":1.2300,"large_exponent":1e400,"small_exponent":1e-400,"usage":{"input_tokens":42,"output_tokens":7},"return_id":42}`;
  for(const input of [scientific,JSON.stringify({output:scientific}),JSON.stringify({output:JSON.stringify(scientific)}),`{"type":"header"}\n${scientific}\n`]) {
    const result=redactHarnessIds(input);assert.equal(result.n,1);
    assert.equal(findHarnessId(result.text),null);assert.equal(checkUpload('native.jsonl',result.text).ok,true);
    for(const token of [anchor,'-0','1.2300','1e400','1e-400'])assert.ok(result.text.includes(token),`preserve original numeric token ${token}`);
    assert.equal(redactHarnessIds(result.text).n,0);
  }
  const flat=redactHarnessIds(scientific).text;
  assert.match(flat,new RegExp(`"anchor":${anchor}(?:,|})`),'keep a JSON number, not a quoted string or wrapper');
  const parsed=JSON.parse(flat);assert.deepEqual(parsed.usage,{input_tokens:42,output_tokens:7});assert.equal(parsed.return_id,42);
  const encoded=JSON.parse(redactHarnessIds(JSON.stringify({output:scientific})).text);
  assert.equal(typeof encoded.output,'string');assert.match(encoded.output,new RegExp(`"anchor":${anchor}(?:,|})`));
  assert.equal(redactHarnessIds(scientific.replace('0123456789abcdef0123456789abcdef','[REDACTED]')).text,scientific.replace('0123456789abcdef0123456789abcdef','[REDACTED]'),'already safe evidence keeps exact bytes');
});


test('historical ownership diagnostics redact run labels and replacement/current/short attempts without changing science',()=>{
  const aid='0123456789abcdef0123456789abcdef',run='run-0123456789abcdef';
  const diagnostics=[`attempt 01234567… of job #42 was replaced by ${aid}, which another of your sessions holds: send that agent's X-Session`,
    `X-Attempt names 01234567..., which is not an attempt; its current attempt is ${aid}.`,
    `Job #42's current attempt is ${aid}: resend with X-Attempt: ${aid}.`,
    `run\n\`${run}\` and diagnostic-${run}.json`];
  const science=`MD5 ${'b'.repeat(32)}, SHA256 ${'c'.repeat(64)}, run-${'d'.repeat(64)}; public return #42, witness 75053614359224265389282351.`;
  for(const text of diagnostics)for(const nested of [text+'\n'+science,JSON.stringify({output:text,evidence:science,usage:{input_tokens:42,output_tokens:7}}),JSON.stringify({output:JSON.stringify({output:text,evidence:science})})]) {
    assert.ok(findHarnessId(nested));
    const redacted=redactHarnessIds(nested);assert.equal(findHarnessId(redacted.text),null);assert.ok(redacted.n>0);
    for(const secret of [aid,run,'01234567…','01234567...'])assert.ok(!redacted.text.includes(secret));
    for(const preserved of ['b'.repeat(32),'c'.repeat(64),'run-'+ 'd'.repeat(64),'75053614359224265389282351','#42'])assert.ok(redacted.text.includes(preserved));
    assert.equal(redactHarnessIds(redacted.text).text,redacted.text);
  }
  assert.equal(findHarnessId(science),null);assert.equal(redactHarnessIds(science).text,science);
  assert.equal(findHarnessId(`The candidate was replaced by ${'b'.repeat(32)}, a scientific MD5 digest.`),null);
});

 test("upload refuses ownership labels in filenames while public digest filenames remain valid",()=>{
  assert.equal(checkUpload("diagnostic-run-0123456789abcdef.json", "{\"observation\":42}").ok,false);
  assert.equal(checkUpload("run-"+"a".repeat(64)+".json", "{\"observation\":42}").ok,true);
 });

test('encoded private key/value tokens cannot bypass the harmless-text fast path',()=>{
  const value=String.raw`{"\u0073ession_id":"\u0030\u0031\u0032\u0033\u0034\u0035\u0036\u0037\u0038\u0039abcdef0123456789abcdef","anchor":75053614359224265389282351}`;
  assert.ok(findHarnessId(value));const clean=redactHarnessIds(value).text;
  assert.ok(!findHarnessId(clean));assert.match(clean,/75053614359224265389282351/);
});

test('home paths: only the user prefix becomes ~, in plain text, JSON strings and Windows form; URLs, longer paths and /Users/Shared stay (Oct 10 2026)', () => {
  const cases = [
    ['cd /Users/ann/twin-primes/x.py', 'cd ~/twin-primes/x.py'],
    ['{"cwd":"/Users/ann.b"}', '{"cwd":"~"}'],
    ['"text":"done\\n/home/bob/x"', '"text":"done\\n~/x"'],
    ['C:\\Users\\Ann Lee\\proj', '~\\proj'],
    ['{"p":"C:\\\\Users\\\\ann\\\\proj"}', '{"p":"~\\\\proj"}'],
    ['file:///Users/ann/x and (/home/bob/y)', 'file://~/x and (~/y)'],
    ['https://x.org/home/page /usr/home/ann/ http://h/Users/ann', 'https://x.org/home/page /usr/home/ann/ http://h/Users/ann'],
    ['/Users/Shared/data', '/Users/Shared/data'],
    ['{"cwd": "../../Users/ann/proj"}', '{"cwd": "../..~/proj"}'],
    ['bash: ./Users/ann/run.sh', 'bash: .~/run.sh'],
    ['cd /tmp && .//Users/ann/x', 'cd /tmp && ./~/x'],
    ['<local-path> xYz9/home/ann/.local/share/f', '<local-path> xYz9~/.local/share/f'],
    ['stdout:\\n/c/Users/ann/x and /mnt/d/Users/bob/y', 'stdout:\\n~/x and ~/y'],
    ['mounted at /run/host_mark/Users/ann/proj', 'mounted at ~/proj'],
    ['done\\r\\nC:\\\\Users\\\\ann\\\\AppData and C:/Users/bob/z', 'done\\r\\n~\\\\AppData and ~/z'],
    ['"C:\\\\\\\\Users\\\\\\\\bob\\\\\\\\y"', '"~\\\\\\\\y"'],
  ];
  for (const [input, want] of cases) assert.equal(redactHomePaths(input).text, want, input);
  const r = redactHomePaths('/Users/a/x /Users/a/y'); assert.equal(r.n, 2);
  for (const [input] of cases.slice(0, 6)) assert.equal(findHomePath(redactHomePaths(input).text), null, input);
});
