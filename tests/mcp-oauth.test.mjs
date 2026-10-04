import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash, randomBytes} from 'node:crypto';

// The authorization server's pure rules and the signed-in plugin's HTTP behaviour (#sah-mcp-real-work-build): PKCE, redirect matching,
// client metadata documents, the sign-in challenge in both forms (HTTP 401 for Claude, a tool result for ChatGPT), and the 2026-07-28 era.
process.env.MCP_WORK_BETA = '1';
process.env.BASE_URL = 'https://site.test';
const oauth = await import('../src/lib/oauth.ts');
const {createPlugin, answerMcp} = await import('../src/lib/chatgpt-plugin/index.ts');

test('PKCE S256 accepts the matching verifier only', () => {
  const v = randomBytes(40).toString('base64url'), c = createHash('sha256').update(v).digest('base64url');
  assert.equal(oauth.pkceOk(v, c), true);
  assert.equal(oauth.pkceOk(v + 'x', c), false);
  assert.equal(oauth.pkceOk('short', c), false);
});

test('redirect URIs: https or loopback http; loopback matches on any port', () => {
  for (const ok of ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback', 'http://localhost:4567/cb', 'http://127.0.0.1/cb']) assert.equal(oauth.redirectUriOk(ok), true, ok);
  for (const bad of ['http://evil.example/cb', 'https://a.example/cb#x', 'https://u:p@a.example/', 'javascript:alert(1)', 42]) assert.equal(oauth.redirectUriOk(bad), false, String(bad));
  assert.equal(oauth.redirectMatches(['http://localhost:3000/cb'], 'http://localhost:51234/cb'), true);
  assert.equal(oauth.redirectMatches(['http://localhost:3000/cb'], 'http://localhost:51234/other'), false);
  assert.equal(oauth.redirectMatches(['https://claude.ai/api/mcp/auth_callback'], 'https://claude.ai/api/mcp/auth_callback/'), false);
});

test('the chat app is named from the client, and labels the model as unmeasured', () => {
  assert.equal(oauth.hostOf('https://chatgpt.com/oauth/client.json', []), 'chatgpt');
  assert.equal(oauth.hostOf('', ['https://claude.ai/api/mcp/auth_callback']), 'claude');
  assert.equal(oauth.hostOf('https://notchatgpt.com.evil.example/c.json', []), 'other');
  assert.equal(oauth.MODEL_LABEL.chatgpt, 'chatgpt-unmeasured');
});

test('a client metadata document must name itself and use PKCE without a secret', () => {
  const url = 'https://chatgpt.com/oauth/client.json';
  const ok = oauth.cimdDocument(url, {client_id: url, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect']});
  assert.equal(ok.ok, true); assert.equal(ok.client.host, 'chatgpt');
  assert.equal(oauth.cimdDocument(url, {client_id: 'https://other.example/c.json', redirect_uris: ['https://chatgpt.com/x']}).ok, false);
  assert.equal(oauth.cimdDocument(url, {client_id: url, redirect_uris: ['http://evil.example/x']}).ok, false);
  assert.equal(oauth.cimdDocument(url, {client_id: url, redirect_uris: ['https://chatgpt.com/x'], token_endpoint_auth_method: 'private_key_jwt'}).ok, false);
  // ChatGPT's real document (Oct 4 2026): prefers private_key_jwt, supports none.
  assert.equal(oauth.cimdDocument(url, {client_id: url, redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt']}).ok, true);
});

test('metadata documents fetching never reach private addresses', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.equal(oauth.privateAddress(ip), true, ip);
  for (const ip of ['104.18.32.47', '2606:4700::6810:20af']) assert.equal(oauth.privateAddress(ip), false, ip);
});

test('the only scope is contribute; the metadata says what the spec asks', () => {
  assert.equal(oauth.cleanScope(''), 'contribute'); assert.equal(oauth.cleanScope('contribute openid'), 'contribute'); assert.equal(oauth.cleanScope('admin'), null);
  const as = oauth.authorizationServerMetadata(), pr = oauth.protectedResourceMetadata();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
  assert.equal(pr.resource, 'https://site.test/mcp/beta'); assert.deepEqual(pr.authorization_servers, ['https://site.test']);
});

const who = {userId: 1, handle: 'p', grantId: 2, clientId: 'c', host: 'claude', scopes: ['contribute'], token: 'sahoa_good'};
const plugin = createPlugin({name: 't', title: 'T', version: '1', siteUrl: 'https://site.test', modern: true,
  auth: {resourceMetadataUrl: 'https://site.test/.well-known/oauth-protected-resource/mcp/beta', scopes: ['contribute'], verify: async (t) => t === 'sahoa_good' ? who : null},
  tools: [
    {name: 'pub', title: 'Pub', description: 'd', inputSchema: {type: 'object', properties: {}}, run: () => ({text: 'public'})},
    {name: 'work', title: 'Work', description: 'd', auth: {scopes: ['contribute']}, annotations: {readOnlyHint: false}, maxArgString: 5000, inputSchema: {type: 'object', properties: {}}, run: (a, ctx) => ({text: `hi ${ctx.auth.handle} ${String(a.report).length}`})},
  ]});
const post = (body, headers = {}) => answerMcp(plugin, 'POST', JSON.stringify(body), headers);
const callWork = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'work', arguments: {report: 'x'.repeat(3000)}}};

test('a signed-in tool without a token: 401 with the resource metadata for Claude, a tool-result challenge for ChatGPT', async () => {
  const a = await post(callWork, {'user-agent': 'Claude-User'});
  assert.equal(a.status, 401); assert.match(a.headers['WWW-Authenticate'], /resource_metadata="https:\/\/site\.test\/\.well-known\/oauth-protected-resource\/mcp\/beta"/);
  const b = JSON.parse((await post(callWork, {'user-agent': 'openai-mcp/1.0'})).body).result;
  assert.equal(b.isError, true); assert.match(b._meta['mcp/www_authenticate'][0], /^Bearer resource_metadata=/);
  const c = JSON.parse((await post({...callWork, params: {...callWork.params, _meta: {'openai/locale': 'en'}}})).body).result;
  assert.equal(c.isError, true, 'openai/ _meta keys mark ChatGPT too');
});

test('an invalid token is a 401 invalid_token; a valid one runs the tool with long arguments kept', async () => {
  const bad = await post(callWork, {authorization: 'Bearer sahoa_bad'});
  assert.equal(bad.status, 401); assert.match(bad.headers['WWW-Authenticate'], /error="invalid_token"/);
  const ok = JSON.parse((await post(callWork, {authorization: 'Bearer sahoa_good'})).body).result;
  assert.equal(ok.content[0].text, 'hi p 3000');
});

test('public tools keep working without a token, and the list says which tools need sign-in', async () => {
  assert.equal(JSON.parse((await post({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'pub', arguments: {}}})).body).result.content[0].text, 'public');
  const tools = JSON.parse((await post({jsonrpc: '2.0', id: 2, method: 'tools/list'})).body).result.tools;
  assert.deepEqual(tools.map((t) => t.securitySchemes[0].type), ['noauth', 'oauth2']);
  assert.equal(tools[1].annotations.readOnlyHint, false);
});

test('the 2026-07-28 era: server/discover, cache hints, version and header checks', async () => {
  const meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
  const d = JSON.parse((await post({jsonrpc: '2.0', id: 1, method: 'server/discover', params: {_meta: meta}}, {'mcp-method': 'server/discover', 'mcp-protocol-version': '2026-07-28'})).body).result;
  assert.deepEqual(d.supportedVersions, ['2026-07-28']); assert.equal(d.resultType, 'complete'); assert.equal(d.cacheScope, 'public'); assert.ok(d._meta['io.modelcontextprotocol/serverInfo']);
  const mismatch = await post({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: meta}}, {'mcp-method': 'tools/call'});
  assert.equal(mismatch.status, 400); assert.equal(JSON.parse(mismatch.body).error.code, -32020);
  const old = await post({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: {...meta, 'io.modelcontextprotocol/protocolVersion': '2027-01-01'}}});
  assert.equal(old.status, 400); assert.equal(JSON.parse(old.body).error.code, -32022);
  const legacy = JSON.parse((await post({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}})).body).result;
  assert.equal(legacy.protocolVersion, '2025-06-18', 'initialize still works beside the new era');
});
