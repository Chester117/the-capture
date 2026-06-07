import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const appDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const repoRoot = path.resolve(appDir, '../..');
const url = process.argv[2];
const outPath = process.argv[3] || path.join(appDir, 'data/xhs-browser-capture.json');
const progressPath = path.join(path.dirname(outPath), 'xhs_progress.json');
const partialCommentsPath = path.join(path.dirname(outPath), 'xhs_partial_comments.json');
const lockPath = process.env.XHS_CAPTURE_LOCK_PATH || path.join(appDir, 'data/xhs-capture.lock');
const defaultRunProfileRoot = path.join(appDir, 'data/xhs-chrome-runs');
const requestedUserDataDir = process.env.XHS_CHROME_PROFILE || '';
if (!requestedUserDataDir && process.env.XHS_CHROME_EPHEMERAL === '1') await fs.mkdir(defaultRunProfileRoot, { recursive: true });
const userDataDir = requestedUserDataDir
  || (process.env.XHS_CHROME_EPHEMERAL === '1'
    ? await fs.mkdtemp(path.join(defaultRunProfileRoot, 'run-'))
    : path.join(appDir, 'data/xhs-chrome-profile'));
let port = Number(process.env.XHS_CHROME_PORT || 0);
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cookiePath = process.env.XHS_COOKIE_PATH || path.join(repoRoot, 'auth/xiaohongshu-cookie-header.txt');
const enablePageFetch = process.env.XHS_PAGE_FETCH !== '0';
const maxCommentPages = Number(process.env.XHS_MAX_COMMENT_PAGES || 160);
const maxSubCommentRoots = Number(process.env.XHS_MAX_SUB_COMMENT_ROOTS || 120);
const maxSubCommentPages = Number(process.env.XHS_MAX_SUB_COMMENT_PAGES || 40);
const visualCapture = process.env.XHS_VISUAL_CAPTURE !== '0';
const visualMaxRounds = Number(process.env.XHS_VISUAL_MAX_ROUNDS || 900);
const visualStableRounds = Number(process.env.XHS_VISUAL_STABLE_ROUNDS || 28);
const visualBottomStableRounds = Number(process.env.XHS_VISUAL_BOTTOM_STABLE_ROUNDS || 8);
const visualDelayMinMs = Number(process.env.XHS_VISUAL_DELAY_MIN_MS || 4500);
const visualDelayMaxMs = Number(process.env.XHS_VISUAL_DELAY_MAX_MS || 9500);
const visualWheelMin = Number(process.env.XHS_VISUAL_WHEEL_MIN || 720);
const visualWheelMax = Number(process.env.XHS_VISUAL_WHEEL_MAX || 1650);
const visualClickMax = Number(process.env.XHS_VISUAL_CLICK_MAX || 2);
const commentDelayMinMs = Number(process.env.XHS_COMMENT_DELAY_MIN_MS || 12000);
const commentDelayMaxMs = Number(process.env.XHS_COMMENT_DELAY_MAX_MS || 24000);
const subCommentDelayMinMs = Number(process.env.XHS_SUB_COMMENT_DELAY_MIN_MS || 10000);
const subCommentDelayMaxMs = Number(process.env.XHS_SUB_COMMENT_DELAY_MAX_MS || 22000);
let incompleteReason = '';
let visualStats = {};
let pageCommentCount = 0;
let visualComplete = false;
let lockHandle = null;
let stopping = false;
let currentCdp = null;
let currentBrowserCdp = null;
let currentTargetId = '';
let ownsChromeInstance = false;

async function writeStoppedProgress(signal) {
  await fs.mkdir(path.dirname(progressPath), { recursive: true }).catch(() => {});
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(progressPath, 'utf8'));
  } catch {}
  await fs.writeFile(progressPath, JSON.stringify({
    ...previous,
    ok: false,
    stopped: true,
    final: true,
    stage: 'stopped',
    signal,
    updatedAt: new Date().toISOString(),
    comments: previous.comments || 0,
    pageCommentCount: previous.pageCommentCount || pageCommentCount,
    visualStats: Object.keys(visualStats || {}).length ? visualStats : previous.visualStats,
  }, null, 2)).catch(() => {});
}

