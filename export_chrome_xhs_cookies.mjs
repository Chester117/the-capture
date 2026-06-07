import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const cookieDb = process.env.CODEX_COOKIE_DB
  || '/Users/homemacserver/Library/Application Support/Google/Chrome/Default/Cookies';
const keyPath = process.env.CODEX_SAFE_STORAGE_KEY_PATH || '/private/tmp/chrome-safe-storage-key.txt';
const outputPath = process.env.XHS_COOKIE_PATH || path.join(repoRoot, 'auth/xiaohongshu-cookie-header.txt');

function sqliteRows(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-json', cookieDb, sql], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`sqlite3 failed code=${code}: ${stderr.trim()}`));
      else resolve(stdout.trim() ? JSON.parse(stdout) : []);
    });
  });
}

function decryptChromiumMacCookie(encryptedHex, password, hostKey) {
  const encrypted = Buffer.from(encryptedHex, 'hex');
  if (!encrypted.length) return '';
  if (encrypted.subarray(0, 3).toString('utf8') !== 'v10') {
    return encrypted.toString('utf8');
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.from(' '.repeat(16));
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  const hostDigest = crypto.createHash('sha256').update(String(hostKey || '')).digest();
  const value = decrypted.subarray(0, 32).equals(hostDigest) ? decrypted.subarray(32) : decrypted;
  return value.toString('utf8');
}

const password = (await fs.readFile(keyPath, 'utf8')).trim();
const rows = await sqliteRows(`
select host_key, name, hex(encrypted_value) as encrypted_hex
from cookies
where host_key like '%xiaohongshu.com'
   or host_key like '%xhslink.com'
   or host_key like '%xhsurl.com'
order by host_key, name;
`);

const parts = [];
for (const row of rows) {
  if (!row.name || !row.encrypted_hex) continue;
  const value = decryptChromiumMacCookie(row.encrypted_hex, password, row.host_key);
  if (value) parts.push(`${row.name}=${value}`);
}

const deduped = [...new Map(parts.map((part) => [part.split('=')[0], part])).values()].join('; ');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${deduped}\n`, { mode: 0o600 });
await fs.chmod(outputPath, 0o600);

console.log(JSON.stringify({
  ok: Boolean(deduped),
  cookie_db: cookieDb,
  output_path: outputPath,
  cookie_count: parts.length,
  exported_at: new Date().toISOString(),
}, null, 2));
