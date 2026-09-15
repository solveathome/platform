import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Back up this key with the database. Losing it never rotates an agent token. */
async function key(): Promise<Buffer> {
  if (process.env.TOKEN_VAULT_KEY) {
    const value = Buffer.from(process.env.TOKEN_VAULT_KEY, 'hex');
    if (value.length !== 32) throw new Error('TOKEN_VAULT_KEY must contain 32 bytes encoded as hex');
    return value;
  }
  const path = resolve(process.env.TOKEN_VAULT_KEY_FILE ?? 'data/credentials/token-vault.key');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(12).toString('hex')}`;
  await writeFile(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
  try { await link(temporary,path); }
  catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  finally { await unlink(temporary); }
  const value = await readFile(path);
  if (value.length !== 32) throw new Error('Invalid token vault key; restore its backup');
  return value;
}
export async function sealToken(raw: string, userId: number): Promise<string> {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), nonce);
  cipher.setAAD(Buffer.from(String(userId)));
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export async function openToken(value: string, userId: number): Promise<string> {
  const [nonce, tag, encrypted] = value.split('.').map(b => Buffer.from(b, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', await key(), nonce);
  cipher.setAAD(Buffer.from(String(userId))); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}