async function stopAndExit(signal) {
  if (stopping) return;
  stopping = true;
  await writeStoppedProgress(signal);
  if (currentBrowserCdp && currentTargetId) {
    await currentBrowserCdp.send('Target.closeTarget', { targetId: currentTargetId }, 3000).catch(() => {});
  }
  currentCdp?.close();
  if (ownsChromeInstance && currentBrowserCdp) {
    await currentBrowserCdp.send('Browser.close', {}, 3000).catch(() => {});
    currentBrowserCdp.close();
  }
  await releaseLock();
  process.exitCode = 130;
  setTimeout(() => process.exit(130), 10).unref();
}

process.once('SIGTERM', () => { stopAndExit('SIGTERM'); });
process.once('SIGINT', () => { stopAndExit('SIGINT'); });

if (!url) {
  console.error('Usage: node capture_xhs_browser.mjs <xhs-url> [out.json]');
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  const low = Math.max(0, Math.min(min, max));
  const high = Math.max(low, max);
  return low + Math.floor(Math.random() * (high - low + 1));
}

function isStopReason(text) {
  return /登录后|扫码|验证码|账号异常|访问过于频繁|安全限制|IP at risk|Account abnormal/i.test(String(text || ''));
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function readProfileDebuggerPort() {
  if (process.env.XHS_CHROME_PORT) return 0;
  try {
    const text = await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const value = Number(text.split(/\r?\n/)[0]);
    return value || 0;
  } catch {
    return 0;
  }
}

function httpJson(method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForDebugger() {
  const started = Date.now();
  const timeoutMs = Number(process.env.XHS_CHROME_START_TIMEOUT_MS || 90000);
  while (Date.now() - started < timeoutMs) {
    try {
      await httpJson('GET', '/json/version');
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error('Chrome DevTools endpoint did not start');
}

async function debuggerReady() {
  try {
    await httpJson('GET', '/json/version');
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > Number(process.env.XHS_LOCK_STALE_MS || 8 * 60 * 60 * 1000)) {
      await fs.unlink(lockPath).catch(() => {});
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    lockHandle = await fs.open(lockPath, 'wx');
    await lockHandle.writeFile(JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      url,
      outPath,
      userDataDir,
    }, null, 2));
  } catch (error) {
    if (error.code === 'EEXIST') {
      const owner = await fs.readFile(lockPath, 'utf8').catch(() => '');
      throw new Error(`已有小红书采集正在运行，请等待完成。lock=${lockPath} ${owner.slice(0, 240)}`);
    }
    throw error;
  }
}

async function releaseLock() {
  if (lockHandle) {
    await lockHandle.close().catch(() => {});
    lockHandle = null;
  }
  await fs.unlink(lockPath).catch(() => {});
}

async function captureTarget() {
  const target = await httpJson('PUT', `/json/new?${encodeURIComponent('about:blank')}`);
  if (target?.webSocketDebuggerUrl) return target;
  const targets = await httpJson('GET', '/json/list').catch(() => []);
  const pages = Array.isArray(targets) ? targets.filter((item) => item.type === 'page' && item.url === 'about:blank') : [];
  const blank = pages[0];
  if (blank?.webSocketDebuggerUrl) return blank;
  throw new Error('Chrome did not create an isolated capture tab');
}

class Cdp {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}: ${msg.error.data || ''}`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method && this.handlers.has(msg.method)) {
        for (const fn of this.handlers.get(msg.method)) fn(msg.params || {});
      }
    });
  }

  on(method, fn) {
    const list = this.handlers.get(method) || [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.ws.send(payload);
    return promise;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function parseCookieHeader(header) {
  return String(header || '').split(/;\s*/).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? null : { name: part.slice(0, index), value: part.slice(index + 1) };
  }).filter(Boolean);
}

function commentRows(payload) {
  return payload?.data?.comments || payload?.data?.sub_comments || payload?.comments || [];
}

function flattenCommentsFromPayload(payload) {
  const comments = [];
  const rows = commentRows(payload);
  for (const row of rows) {
    comments.push(row);
    for (const sub of row.sub_comments || row.subComments || []) comments.push(sub);
  }
  return comments;
}

function normalizeComment(row, level = 0, root = '') {
  const rootId = root || String(row.root_comment_id || '');
  const parentId = level > 0 ? String(row.target_comment_id || row.parent_comment_id || row.root_comment_id || rootId || '') : '';
  const emotes = [];
  for (const item of row.pictures || row.emojis || row.content_images || []) {
    const token = item.name || item.desc || item.alt || item.text || '';
    const url = item.url || item.link || item.src || '';
    if (token && url) emotes.push({ token, url: String(url).startsWith('//') ? `https:${url}` : url, source: 'xiaohongshu' });
  }
  const replyTo = String(
    row.target_comment?.user_info?.nickname
      || row.target_comment?.user?.nickname
      || row.target_user?.nickname
      || row.reply_to_user?.nickname
      || row.reply_user?.nickname
      || row.target_nickname
      || row.reply_to_nickname
      || ''
  ).replace(/^@/, '').replace(/\s+/g, ' ').trim();
  return {
    level,
    rpid: String(row.id || row.comment_id || ''),
    root: level > 0 ? rootId : '',
    parent: parentId,
    user: row.user_info?.nickname || row.user?.nickname || '',
    mid: String(row.user_info?.user_id || row.user?.user_id || ''),
    sex: '',
    userLevel: '',
    fansMedal: '',
    time: row.create_time ? new Date(Number(row.create_time)).toISOString().replace('T', ' ').slice(0, 19) : '',
    ctime: row.create_time || 0,
    like: row.like_count || row.likes || 0,
    child_count: row.sub_comment_count || row.sub_comments?.length || 0,
    message: row.content || row.text || '',
    replyTo,
    emotes,
  };
}

function mergeComment(map, row) {
  if (!row.rpid) return;
  const old = map.get(row.rpid);
  if (!old) {
    map.set(row.rpid, row);
    return;
  }
  map.set(row.rpid, {
    ...old,
    ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== 0 && value !== undefined && value !== null)),
  });
}

async function main() {
  const captureStartedAt = Date.now();
  await acquireLock();
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  let ownsChrome = false;
  port = port || await readProfileDebuggerPort() || await findFreePort();
  if (!await debuggerReady()) {
    const chromeArgs = [
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-signin-promo',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
    ];
    if (process.env.XHS_CHROME_HEADLESS === '1') chromeArgs.push('--headless=new', '--disable-gpu', '--window-size=1200,900');
    else chromeArgs.push('--window-size=1200,900', '--window-position=-24000,-24000');
    chromeArgs.push('about:blank');
    const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
    chrome.unref();
    ownsChrome = true;
    ownsChromeInstance = true;
  }

  await waitForDebugger();
  const version = await httpJson('GET', '/json/version').catch(() => ({}));
  const browserCdp = version.webSocketDebuggerUrl ? new Cdp(version.webSocketDebuggerUrl) : null;
  if (browserCdp) await browserCdp.open().catch(() => {});
  currentBrowserCdp = browserCdp;
  const target = await captureTarget();
  currentTargetId = target.id || '';
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  currentCdp = cdp;
  const rawPayloads = [];
  const commentsById = new Map();

  async function writeProgress(extra = {}) {
    const partialComments = [...commentsById.values()];
    const progress = {
      ok: true,
      updatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - captureStartedAt,
      comments: partialComments.length,
      pageCommentCount,
      visualStats,
      ...extra,
    };
    await fs.writeFile(progressPath, JSON.stringify(progress, null, 2)).catch(() => {});
    await fs.writeFile(partialCommentsPath, JSON.stringify(partialComments, null, 2)).catch(() => {});
  }

  cdp.on('Network.responseReceived', async (params) => {
    const responseUrl = params.response?.url || '';
    if (!responseUrl.includes('/api/sns/web/v2/comment/')) return;
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: params.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const payload = JSON.parse(text);
      rawPayloads.push({ url: responseUrl, payload });
      const rows = payload?.data?.comments || payload?.data?.sub_comments || payload?.comments || [];
      for (const row of rows) {
        const root = normalizeComment(row, row.root_comment_id ? 1 : 0);
        mergeComment(commentsById, root);
        for (const sub of row.sub_comments || row.subComments || []) {
          const child = normalizeComment(sub, 1, root.rpid);
          mergeComment(commentsById, child);
        }
      }
    } catch {}
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  const cookieHeader = await fs.readFile(cookiePath, 'utf8').then((s) => s.trim()).catch(() => '');
  for (const cookie of parseCookieHeader(cookieHeader)) {
    await cdp.send('Network.setCookie', {
      url: 'https://www.xiaohongshu.com/',
      name: cookie.name,
      value: cookie.value,
    }).catch(() => {});
  }

  await cdp.send('Page.navigate', { url });
  await sleep(8000);

  const loginCheck = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const bodyText = document.body?.innerText || '';
        return {
          href: location.href,
          bodyText: bodyText.slice(0, 1000),
          needsLogin: /\\/login(?:\\?|$)/.test(location.href) || /登录后推荐|手机号登录|获取验证码|扫码/.test(bodyText),
        };
      })();
    `,
    returnByValue: true,
  }, 8000).catch(() => null);
  const loginState = loginCheck?.result?.value || {};
  if (loginState.needsLogin) {
    incompleteReason = '专用小红书 Chrome profile 未登录或 cookie 已失效，页面被重定向到登录页。请重新同步 Chrome 小红书 cookie 后再续跑。';
    const result = {
      ok: false,
      capturedAt: new Date().toISOString(),
      url,
      chrome: {
        port,
        headless: process.env.XHS_CHROME_HEADLESS === '1',
        persistentProfile: process.env.XHS_CHROME_EPHEMERAL !== '1',
      },
      visualStats,
      rawPageCount: rawPayloads.length,
      incompleteReason,
      rawPayloads,
      pageState: {
        title: '',
        url: loginState.href || '',
        bodyText: loginState.bodyText || '',
        noteId: '',
        note: {},
        stateComments: [],
        scrollables: [],
      },
      comments: [...commentsById.values()],
    };
    await writeProgress({ stage: 'login-required', final: true });
    await fs.writeFile(outPath, JSON.stringify(result, null, 2));
    throw new Error(incompleteReason);
  }

  async function visualExtractRound(round) {
    const interaction = await cdp.send('Runtime.evaluate', {
      expression: `
        (() => {
          const hash = (text) => {
            let h = 2166136261;
            for (let i = 0; i < text.length; i += 1) {
              h ^= text.charCodeAt(i);
              h = Math.imul(h, 16777619);
            }
            return (h >>> 0).toString(36);
          };
          const textOf = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
          const scroller = document.querySelector('.note-scroller') || document.scrollingElement || document.body;
          const beforeScrollTop = scroller.scrollTop;
          const clickable = [...document.querySelectorAll('button, div, span')]
            .filter(el => /展开\\s*\\d*\\s*条回复|展开更多回复|更多回复|查看.*回复|点击.*评论|加载更多|更多评论|全部回复/.test(el.innerText || ''))
            .filter(el => !/登录|关注|发布|发送|取消/.test(el.innerText || ''))
            .filter(el => {
              if (el.dataset?.xhsCaptureClicked === '1') return false;
              const text = textOf(el);
              if (text.length > 80) return false;
              const rect = el.getBoundingClientRect();
              const scrollerRect = scroller.getBoundingClientRect();
              const inWindow = rect.width > 0 && rect.height > 0 && rect.top < innerHeight + 240 && rect.bottom > -240;
              const inScroller = rect.width > 0 && rect.height > 0 && rect.top < scrollerRect.bottom + 400 && rect.bottom > scrollerRect.top - 400;
              const nearScrollTop = Math.abs((el.offsetTop || 0) - scroller.scrollTop) < scroller.clientHeight + 1600;
              return inWindow || inScroller || nearScrollTop || /展开更多回复|展开\\s*\\d+\\s*条回复/.test(text);
            })
            .sort((a, b) => {
              const at = textOf(a);
              const bt = textOf(b);
              const aShowMore = /展开更多回复|展开\\s*\\d+\\s*条回复/.test(at) ? 0 : 1;
              const bShowMore = /展开更多回复|展开\\s*\\d+\\s*条回复/.test(bt) ? 0 : 1;
              if (aShowMore !== bShowMore) return aShowMore - bShowMore;
              return Math.abs((a.offsetTop || 0) - scroller.scrollTop) - Math.abs((b.offsetTop || 0) - scroller.scrollTop);
            })
            .slice(0, ${visualClickMax});
          for (const el of clickable) {
            try {
              el.scrollIntoView({ block: 'center', inline: 'nearest' });
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
              el.click();
              el.dataset.xhsCaptureClicked = '1';
            } catch {}
          }
          if (clickable.length) {
            try { scroller.scrollTop = beforeScrollTop; } catch {}
          }
          const candidates = [
            ...document.querySelectorAll('[class*="comment-item"], [class*="CommentItem"], [class*="parent-comment"], [class*="reply-item"], [class*="commentItem"]')
          ].filter(el => {
            const rect = el.getBoundingClientRect();
            const text = textOf(el);
            return rect.width > 0 && rect.height > 0 && text.length >= 6 && !/共 \\d+ 条评论/.test(text);
          });
          const rows = [];
          const seen = new Set();
          const candidateRects = candidates.map(el => el.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
          const baseLeft = candidateRects.length ? Math.min(...candidateRects.map(rect => rect.left)) : 0;
          let lastRootId = '';
          const recentUsers = new Map();
          for (const el of candidates) {
            const text = textOf(el);
            const lines = String(el.innerText || '').split(/\\n+/).map(s => s.trim()).filter(Boolean);
            if (!lines.length) continue;
            const rect = el.getBoundingClientRect();
            const userEl = el.querySelector('[class*="author"], [class*="name"], a[href*="/user/profile"]');
            const contentEl = el.querySelector('[class*="content"], [class*="text"], [class*="desc"]');
            const user = textOf(userEl) || lines[0] || '';
            let message = textOf(contentEl);
            const emotes = [...(contentEl || el).querySelectorAll('img')]
              .map(img => {
                const rawToken = img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('aria-label') || '';
                const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
                const token = rawToken ? (/^\\[.*\\]$/.test(rawToken) ? rawToken : '[' + rawToken.replace(/^\\[|\\]$/g, '') + ']') : '';
                return token && src ? { token, url: src.startsWith('//') ? 'https:' + src : src, source: 'xiaohongshu-dom' } : null;
              })
              .filter(Boolean);
            for (const emote of emotes) {
              if (emote.token && message && !message.includes(emote.token)) message += emote.token;
            }
            if (!message || message === user) {
              message = lines.find(line => line !== user && !/^\\d{4}-\\d{2}-\\d{2}/.test(line) && !/^(回复|赞|展开|更多|IP属地|删除|举报)$/.test(line)) || '';
            }
            if (!message || /登录后推荐|手机号登录|用户协议|隐私政策/.test(message)) continue;
            const time = lines.find(line => /\\d{4}-\\d{2}-\\d{2}|昨天|今天|小时前|分钟前|刚刚/.test(line)) || '';
            const replyMatch = message.match(/^\\s*回复\\s+@?(.+?)\\s*[:：]/);
            const replyTo = replyMatch ? replyMatch[1].replace(/^@/, '').replace(/\\s+/g, ' ').trim() : '';
            const indented = rect.left > baseLeft + 36;
            const level = /reply|sub|child|回复/.test(String(el.className || '').toLowerCase()) || replyTo || indented ? 1 : 0;
            const key = hash([user, message, time, level, Math.round(rect.left)].join('|'));
            if (seen.has(key)) continue;
            seen.add(key);
            const id = 'dom-' + key;
            const target = replyTo ? recentUsers.get(replyTo) : null;
            const parentId = level > 0 ? (target?.id || lastRootId) : '';
            const rootId = level > 0 ? (target?.rootId || lastRootId) : '';
            rows.push({
              level,
              rpid: id,
              root: rootId,
              parent: parentId,
              user,
              mid: user,
              sex: '',
              userLevel: '',
              fansMedal: '',
              time,
              ctime: 0,
              like: 0,
              child_count: 0,
              message,
              replyTo,
              emotes,
              source: 'dom',
            });
            if (level === 0) lastRootId = id;
            if (user) recentUsers.set(user.replace(/^@/, '').replace(/\\s+/g, ' ').trim(), {
              id,
              rootId: level > 0 ? (rootId || lastRootId || id) : id,
            });
          }
          const scrollables = [
            document.querySelector('.note-scroller'),
            document.scrollingElement,
            document.body,
            ...document.querySelectorAll('[class*="scroll"], [class*="comment"], main, section, div')
          ].filter(Boolean)
            .filter((el, index, arr) => arr.indexOf(el) === index)
            .filter(el => el === document.body || el.scrollHeight > el.clientHeight + 20)
            .map(el => {
              const rect = el.getBoundingClientRect();
              return {
                el,
                rect,
                room: Math.max(0, el.scrollHeight - el.clientHeight),
                visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight,
                textLen: String(el.innerText || '').length,
              };
            })
            .sort((a, b) => {
              const visibleScore = Number(b.visible) - Number(a.visible);
              if (visibleScore) return visibleScore;
              return b.room - a.room || b.textLen - a.textLen;
            });
          const picked = scrollables[0];
          const target = picked?.el || document.scrollingElement || document.body;
          const rect = target.getBoundingClientRect();
          const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 12;
          const bodyText = document.body.innerText || '';
          const countMatch = bodyText.match(/(?:共|全部)?\\s*([\\d,，]+)\\s*条评论/);
          return {
            round: ${round},
            clicked: clickable.length,
            rows,
            bodyText: bodyText.slice(0, 1000),
            atBottom,
            pageCommentCount: countMatch ? Number(countMatch[1].replace(/[,，]/g, '')) : 0,
            scrollTop: target.scrollTop,
            scrollHeight: target.scrollHeight,
            clientHeight: target.clientHeight,
            scrollSelector: target === document.scrollingElement ? 'document' : (target.className || target.tagName || '').toString().slice(0, 80),
            rect: {
              x: Math.max(20, Math.min(innerWidth - 20, rect.left + rect.width / 2)),
              y: Math.max(80, Math.min(innerHeight - 40, rect.top + rect.height - 60)),
            },
          };
        })();
      `,
      returnByValue: true,
    }, 8000).catch(() => {});
    return interaction?.result?.value || {};
  }

  async function runVisualCapture() {
    let stable = 0;
    let lastCount = commentsById.size;
    let lastScrollTop = -1;
    let stuckScroll = 0;
    let rounds = 0;
    for (let i = 0; i < visualMaxRounds; i += 1) {
      rounds = i + 1;
      const info = await visualExtractRound(i + 1);
      for (const row of info.rows || []) mergeComment(commentsById, row);
      const text = info.bodyText || '';
      if (isStopReason(text)) {
        incompleteReason = incompleteReason || `页面提示需要人工处理：${text.slice(0, 80)}`;
        break;
      }
      const currentCount = commentsById.size;
      if (Number(info.pageCommentCount || 0) > pageCommentCount) pageCommentCount = Number(info.pageCommentCount || 0);
      stable = currentCount > lastCount ? 0 : stable + 1;
      lastCount = currentCount;
      stuckScroll = Math.abs(Number(info.scrollTop || 0) - lastScrollTop) < 8 ? stuckScroll + 1 : 0;
      lastScrollTop = Number(info.scrollTop || 0);
      const rect = info.rect;
      if (rect) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: rect.x + Math.floor(Math.random() * 24) - 12,
          y: rect.y + Math.floor(Math.random() * 24) - 12,
          deltaX: 0,
          deltaY: randomDelay(visualWheelMin, visualWheelMax),
        }, 5000).catch(() => {});
      }
      if (stuckScroll >= 6 && !info.atBottom) {
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'PageDown',
          windowsVirtualKeyCode: 34,
          nativeVirtualKeyCode: 34,
        }, 5000).catch(() => {});
        await cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'PageDown',
          windowsVirtualKeyCode: 34,
          nativeVirtualKeyCode: 34,
        }, 5000).catch(() => {});
        await cdp.send('Runtime.evaluate', {
          expression: `
            (() => {
              const scrollables = [document.scrollingElement, document.body, ...document.querySelectorAll('[class*="scroll"], [class*="comment"], main, section, div')]
                .filter(Boolean)
                .filter((el, index, arr) => arr.indexOf(el) === index)
                .filter(el => el === document.body || el.scrollHeight > el.clientHeight + 20)
                .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
              for (const el of scrollables.slice(0, 4)) {
                try { el.scrollBy({ top: ${visualWheelMax * 2}, behavior: 'smooth' }); } catch {}
              }
            })();
          `,
        }, 5000).catch(() => {});
      }
      visualStats = {
        rounds,
        stable,
        stuckScroll,
        visibleComments: currentCount,
        lastClicked: info.clicked || 0,
        lastScrollTop: info.scrollTop || 0,
        lastScrollHeight: info.scrollHeight || 0,
        clientHeight: info.clientHeight || 0,
        scrollSelector: info.scrollSelector || '',
        atBottom: Boolean(info.atBottom),
        pageCommentCount,
      };
      await writeProgress({ stage: 'visual-scroll' });
      const enoughForDisplayedCount = pageCommentCount && currentCount >= pageCommentCount;
      if (info.atBottom && enoughForDisplayedCount && stable >= 3) {
        visualComplete = true;
        break;
      }
      if (info.atBottom && stable >= visualBottomStableRounds) {
        visualComplete = true;
        break;
      }
      if (info.atBottom && stable >= visualStableRounds) {
        visualComplete = true;
        break;
      }
      await sleep(randomDelay(visualDelayMinMs, visualDelayMaxMs));
    }
  }

  if (visualCapture) {
    await runVisualCapture();
  } else {
    for (let i = 0; i < 18; i += 1) {
      const interaction = await visualExtractRound(i + 1);
      const rect = interaction?.rect;
    if (rect) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: rect.x,
        y: rect.y,
        deltaX: 0,
        deltaY: 650 + Math.floor(Math.random() * 350),
      }, 5000).catch(() => {});
    }
    await sleep(1600 + Math.floor(Math.random() * 900));
    }
  }

  async function pageFetchJson(fetchUrl) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: `
        Promise.race([
          fetch(${JSON.stringify(fetchUrl)}, {
            credentials: 'include',
            headers: { accept: 'application/json, text/plain, */*' },
          }).then(async res => ({ status: res.status, text: await res.text() })),
          new Promise((resolve) => setTimeout(() => resolve({ status: 599, text: 'page fetch timeout' }), 12000)),
        ])
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    const value = result.result?.value || {};
    if (value.status < 200 || value.status >= 300) throw new Error(`page fetch ${value.status}: ${String(value.text || '').slice(0, 180)}`);
    const payload = JSON.parse(value.text || '{}');
    if (payload?.success === false) {
      const message = payload.msg || payload.message || '接口请求失败';
      throw new Error(`小红书分页返回 ${payload.code ?? 'unknown'}：${message}`);
    }
    return payload;
  }

function ingestPayload(payload, rootId = '') {
    for (const row of commentRows(payload)) {
      const root = normalizeComment(row, rootId ? 1 : 0, rootId);
      mergeComment(commentsById, root);
      for (const sub of row.sub_comments || row.subComments || []) {
        const child = normalizeComment(sub, 1, rootId || root.rpid);
        mergeComment(commentsById, child);
      }
    }
  }

  function latestXsecToken() {
    for (const item of rawPayloads.slice().reverse()) {
      const token = item.payload?.data?.xsec_token;
      if (token) return token;
    }
    return '';
  }

  async function fetchRemainingCommentPages() {
    const first = rawPayloads.find((item) => item.url.includes('/comment/page?') && item.payload?.data);
    if (!first) return;
    let cursor = first.payload.data.cursor || '';
    let xsecToken = first.payload.data.xsec_token || new URL(first.url).searchParams.get('xsec_token') || '';
    let hasMore = Boolean(first.payload.data.has_more);
    const noteId = first.payload.data.comments?.[0]?.note_id || new URL(first.url).searchParams.get('note_id') || '';
    let page = 2;
    while (hasMore && cursor && noteId && page <= maxCommentPages) {
      const nextUrl = `https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=${encodeURIComponent(noteId)}&cursor=${encodeURIComponent(cursor)}&top_comment_id=&image_formats=jpg,webp,avif&xsec_token=${encodeURIComponent(xsecToken)}`;
      let payload;
      try {
        payload = await pageFetchJson(nextUrl);
      } catch (error) {
        incompleteReason = error.message;
        rawPayloads.push({ url: nextUrl, payload: { ok: false, error: error.message } });
        break;
      }
      rawPayloads.push({ url: nextUrl, payload });
      ingestPayload(payload);
      await writeProgress({
        stage: 'api-main-pages',
        apiStats: {
          page,
          cursor,
          hasMore,
          rawPageCount: rawPayloads.length,
        },
      });
      cursor = payload.data?.cursor || '';
      xsecToken = payload.data?.xsec_token || xsecToken;
      hasMore = Boolean(payload.data?.has_more);
      page += 1;
      await sleep(randomDelay(commentDelayMinMs, commentDelayMaxMs));
    }
  }

  async function fetchRemainingSubComments() {
    if (incompleteReason) return;
    const roots = [...commentsById.values()].filter((row) => Number(row.level || 0) === 0 && Number(row.child_count || 0) > 1);
    let rootIndex = 0;
    for (const root of roots.slice(0, maxSubCommentRoots)) {
      rootIndex += 1;
      const rawRoot = rawPayloads.flatMap((item) => commentRows(item.payload)).find((row) => String(row.id || '') === root.rpid);
      let cursor = rawRoot?.sub_comment_cursor || '';
      let hasMore = Boolean(rawRoot?.sub_comment_has_more);
      const noteId = rawRoot?.note_id || xhsNoteIdFromUrl(url);
      let page = 1;
      while (hasMore && cursor && noteId && page <= maxSubCommentPages) {
        const xsecToken = latestXsecToken();
        const nextUrl = `https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?note_id=${encodeURIComponent(noteId)}&root_comment_id=${encodeURIComponent(root.rpid)}&num=10&cursor=${encodeURIComponent(cursor)}&image_formats=jpg,webp,avif&top_comment_id=${xsecToken ? `&xsec_token=${encodeURIComponent(xsecToken)}` : ''}`;
        let payload;
        try {
          payload = await pageFetchJson(nextUrl);
        } catch (error) {
          incompleteReason = incompleteReason || error.message;
          rawPayloads.push({ url: nextUrl, payload: { ok: false, error: error.message } });
          break;
        }
        rawPayloads.push({ url: nextUrl, payload });
        ingestPayload(payload, root.rpid);
        await writeProgress({
          stage: 'api-sub-pages',
          apiStats: {
            rootIndex,
            roots: Math.min(roots.length, maxSubCommentRoots),
            rootId: root.rpid,
            page,
            cursor,
            hasMore,
            rawPageCount: rawPayloads.length,
          },
        });
        cursor = payload.data?.cursor || '';
        hasMore = Boolean(payload.data?.has_more);
        page += 1;
        await sleep(randomDelay(subCommentDelayMinMs, subCommentDelayMaxMs));
      }
    }
  }

  function xhsNoteIdFromUrl(input) {
    try {
      return new URL(input).pathname.split('/').filter(Boolean).pop() || '';
    } catch {
      return '';
    }
  }

  try {
    if (enablePageFetch && !visualComplete) {
      await fetchRemainingCommentPages();
      await fetchRemainingSubComments();
    }
  } catch (error) {
    incompleteReason = incompleteReason || error.message;
    rawPayloads.push({ url: 'browser-page-fetch-error', payload: { ok: false, error: error.message } });
  }

  const pageState = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const state = window.__INITIAL_STATE__ || window.__INITIAL_DATA__ || {};
        const noteDetailMap = state?.note?.noteDetailMap || {};
        const noteId = Object.keys(noteDetailMap)[0] || '';
        const detail = noteDetailMap[noteId] || {};
        const comments = detail?.comments?.list || [];
        return {
          title: document.title,
          url: location.href,
          bodyText: document.body.innerText.slice(0, 5000),
          noteId,
          note: detail.note || null,
          stateComments: comments,
          scrollables: [...document.querySelectorAll('body *')]
            .filter(el => el.scrollHeight > el.clientHeight + 20)
            .slice(0, 40)
            .map(el => ({
              tag: el.tagName,
              id: el.id || '',
              className: String(el.className || '').slice(0, 180),
              scrollTop: el.scrollTop,
              clientHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
              text: (el.innerText || '').slice(0, 180),
            })),
        };
      })();
    `,
    returnByValue: true,
  });

  const stateComments = pageState.result?.value?.stateComments || [];
  for (const row of flattenCommentsFromPayload({ data: { comments: stateComments } })) {
    const item = normalizeComment(row, row.root_comment_id ? 1 : 0);
    mergeComment(commentsById, item);
  }

  const result = {
    ok: true,
    capturedAt: new Date().toISOString(),
    url,
    chrome: {
      port,
      headless: process.env.XHS_CHROME_HEADLESS === '1',
      persistentProfile: process.env.XHS_CHROME_EPHEMERAL !== '1',
      pacing: {
        visualCapture,
        visualMaxRounds,
        visualStableRounds,
        visualDelayMinMs,
        visualDelayMaxMs,
        visualWheelMin,
        visualWheelMax,
        visualClickMax,
        commentDelayMinMs,
        commentDelayMaxMs,
        subCommentDelayMinMs,
        subCommentDelayMaxMs,
      },
    },
    visualStats,
    rawPageCount: rawPayloads.length,
    incompleteReason,
    rawPayloads,
    pageState: pageState.result?.value || {},
    comments: [...commentsById.values()],
  };
  await writeProgress({ stage: 'done', final: true });
  await fs.writeFile(outPath, JSON.stringify(result, null, 2));
  if (browserCdp && target.id) {
    await browserCdp.send('Target.closeTarget', { targetId: target.id }, 5000).catch(() => {});
  }
  cdp.close();
  if (ownsChrome && browserCdp) {
    await browserCdp.send('Browser.close', {}, 5000).catch(() => {});
    browserCdp.close();
  }
  console.log(JSON.stringify({
    ok: true,
    outPath,
    port,
    rawPageCount: result.rawPageCount,
    comments: result.comments.length,
    title: result.pageState.title,
    currentUrl: result.pageState.url,
  }, null, 2));
}

main().catch(async (error) => {
  await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
  await fs.writeFile(outPath, JSON.stringify({ ok: false, error: error.message }, null, 2)).catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  await releaseLock();
});
