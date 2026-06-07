import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const appDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const cloudflared = process.env.CLOUDFLARED || path.join(appDir, '../WangPodcastRSS/bin/cloudflared');
const targetUrl = process.env.TUNNEL_TARGET_URL || `http://127.0.0.1:${process.env.PORT || 8799}`;
const dataDir = process.env.DATA_DIR || path.join(appDir, 'data');
const publicBaseUrlPath = process.env.PUBLIC_BASE_URL_FILE || path.join(dataDir, 'public_base_url.txt');
const logPath = process.env.TUNNEL_LOG_PATH || path.join(appDir, 'cloudflared-quick-tunnel.log');
const protocol = process.env.CLOUDFLARED_PROTOCOL || '';

await fs.mkdir(dataDir, { recursive: true });

const args = ['tunnel', '--url', targetUrl, ...(protocol ? ['--protocol', protocol] : [])];
const child = spawn(cloudflared, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let buffer = '';
let currentUrl = '';

async function writeLog(text) {
  await fs.appendFile(logPath, text).catch(() => {});
}

async function handleOutput(chunk) {
  const text = chunk.toString();
  await writeLog(text);
  buffer += text;
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match && match[0] !== currentUrl) {
    currentUrl = match[0];
    await fs.writeFile(publicBaseUrlPath, `${currentUrl}\n`);
    console.log(`Cloudflare quick tunnel URL: ${currentUrl}`);
  }
  if (buffer.length > 20000) buffer = buffer.slice(-10000);
}

child.stdout.on('data', (chunk) => handleOutput(chunk).catch((error) => console.error(error.message)));
child.stderr.on('data', (chunk) => handleOutput(chunk).catch((error) => console.error(error.message)));
child.on('exit', (code, signal) => {
  console.error(`cloudflared exited code=${code ?? ''} signal=${signal ?? ''}`);
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(`cloudflared failed: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
