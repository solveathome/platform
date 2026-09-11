import assert from 'node:assert/strict';
import {test} from 'node:test';

// A transcript that still carries harness-written identifiers is not scrubbed (issue #28): Claude Code's signed `atis`
// latch value and the account, organisation and bridge ids the brief names. Redacted values pass; opaque ones are named with their line.
const {findHarnessId, findHomePath} = await import('../src/lib/files.ts');

const atis = 'v1.5bd3062313744de1.NvQETbIz66ofBWZ7.8e9298b0.vPSkzMiroJKX_9f9LbjfP7Lv_BFf4saxqJz9JbsbbfUft-hIkVf9eTTFwHG8yQjACV8cU6MsaC4yhPQHBmfArV0WjW10uhR2RXP368DBNWetw35AaJI1JqnCV-27TkTNs3P8Q_feEtQxOg';
const uuid = '0f9c2a1e-4d5b-4c6a-9e8f-1a2b3c4d5e6f';

test('an atis-latch line with its signed value is caught, with the line number', () => {
  const t = `{"type": "message"}\n{"type": "atis-latch", "atis": "${atis}", "sessionId": "[REDACTED]"}\n`;
  assert.equal(findHarnessId(t), 'atis (line 2)');
  assert.equal(findHarnessId(t.replace(/": "/g, '":"')), 'atis (line 2)', 'compact JSON is caught too');
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
