import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const appDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const repoRoot = path.resolve(appDir, '../..');
const publicDir = path.join(appDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(appDir, 'data');
const jobsDir = path.join(dataDir, 'jobs');
const jobsPath = path.join(dataDir, 'jobs.json');
const tokenPath = path.join(dataDir, 'access_token.txt');
const port = Number(process.env.PORT || 8799);
const loginPassword = process.env.FLYINGLAP_PASSWORD || '2026';
const sessionSecretPath = path.join(dataDir, 'session_secret.txt');
const ticnoteParentId = process.env.TICNOTE_PARENT_ID || '1956577365333659247';
const asrBaseUrl = (process.env.FLYINGLAP_ASR_BASE_URL || 'https://asr.theflyinglapdamnu.top').replace(/\/+$/, '');
const asrTokenPath = path.join(repoRoot, 'auth/asr-studio-api-token.txt');
const asrEngine = process.env.FLYINGLAP_ASR_ENGINE || '16k_zh_en';
const asrPollIntervalMs = Number(process.env.FLYINGLAP_ASR_POLL_INTERVAL_MS || 10000);
const asrTimeoutMs = Number(process.env.FLYINGLAP_ASR_TIMEOUT_MS || 2 * 60 * 60 * 1000);
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ytDlp = process.env.YT_DLP || 'yt-dlp';
const python3 = process.env.PYTHON3 || 'python3';
const chromeForPdf = process.env.CHROME_FOR_PDF || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

await fs.mkdir(jobsDir, { recursive: true });
const accessToken = await loadAccessToken();
const sessionSecret = await loadSessionSecret();
let jobs = await loadJobs();
let xhsQueue = Promise.resolve();
const activeProcesses = new Map();
for (const job of jobs) {
  if (job.state === 'queued' || job.state === 'running') {
    const hasPartialXhs = (job.platform === 'xiaohongshu' || isXiaohongshuUrl(job.url || ''))
      && job.outputs?.json
      && fsSync.existsSync(job.outputs.json);
    job.state = hasPartialXhs ? 'partial' : 'failed';
    job.xhsIncomplete = hasPartialXhs ? true : job.xhsIncomplete;
    job.xhsIncompleteReason = hasPartialXhs
      ? (job.xhsIncompleteReason || '服务重启，旧小红书任务已停止；已保留现有部分评论。')
      : job.xhsIncompleteReason;
    job.log = [...(job.log || []), hasPartialXhs ? '服务重启，旧小红书任务已停止；已保留为部分完成。' : '服务重启，旧任务已停止。'];
  }
}
await saveJobs();

function now() {
  return new Date().toISOString();
}

function clockTime(date = new Date()) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':');
}

function localTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function hms(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function loadJobs() {
  try {
    return JSON.parse(await fs.readFile(jobsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveJobs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2));
}

async function loadAccessToken() {
  if (process.env.FLYINGLAP_ACCESS_TOKEN) return process.env.FLYINGLAP_ACCESS_TOKEN.trim();
  try {
    return (await fs.readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const token = crypto.randomBytes(24).toString('base64url');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

async function loadSessionSecret() {
  try {
    return (await fs.readFile(sessionSecretPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const secret = crypto.randomBytes(32).toString('base64url');
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(sessionSecretPath, `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(value) {
  if (!value || !value.includes('.')) return false;
  const [body, sig] = value.split('.', 2);
  const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp && Date.now() < payload.exp;
  } catch {
    return false;
  }
}

function publicJob(job) {
  const completion = xhsCompletionStatus(job);
  const canReadView = Boolean(job.outputs?.json || job.outputs?.danmaku || fsSync.existsSync(transcriptPath(job)));
  const metadata = job.outputs?.metadata ? readJsonFile(job.outputs.metadata, null) : null;
  if (metadata && (metadata.platform === 'xiaohongshu' || job.platform === 'xiaohongshu')) {
    metadata.title = cleanXhsTitle(metadata.title || job.title || '');
  }
  return {
    ...job,
    title: displayTitle(job),
    state: completion.state || job.state,
    timeline: timelineForJob(job),
    xhsCompletion: completion.details || job.xhsCompletion || null,
    metadata,
    preview: job.outputs?.final ? readPreview(job.outputs.final) : '',
    captureProgress: readCaptureProgress(job),
    view: canReadView ? readJobView(job) : null,
  };
}

function isTerminalState(state) {
  return ['done', 'partial', 'failed', 'stopped'].includes(state);
}

function xhsCompletionStatus(job) {
  if (job.platform !== 'xiaohongshu' && !isXiaohongshuUrl(job.url || '')) return {};
  const metadata = job.outputs?.metadata ? readJsonFile(job.outputs.metadata, {}) : {};
  const comments = job.outputs?.json ? readJsonFile(job.outputs.json, []) : [];
  const total = Number(metadata.commentCount || 0);
  const captured = Array.isArray(comments) ? comments.length : 0;
  const missing = total ? Math.max(0, total - captured) : 0;
  const incomplete = Boolean(job.xhsIncomplete || (total && captured && captured < total));
  const details = {
    total,
    captured,
    missing,
    complete: !incomplete,
    reason: job.xhsIncompleteReason || '',
  };
  if ((job.state === 'done' || job.state === 'partial') && incomplete) return { state: 'partial', details };
  return { details };
}

function ensureNotStopped(job) {
  if (job.state === 'stopped' || job.stopRequested) throw new Error('任务已手动停止');
}

function readCaptureProgress(job) {
  return readJsonFile(path.join(jobsDir, job.id, 'xhs_progress.json'), null);
}

function visibleJobs() {
  const seen = new Set();
  return jobs
    .slice()
    .sort((a, b) => String(b.updatedAt || b.finishedAt || b.startedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.finishedAt || a.startedAt || a.createdAt || '')))
    .filter((job) => {
      const key = job.contentKey || contentKey(job.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function cleanFilePart(value, fallback = 'capture') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

function cleanXhsTitle(value, fallback = '') {
  return String(value || fallback)
    .replace(/\s*[-–—|｜]\s*(小红书|REDnote)\s*$/gi, '')
    .replace(/\s*(小红书|REDnote)\s*$/gi, '')
    .replace(/\s*[-–—|｜]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayTitle(job) {
  const title = job?.title || job?.url || '';
  return job?.platform === 'xiaohongshu' || isXiaohongshuUrl(job?.url || '')
    ? cleanXhsTitle(title, title)
    : title;
}

function markdownDownloadName(job) {
  const platform = cleanFilePart(job.platform || 'video');
  const title = cleanFilePart(displayTitle(job) || job.url || job.id);
  return `${platform}_${title}.md`;
}

function contentDispositionFilename(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function readPreview(filePath) {
  try {
    return fsSync.readFileSync(filePath, 'utf8').slice(0, 18000);
  } catch {
    return '';
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function collectKnownEmoteDictionary() {
  const map = new Map();
  function add(token, url, source = '') {
    const key = String(token || '').trim();
    let value = String(url || '').trim();
    if (!key || !value) return;
    if (value.startsWith('//')) value = `https:${value}`;
    if (!/^https?:\/\//i.test(value)) return;
    if (!map.has(key)) map.set(key, { token: key, url: value, source });
  }
  function walk(value, source) {
    if (!value || typeof value !== 'object') return;
    if (value.content?.emote && typeof value.content.emote === 'object') {
      for (const [token, info] of Object.entries(value.content.emote)) {
        add(token, info?.url || info?.gif_url || info?.webp_url, source);
      }
    }
    if (value.emote && typeof value.emote === 'object') {
      for (const [token, info] of Object.entries(value.emote)) {
        add(token, info?.url || info?.gif_url || info?.webp_url, source);
      }
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, source);
    } else {
      for (const item of Object.values(value)) walk(item, source);
    }
  }
  try {
    for (const id of fsSync.readdirSync(jobsDir)) {
      const jobDir = path.join(jobsDir, id);
      for (const name of ['comments_all.json', 'comments_main_pages.json', 'xhs_browser_capture.json', 'xhs_comments_pages.json']) {
        const file = path.join(jobDir, name);
        if (!fsSync.existsSync(file)) continue;
        const data = readJsonFile(file, null);
        if (!data) continue;
        if (Array.isArray(data)) {
          for (const row of data) {
            for (const emote of row?.emotes || []) add(emote.token || emote.text, emote.url, name);
          }
        }
        if (Array.isArray(data?.comments)) {
          for (const row of data.comments) {
            for (const emote of row?.emotes || []) add(emote.token || emote.text, emote.url, name);
          }
        }
        walk(data, name);
      }
    }
  } catch {}
  return [...map.values()];
}

function numericValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const multiplier = /万/.test(text) ? 10000 : /亿/.test(text) ? 100000000 : 1;
  const match = text.replace(/,/g, '').match(/[\d.]+/);
  if (!match) return undefined;
  return Math.round(Number(match[0]) * multiplier);
}

function firstNumeric(...values) {
  for (const value of values) {
    const number = numericValue(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function interactionStats(metadata = {}, platform = '', comments = [], danmaku = []) {
  const stat = metadata.stat || metadata.stats || {};
  const interact = metadata.interactInfo || metadata.interact_info || metadata.interact_info_v2 || metadata.note?.interactInfo || {};
  const xhsCounters = metadata.counts || {};
  return {
    viewCount: firstNumeric(stat.view, stat.play, metadata.view_count, metadata.viewCount, metadata.play_count, metadata.playCount, metadata.viewCountText),
    likeCount: firstNumeric(stat.like, metadata.like_count, metadata.likeCount, metadata.likedCount, interact.liked_count, interact.likedCount, interact.likeCount, xhsCounters.likeCount),
    coinCount: firstNumeric(stat.coin, metadata.coin_count, metadata.coinCount),
    favoriteCount: firstNumeric(stat.favorite, metadata.favorite_count, metadata.favoriteCount, metadata.collectedCount, interact.collected_count, interact.collectedCount, interact.collectCount, xhsCounters.favoriteCount),
    shareCount: firstNumeric(stat.share, metadata.share_count, metadata.shareCount, metadata.sharedCount, interact.share_count, interact.shareCount, xhsCounters.shareCount),
    commentCount: firstNumeric(stat.reply, metadata.commentCount, metadata.comment_count, interact.comment_count, interact.commentCount, xhsCounters.commentCount, Array.isArray(comments) ? comments.length : undefined),
    danmakuCount: firstNumeric(stat.danmaku, metadata.danmakuCount, Array.isArray(danmaku) ? danmaku.length : undefined),
    platform: platform || metadata.platform || '',
  };
}

function mergeCommentRows(primary, secondary) {
  const map = new Map();
  for (const row of [...(secondary || []), ...(primary || [])]) {
    const key = commentIdentity(row);
    if (!map.has(key)) map.set(key, row);
    else map.set(key, { ...map.get(key), ...row });
  }
  return [...map.values()];
}

function normalizedCommentText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”‘']/g, '')
    .trim();
}

function semanticCommentKey(row) {
  return [
    Number(row?.level || 0),
    String(row?.user || '').trim(),
    normalizedCommentText(row?.message),
  ].join('\t');
}

function commentIdentity(row) {
  const rpid = String(row?.rpid || '');
  if (rpid && !rpid.startsWith('dom-')) return `id:${rpid}`;
  const user = String(row?.user || row?.mid || '').trim();
  const message = normalizedCommentText(row?.message);
  const level = Number(row?.level || 0);
  const parent = String(row?.parent || row?.root || '').trim();
  if (user || message) return `dom:${level}:${parent}:${user}:${message}`;
  return `fallback:${rpid || crypto.randomUUID()}`;
}

function commentDedupeReport(originalRows, dedupedRows) {
  const contentGroups = new Map();
  for (const row of dedupedRows) {
    const message = normalizedCommentText(row.message);
    if (!message) continue;
    const key = `${Number(row.level || 0)}\t${String(row.user || row.mid || '').trim()}\t${message}`;
    if (!contentGroups.has(key)) contentGroups.set(key, []);
    contentGroups.get(key).push({
      rpid: row.rpid || '',
      level: Number(row.level || 0),
      parent: row.parent || row.root || '',
      user: row.user || '',
      mid: row.mid || '',
      message,
    });
  }
  const suspiciousSameUserText = [...contentGroups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      count: group.length,
      ids: group.map((row) => row.rpid),
      user: group[0].user,
      level: group[0].level,
      message: group[0].message,
      rows: group.slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count);
  return {
    originalCount: originalRows.length,
    dedupedCount: dedupedRows.length,
    removedCount: originalRows.length - dedupedRows.length,
    realIdCount: dedupedRows.filter((row) => row.rpid && !String(row.rpid).startsWith('dom-')).length,
    domIdCount: dedupedRows.filter((row) => String(row.rpid || '').startsWith('dom-')).length,
    suspiciousSameUserTextCount: suspiciousSameUserText.length,
    suspiciousSameUserText: suspiciousSameUserText.slice(0, 80),
  };
}

function dedupeComments(comments) {
  const realSemanticKeys = new Set();
  for (const row of comments || []) {
    const rpid = String(row?.rpid || '');
    if (!rpid || rpid.startsWith('dom-')) continue;
    realSemanticKeys.add(semanticCommentKey(row));
  }
  const map = new Map();
  const order = [];
  for (const row of comments || []) {
    const rpid = String(row?.rpid || '');
    if ((!rpid || rpid.startsWith('dom-')) && realSemanticKeys.has(semanticCommentKey(row))) continue;
    const key = rpid && !rpid.startsWith('dom-') ? `id:${rpid}` : commentIdentity(row);
    const old = map.get(key);
    if (!old) {
      map.set(key, row);
      order.push(key);
      continue;
    }
    map.set(key, {
      ...old,
      ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '' && value !== 0 && value !== undefined && value !== null)),
    });
  }
  return order.map((key) => map.get(key));
}

function cooldownMs(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Math.max(0, time - Date.now());
}

function transcriptPath(job) {
  const jobDir = path.join(jobsDir, job.id);
  const asrPath = path.join(jobDir, 'video_audio_asr_transcript.json');
  if (fsSync.existsSync(asrPath)) return asrPath;
  return path.join(jobDir, 'video_audio_ticnote_transcript.txt');
}

function transcriptionNote(job) {
  const info = job?.transcription || {};
  if (!info.provider) return '';
  const bits = [`视频转写 API：${info.provider}`];
  if (info.apiBase) bits.push(`Base URL ${info.apiBase}`);
  if (info.createEndpoint) bits.push(`提交端点 ${info.createEndpoint}`);
  if (info.transcriptEndpoint) bits.push(`结果端点 ${info.transcriptEndpoint}`);
  if (info.engine) bits.push(`模型 ${info.engine}`);
  if (info.jobId) bits.push(`ASR Job ${info.jobId}`);
  return bits.join('；') + '。';
}

function readJobView(job) {
  const metadata = job.outputs?.metadata ? readJsonFile(job.outputs.metadata, {}) : {};
  const savedComments = job.outputs?.json ? readJsonFile(job.outputs.json, []) : [];
  const partialComments = job.state === 'running'
    ? readJsonFile(path.join(jobsDir, job.id, 'xhs_partial_comments.json'), [])
    : [];
  const comments = Array.isArray(partialComments) && partialComments.length > savedComments.length
    ? partialComments
    : savedComments;
  const danmaku = job.outputs?.danmaku ? readJsonFile(job.outputs.danmaku, []) : [];
  const transcript = readJsonFile(transcriptPath(job), []);
  const transcriptRows = Array.isArray(transcript) ? transcript : [];
  const commentRows = Array.isArray(comments) ? comments : [];
  const danmakuRows = Array.isArray(danmaku) ? danmaku : [];
  return {
    content: buildContentPreview(job, metadata),
    stats: {
      transcriptCount: transcriptRows.length,
      commentCount: commentRows.length,
      sourceCommentCount: Number(metadata.commentCount || 0),
      mainCommentCount: commentRows.filter((row) => Number(row.level || 0) === 0).length,
      danmakuCount: danmakuRows.length,
      interaction: interactionStats(metadata, job.platform, commentRows, danmakuRows),
    },
    transcript: transcriptRows.slice(0, 120).map((row) => ({
      start: row.start,
      end: row.end,
      speaker: row.speaker || '',
      text: row.text || '',
    })),
    comments: buildCommentTree(commentRows).slice(0, 300),
    danmaku: danmakuRows.slice(0, 1000).map((row) => ({
      time: row.time,
      text: row.text || '',
      color: row.color || '',
      mode: row.mode || '',
      userHash: row.userHash || '',
    })),
  };
}

function normalizeMediaUrl(value) {
  let url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) url = `https:${url}`;
  if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
  return /^https?:\/\//i.test(url) ? url : '';
}

function xhsImageUrl(item) {
  if (!item || typeof item !== 'object') return normalizeMediaUrl(item);
  const list = Array.isArray(item.infoList) ? item.infoList : [];
  const preferred = list.find((entry) => /DFT|ORIGIN|MAIN/i.test(entry?.imageScene || ''))
    || list.find((entry) => entry?.url)
    || {};
  return normalizeMediaUrl(
    item.urlDefault
    || item.url_default
    || preferred.url
    || item.urlPre
    || item.url_pre
    || item.url
  );
}

function xhsContentImageUrls(job, metadata = {}) {
  const browserNote = readXhsBrowserNote(job) || {};
  const imageList = []
    .concat(metadata.imageList || [])
    .concat(metadata.images || [])
    .concat(metadata.note?.imageList || [])
    .concat(browserNote.imageList || []);
  const seen = new Set();
  return imageList
    .map(xhsImageUrl)
    .filter(Boolean)
    .filter((url) => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function contentImageProxyUrl(job, index) {
  return `/api/jobs/${encodeURIComponent(job.id)}/content-image?index=${index}`;
}

function contentImageUrls(job, metadata = {}) {
  const platform = job.platform || metadata.platform || '';
  if (platform === 'xiaohongshu' || isXiaohongshuUrl(job.url || '')) {
    return xhsContentImageUrls(job, metadata);
  }
  const cover = normalizeMediaUrl(metadata.pic || metadata.cover || metadata.thumbnail || metadata.thumbnail_url);
  return cover ? [cover] : [];
}

function readXhsBrowserNote(job) {
  const capturePath = path.join(jobsDir, job.id, 'xhs_browser_capture.json');
  const capture = readJsonFile(capturePath, null);
  return capture?.pageState?.note || capture?.note || null;
}

function cleanXhsDesc(text) {
  return String(text || '')
    .replace(/#([^#[\]\s]+)\[话题\]#/g, '#$1')
    .replace(/\[话题\]/g, '')
    .trim();
}

function buildContentPreview(job, metadata = {}) {
  const platform = job.platform || metadata.platform || '';
  const content = {
    platform,
    title: metadata.title || job.title || '',
    text: metadata.desc || metadata.description || '',
    images: [],
    cover: '',
  };

  if (platform === 'xiaohongshu' || isXiaohongshuUrl(job.url || '')) {
    const browserNote = readXhsBrowserNote(job) || {};
    const imageUrls = xhsContentImageUrls(job, metadata);
    content.title = cleanXhsTitle(browserNote.title || content.title);
    content.text = cleanXhsDesc(browserNote.desc || content.text);
    content.images = imageUrls.map((_, index) => contentImageProxyUrl(job, index));
    content.originalImages = imageUrls;
    return content;
  }

  const imageUrls = contentImageUrls(job, metadata);
  if (imageUrls.length) {
    content.cover = imageUrls[0];
    content.images = imageUrls.map((_, index) => contentImageProxyUrl(job, index));
    content.originalImages = imageUrls;
  }
  content.text = metadata.desc || metadata.description || metadata.intro || '';
  return content;
}

function publicComment(row) {
  return {
    id: row.rpid || '',
    level: Number(row.level || 0),
    userId: row.mid || row.user || row.rpid || '',
    user: row.user || '',
    sex: row.sex || '',
    userLevel: row.userLevel || '',
    fansMedal: row.fansMedal || '',
    time: row.time || '',
    ctime: row.ctime || 0,
    like: row.like || 0,
    replyTo: row.replyTo || replyTargetName(row.message),
    emotes: Array.isArray(row.emotes) ? row.emotes : [],
    message: row.message || '',
  };
}

function cleanCommentUser(value) {
  return String(value || '')
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function replyTargetName(message) {
  const match = String(message || '').match(/^\s*回复\s+@?(.+?)\s*[:：]/);
  return match ? cleanCommentUser(match[1]) : '';
}

function rowReplyTarget(row) {
  return cleanCommentUser(row.replyTo || replyTargetName(row.message));
}

function buildCommentTree(rows) {
  const map = new Map();
  const roots = [];
  const normalized = [];
  const recentUsers = new Map();
  let lastRootId = '';
  for (const row of rows) {
    const id = String(row.rpid || '');
    if (!id) continue;
    const rawLevel = Number(row.level || 0);
    const targetName = rowReplyTarget(row);
    const hasLinkedParent = Boolean(String(row.parent || row.root || '').trim());
    const next = { ...row };
    const target = targetName ? recentUsers.get(targetName) : null;
    if (targetName && target) {
      next.level = Math.max(1, Number(target.level || 0) + 1);
      next.root = target.rootId || lastRootId || '';
      next.parent = target.id;
    } else if (targetName && !hasLinkedParent) {
      const rootId = target?.rootId || lastRootId;
      next.level = rootId ? 1 : 0;
      if (rootId) {
        next.root = rootId;
        next.parent = rootId;
      }
    } else if (rawLevel <= 0) {
      next.level = 0;
      lastRootId = id;
    } else {
      next.level = Math.max(1, rawLevel);
      if (!next.parent && !next.root && lastRootId) {
        next.parent = lastRootId;
        next.root = lastRootId;
      }
    }
    normalized.push(next);
    map.set(id, { ...publicComment(next), children: [] });
    const user = cleanCommentUser(next.user || next.mid);
    if (user) {
      const rootId = Number(next.level || 0) > 0 ? String(next.root || lastRootId || id) : id;
      recentUsers.set(user, { id, rootId, level: Number(next.level || 0) });
    }
    if (Number(next.level || 0) <= 0) lastRootId = id;
  }
  for (const row of normalized) {
    const node = map.get(String(row.rpid || ''));
    if (!node) continue;
    const parentId = String(row.parent || '');
    const rootId = String(row.root || '');
    const parent = parentId && parentId !== '0' && parentId !== row.rpid ? map.get(parentId) : null;
    const root = rootId && rootId !== '0' && rootId !== row.rpid ? map.get(rootId) : null;
    if (parent) parent.children.push(node);
    else if (root && root !== node) root.children.push(node);
    else if (Number(row.level || 0) > 0 && roots.length) roots[roots.length - 1].children.push(node);
    else roots.push(node);
  }
  function assignDepth(nodes, depth = 0) {
    for (const node of nodes) {
      node.level = depth;
      if (node.children?.length) assignDepth(node.children, depth + 1);
    }
  }
  assignDepth(roots);
  return roots;
}

function log(job, text) {
  job.log = [...(job.log || []), `[${clockTime()}] ${text}`].slice(-300);
  saveJobs().catch(() => {});
}

function markTimeline(job, type, label, status = 'done', detail = '') {
  const event = { type, label, status, detail, at: now() };
  const timeline = Array.isArray(job.timeline) ? job.timeline.filter((item) => item?.type !== type) : [];
  timeline.push(event);
  job.timeline = timeline.slice(-80);
  saveJobs().catch(() => {});
  return event;
}

function timelineForJob(job) {
  const map = new Map();
  function add(type, label, at, status = 'done', detail = '') {
    if (!at || map.has(type)) return;
    map.set(type, { type, label, at, status, detail });
  }
  add('created', '任务创建', job.createdAt);
  add('capture-started', '开始捕捉', job.startedAt, job.state === 'running' ? 'running' : 'done');
  for (const event of job.timeline || []) {
    if (event?.type && event?.at) map.set(event.type, event);
  }
  add('summary-done', 'AI 总结完成', job.summaryAt);
  add('job-finished', job.state === 'failed' ? '任务失败' : job.state === 'stopped' ? '任务停止' : '任务完成', job.finishedAt, job.state === 'failed' ? 'failed' : job.state === 'stopped' ? 'stopped' : 'done');
  return [...map.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function json(res, status, body) {
  return jsonWithHeaders(res, status, body);
}

function jsonWithHeaders(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 256 * 1024) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function staticFile(res, filePath, type, headers = {}) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, ...headers });
    res.end(body);
  } catch {
    json(res, 404, { ok: false, error: 'not found' });
  }
}

function authorized(req, url) {
  if (!accessToken) return true;
  const cookies = parseCookies(req);
  if (verifySession(cookies.flyinglap_session)) return true;
  const header = req.headers['x-access-token'] || '';
  const auth = req.headers.authorization || '';
  return header === accessToken
    || auth === `Bearer ${accessToken}`
    || url.searchParams.get('token') === accessToken;
}

function authHtml(res) {
  const body = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FlyingLap Danmu Login</title><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;background:#f6f7f9;color:#1f242b"><main style="width:min(420px,calc(100vw - 32px));margin:12vh auto;background:#fff;border:1px solid #dfe4ea;border-radius:8px;padding:22px"><h1 style="font-size:24px;margin:0 0 8px">FlyingLap Danmu Capture</h1><p style="color:#66717f;margin:0 0 18px">输入访问密码。</p><form id="login" style="display:grid;gap:10px"><input name="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="密码" autofocus style="border:1px solid #dfe4ea;border-radius:6px;padding:12px;font-size:16px"><button style="border:0;background:#0f766e;color:#fff;border-radius:6px;padding:12px;font-weight:700">登录</button><p id="msg" style="color:#b42318;margin:0;font-size:14px"></p></form></main><script>document.querySelector('#login').addEventListener('submit',async(e)=>{e.preventDefault();const msg=document.querySelector('#msg');msg.textContent='';const password=e.currentTarget.password.value;const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(res.ok){location.href='/'}else{msg.textContent='密码不对';}})</script></body></html>`;
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function cookieFlags(req) {
  const proto = req.headers['x-forwarded-proto'] || '';
  const secure = proto === 'https' || String(req.headers.host || '').includes('theflyinglapdamnu.top');
  return `HttpOnly; Path=/; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`;
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const job = options.job || null;
    if (job?.id) {
      if (!activeProcesses.has(job.id)) activeProcesses.set(job.id, new Set());
      activeProcesses.get(job.id).add(child);
    }
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs) : null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      options.onOutput?.(chunk.toString());
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (job?.id) {
        const set = activeProcesses.get(job.id);
        if (set) {
          set.delete(child);
          if (!set.size) activeProcesses.delete(job.id);
        }
      }
      if (timer) clearTimeout(timer);
      if (job?.stopRequested || job?.state === 'stopped') {
        reject(new Error('任务已手动停止'));
        return;
      }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

function spawnBuffer(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    let stderr = '';
    const timer = options.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs) : null;
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

function stopJobProcesses(job) {
  const set = activeProcesses.get(job.id);
  if (!set?.size) return 0;
  let count = 0;
  for (const child of [...set]) {
    if (child.exitCode !== null || child.killed) continue;
    count += 1;
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 8000).unref();
  }
  return count;
}

async function requestJson(url, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  const payload = await response.json();
  if (payload.code !== undefined && payload.code !== 0) throw new Error(`Bilibili code=${payload.code} ${payload.message || ''}`);
  return payload.data ?? payload;
}

async function readCookieHeader() {
  try {
    return (await fs.readFile(path.join(repoRoot, 'HomemacServerAutomation/laplace-live-automation/bilibili-auth/cookie-header.txt'), 'utf8')).trim();
  } catch {
    return '';
  }
}

async function readXhsCookieHeader() {
  try {
    return (await fs.readFile(path.join(repoRoot, 'auth/xiaohongshu-cookie-header.txt'), 'utf8')).trim();
  } catch {
    return '';
  }
}

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

function imageKey(url) {
  return path.basename(new URL(url).pathname).split('.')[0];
}

async function bilibiliMixinKey(referer, cookie) {
  const data = await requestJson('https://api.bilibili.com/x/web-interface/nav', {
    Referer: referer,
    ...(cookie ? { Cookie: cookie } : {}),
  });
  const img = data.wbi_img;
  if (!img?.img_url || !img?.sub_url) throw new Error('Bilibili WBI keys unavailable');
  return getMixinKey(imageKey(img.img_url) + imageKey(img.sub_url));
}

function signedUrl(base, params, mixinKey) {
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(signed).sort().map((key) => {
    const value = String(signed[key]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }).join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${base}?${query}&w_rid=${wRid}`;
}

function bilibiliBvid(url) {
  return String(url).match(/BV[0-9A-Za-z]+/)?.[0] || '';
}

function extractFirstUrl(input) {
  const match = String(input || '').match(/https?:\/\/[^\s"'<>，。！？）)】]+/i);
  return match ? match[0].replace(/[，。！？、；;]+$/, '') : '';
}

async function resolveInputUrl(input) {
  const extracted = extractFirstUrl(input);
  if (!extracted) throw new Error('没有识别到链接');
  let current = extracted;
  for (let i = 0; i < 6; i += 1) {
    const host = new URL(current).hostname.toLowerCase();
    const shouldExpand = host === 'b23.tv'
      || host.endsWith('.b23.tv')
      || host === 'xhslink.com'
      || host.endsWith('.xhslink.com')
      || host === 'xhsurl.com'
      || host.endsWith('.xhsurl.com');
    if (!shouldExpand) break;
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    const location = response.headers.get('location');
    if (!location) break;
    current = new URL(location, current).toString();
  }
  return current;
}

function isXiaohongshuUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('xiaohongshu.com') || host.includes('xhslink.com') || host.includes('xhsurl.com');
  } catch {
    return false;
  }
}

function xhsNoteId(url) {
  const text = String(url || '');
  const match = text.match(/(?:explore|discovery\/item|item)\/([0-9a-fA-F]{24}|[A-Za-z0-9]{16,32})/) || text.match(/[?&]note_id=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function contentKey(inputUrl) {
  const bvid = bilibiliBvid(inputUrl);
  if (bvid) return `bilibili:${bvid}`;
  const noteId = xhsNoteId(inputUrl);
  if (noteId) return `xiaohongshu:${noteId}`;
  try {
    const parsed = new URL(inputUrl);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(spm_id_from|vd_source|share_source|share_id|shareRedId|xhsshare|author_share|apptime|share_from_user_hidden|app_platform|app_version)$/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    return `url:${parsed.toString()}`;
  } catch {
    return `raw:${String(inputUrl || '').trim()}`;
  }
}

function normalizeEmoteUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  return value;
}

function bilibiliEmotes(content = {}) {
  const out = [];
  for (const [token, info] of Object.entries(content.emote || {})) {
    const url = normalizeEmoteUrl(info?.url || info?.gif_url || info?.webp_url);
    if (!token || !url) continue;
    out.push({
      token,
      url,
      text: info?.text || token,
      size: info?.size || 1,
      source: 'bilibili',
    });
  }
  return out;
}

function replyRow(reply, level = 0) {
  const member = reply.member || {};
  const fans = member.fans_detail || {};
  return {
    level,
    rpid: String(reply.rpid_str || reply.rpid || ''),
    root: String(reply.root_str || reply.root || ''),
    parent: String(reply.parent_str || reply.parent || ''),
    user: member.uname || '',
    mid: String(reply.mid_str || reply.mid || member.mid || ''),
    sex: member.sex || '',
    sign: member.sign || '',
    avatar: member.avatar || '',
    userLevel: member.level_info?.current_level ?? '',
    vipType: member.vip?.vipType ?? '',
    vipStatus: member.vip?.vipStatus ?? '',
    officialType: member.official_verify?.type ?? '',
    officialDesc: member.official_verify?.desc || '',
    fansMedal: fans.medal_name ? `${fans.medal_name} LV${fans.level || 0}` : '',
    time: localTime(reply.ctime),
    ctime: reply.ctime || 0,
    like: reply.like || 0,
    child_count: reply.count || reply.rcount || 0,
    message: reply.content?.message || '',
    emotes: bilibiliEmotes(reply.content || {}),
  };
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function collectBilibiliDanmaku(job, jobDir, view, headers) {
  log(job, '抓取弹幕 XML');
  const response = await fetch(`https://comment.bilibili.com/${view.cid}.xml`, {
    headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${view.bvid}/`, ...headers },
  });
  if (!response.ok) throw new Error(`danmaku failed ${response.status}`);
  const xml = await response.text();
  await fs.writeFile(path.join(jobDir, 'danmaku.xml'), xml);
  const rows = [];
  const regex = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = regex.exec(xml))) {
    const p = match[1].split(',');
    rows.push({
      time: Number(p[0] || 0),
      mode: Number(p[1] || 0),
      size: Number(p[2] || 0),
      color: `#${Number(p[3] || 0).toString(16).padStart(6, '0')}`,
      timestamp: Number(p[4] || 0),
      pool: Number(p[5] || 0),
      userHash: p[6] || '',
      id: p[7] || '',
      text: decodeXml(match[2]),
    });
  }
  rows.sort((a, b) => a.time - b.time);
  await writeDanmaku(jobDir, rows);
  log(job, `弹幕抓取完成：${rows.length} 条`);
  return rows;
}

async function writeDanmaku(jobDir, rows) {
  await fs.writeFile(path.join(jobDir, 'danmaku_all.json'), JSON.stringify(rows, null, 2));
  const tsv = [
    ['time', 'mode', 'size', 'color', 'timestamp', 'user_hash', 'id', 'text'].join('\t'),
    ...rows.map((row) => [hms(row.time), row.mode, row.size, row.color, row.timestamp, row.userHash, row.id, String(row.text).replace(/\r?\n/g, '\\n')].join('\t')),
  ].join('\n');
  await fs.writeFile(path.join(jobDir, 'danmaku_all.tsv'), tsv);
}

async function collectBilibili(job, jobDir) {
  const bvid = bilibiliBvid(job.url);
  if (!bvid) throw new Error('没有识别到 Bilibili BVID');
  const referer = `https://www.bilibili.com/video/${bvid}/`;
  const cookie = await readCookieHeader();
  const headers = { Referer: referer, ...(cookie ? { Cookie: cookie } : {}) };

  log(job, `读取 B 站元数据 ${bvid}`);
  const view = await requestJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, headers);
  job.title = view.title;
  job.platform = 'bilibili';
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(view, null, 2));
  job.outputs = { ...(job.outputs || {}), metadata: path.join(jobDir, 'metadata.json') };
  await saveJobs();

  log(job, '抓取主评论和接口内嵌楼中楼预览');
  const mixinKey = await bilibiliMixinKey(referer, cookie);
  const mainPages = [];
  let comments = [];
  const seen = new Set();
  let next = 0;
  let page = 1;
  let count = 0;
  while (true) {
    ensureNotStopped(job);
    const api = signedUrl('https://api.bilibili.com/x/v2/reply/wbi/main', {
      type: 1,
      oid: view.aid,
      mode: 3,
      ps: 20,
      next,
      plat: 1,
      web_location: 1315875,
    }, mixinKey);
    const data = await requestJson(api, headers);
    mainPages.push(data);
    count = data.cursor?.all_count || count;
    const replies = data.replies || [];
    for (const reply of replies) {
      for (const row of [replyRow(reply, 0), ...(reply.replies || []).map((child) => replyRow(child, 1))]) {
        if (!seen.has(row.rpid)) {
          seen.add(row.rpid);
          comments.push(row);
        }
      }
    }
    log(job, `评论页 ${page}: +${replies.length}，累计 ${comments.length}/${count || '?'}`);
    if (!replies.length || data.cursor?.is_end || page > 300) break;
    next = data.cursor?.next ?? next + 1;
    page += 1;
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  await fs.writeFile(path.join(jobDir, 'comments_main_pages.json'), JSON.stringify(mainPages, null, 2));
  comments = await writeComments(jobDir, comments);
  job.outputs = {
    ...(job.outputs || {}),
    json: path.join(jobDir, 'comments_all.json'),
    tsv: path.join(jobDir, 'comments_all.tsv'),
  };
  await saveJobs();
  const danmaku = await collectBilibiliDanmaku(job, jobDir, view, headers);
  job.outputs = {
    ...(job.outputs || {}),
    danmaku: path.join(jobDir, 'danmaku_all.json'),
    danmakuTsv: path.join(jobDir, 'danmaku_all.tsv'),
  };
  await saveJobs();
  markTimeline(job, 'interaction-done', '互动采集完成', 'done', `${comments.length} 条评论，${danmaku.length} 条弹幕`);

  let transcript = [];
  const notes = [
    `B 站显示评论数 ${view.stat?.reply ?? ''}；主评论接口抓取 ${comments.filter((r) => r.level === 0).length} 条主评论，并收录接口内嵌楼中楼预览。`,
    `弹幕 XML 抓取 ${danmaku.length} 条。`,
    'B 站楼中楼独立分页接口在本机批量请求中常返回 412，因此不承诺楼中楼全量。',
  ];
  if (job.transcribeVideo !== false) {
    log(job, '下载音频');
    ensureNotStopped(job);
    const play = await requestJson(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${view.cid}&fnval=4048&fourk=1`, headers);
    await fs.writeFile(path.join(jobDir, 'playurl.json'), JSON.stringify(play, null, 2));
    const audio = [...(play.dash?.audio || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    if (!audio) throw new Error('Bilibili 没有返回可下载音频');
    const audioPath = path.join(jobDir, `${bvid}_audio.m4a`);
    await downloadFile(audio.baseUrl || audio.base_url, audioPath, { Referer: referer, Origin: 'https://www.bilibili.com' });
    transcript = await transcribeAudio(job, audioPath, jobDir);
  } else {
    log(job, '已关闭视频转写，跳过音频下载和 ASR');
    markTimeline(job, 'transcribe-skipped', '跳过视频转写', 'done', '本次关闭转写视频');
    notes.push('本次任务关闭了视频转写，未下载音频、未调用 ASR。');
  }
  return buildFinalMarkdown(jobDir, {
    job,
    sourceUrl: job.url,
    title: view.title,
    platform: 'bilibili',
    metadata: view,
    transcript,
    comments,
    danmaku,
    notes,
  });
}

async function downloadFile(url, outPath, headers = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!response.ok) throw new Error(`download failed ${response.status}: ${url}`);
  const file = fsSync.createWriteStream(outPath);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(new WritableStream({
      write(chunk) { file.write(Buffer.from(chunk)); },
      close() { file.end(resolve); },
      abort(error) { file.destroy(error); reject(error); },
    })).catch(reject);
  });
}

async function writeComments(jobDir, comments) {
  const deduped = dedupeComments(comments);
  await fs.writeFile(path.join(jobDir, 'comments_dedupe_report.json'), JSON.stringify(commentDedupeReport(comments, deduped), null, 2));
  await fs.writeFile(path.join(jobDir, 'comments_all.json'), JSON.stringify(deduped, null, 2));
  const tsv = [
    ['level', 'rpid', 'root', 'parent', 'time', 'user', 'mid', 'sex', 'user_level', 'fans_medal', 'like', 'message'].join('\t'),
    ...deduped.map((row) => [row.level, row.rpid, row.root, row.parent, row.time, row.user, row.mid, row.sex || '', row.userLevel || '', row.fansMedal || '', row.like, String(row.message).replace(/\r?\n/g, '\\n')].join('\t')),
  ].join('\n');
  await fs.writeFile(path.join(jobDir, 'comments_all.tsv'), tsv);
  return deduped;
}

async function collectGeneric(job, jobDir) {
  job.platform = 'generic';
  log(job, '使用 yt-dlp 读取通用视频元数据');
  let metadata = {};
  try {
    ensureNotStopped(job);
    const { stdout } = await spawnCapture(ytDlp, ['--dump-json', '--skip-download', '--no-playlist', job.url], { job });
    metadata = JSON.parse(stdout);
    job.title = metadata.title || job.url;
  } catch (error) {
    log(job, `yt-dlp 元数据失败：${error.message.slice(0, 220)}`);
    metadata = { title: job.url, extractor: 'unknown', warning: error.message };
  }
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  let comments = Array.isArray(metadata.comments) ? metadata.comments.map((item, index) => ({
    level: 0,
    rpid: String(item.id || index + 1),
    user: item.author || '',
    time: item.timestamp ? localTime(item.timestamp) : '',
    like: item.like_count || 0,
    message: item.text || item.comment || '',
  })) : [];
  comments = await writeComments(jobDir, comments);
  markTimeline(job, 'interaction-done', '互动采集完成', 'done', `${comments.length} 条评论`);

  let transcript = [];
  const notes = ['通用平台评论抓取取决于 yt-dlp extractor 是否返回 comments 字段；Bilibili 以外的平台优先保证视频内容转写。'];
  if (job.transcribeVideo !== false) {
    try {
      log(job, '下载通用平台音频');
      ensureNotStopped(job);
      await spawnCapture(ytDlp, ['-f', 'bestaudio/best', '--no-playlist', '-o', path.join(jobDir, 'audio.%(ext)s'), job.url], {
        job,
        onOutput: (text) => {
          const line = text.trim();
          if (line) log(job, line.slice(0, 180));
        },
      });
      const audioFile = (await fs.readdir(jobDir)).find((name) => /^audio\./.test(name));
      if (audioFile) transcript = await transcribeAudio(job, path.join(jobDir, audioFile), jobDir);
    } catch (error) {
      log(job, `通用音频下载/转写失败：${error.message.slice(0, 240)}`);
    }
  } else {
    log(job, '已关闭视频转写，跳过通用平台音频下载和 ASR');
    markTimeline(job, 'transcribe-skipped', '跳过视频转写', 'done', '本次关闭转写视频');
    notes.push('本次任务关闭了视频转写，未下载音频、未调用 ASR。');
  }

  return buildFinalMarkdown(jobDir, {
    job,
    sourceUrl: job.url,
    title: metadata.title || job.url,
    platform: metadata.extractor || 'generic',
    metadata,
    transcript,
    comments,
    danmaku: [],
    notes,
  });
}

async function collectXiaohongshu(job, jobDir) {
  job.platform = 'xiaohongshu';
  const noteId = xhsNoteId(job.url);
  if (!noteId) throw new Error('没有识别到小红书 note id');
  const cookie = await readXhsCookieHeader();
  const headers = {
    'User-Agent': UA,
    Referer: job.url,
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://www.xiaohongshu.com',
    'x-s-common': '',
    'xsecappid': 'xhs-pc-web',
    ...(cookie ? { Cookie: cookie } : {}),
  };

  log(job, '读取小红书页面内容');
  const pageMeta = await fetchXhsPageMeta(job.url, headers).catch((error) => {
    log(job, `小红书页面读取失败：${error.message.slice(0, 180)}`);
    return {};
  });
  const metadata = { noteId, sourceUrl: job.url, platform: 'xiaohongshu', ...pageMeta };
  metadata.title = cleanXhsTitle(metadata.title || '');
  job.title = metadata.title || `小红书 ${noteId}`;
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  job.outputs = { ...(job.outputs || {}), metadata: path.join(jobDir, 'metadata.json') };
  await saveJobs();

  const previousComments = job.outputs?.json ? readJsonFile(job.outputs.json, []) : [];
  let comments = [];
  const rawPages = [];
  const notes = [
    '已使用专用小红书 Chrome 登录 profile 进行页面自动采集。',
  ];
  if (metadata.commentCount) {
    notes.push(`页面显示评论数 ${metadata.commentCount}。`);
  }
  try {
    log(job, '启动专用 Chrome 浏览器观察评论加载');
    const browserCapturePath = path.join(jobDir, 'xhs_browser_capture.json');
    ensureNotStopped(job);
    const { stdout } = await spawnCapture(process.execPath, [
      path.join(appDir, 'capture_xhs_browser.mjs'),
      job.url,
      browserCapturePath,
    ], {
      job,
      timeoutMs: Number(process.env.XHS_CAPTURE_TIMEOUT_MS || 21600000),
      onOutput: (text) => {
        const line = text.trim();
        if (line) log(job, line.slice(0, 180));
      },
    });
    const browserCapture = JSON.parse(await fs.readFile(browserCapturePath, 'utf8'));
    if (browserCapture.ok && Array.isArray(browserCapture.comments) && browserCapture.comments.length) {
      comments = browserCapture.comments;
      await fs.writeFile(path.join(jobDir, 'xhs_comments_pages.json'), JSON.stringify(browserCapture.rawPayloads || [], null, 2));
      const browserNote = browserCapture.pageState?.note || {};
      if (browserNote.title && !metadata.title) metadata.title = cleanXhsTitle(browserNote.title);
      if (browserNote.desc && !metadata.desc) metadata.desc = browserNote.desc;
      if (browserNote.interactInfo) metadata.interactInfo = browserNote.interactInfo;
      if (browserNote.interactInfo?.commentCount && !metadata.commentCount) metadata.commentCount = browserNote.interactInfo.commentCount;
      if (browserNote.interactInfo?.likedCount !== undefined) metadata.likedCount = browserNote.interactInfo.likedCount;
      if (browserNote.interactInfo?.collectedCount !== undefined) metadata.collectedCount = browserNote.interactInfo.collectedCount;
      if (browserNote.interactInfo?.shareCount !== undefined) metadata.shareCount = browserNote.interactInfo.shareCount;
      notes.push(`专用浏览器观察到 ${comments.length} 条评论/子评论。`);
      if (metadata.commentCount) notes.push(`小红书页面显示评论数 ${metadata.commentCount}；本次采集 ${comments.length} 条评论/子评论。`);
      if (browserCapture.visualStats?.rounds) {
        notes.push(`页面自动采集轮次 ${browserCapture.visualStats.rounds}；最后可见去重评论 ${browserCapture.visualStats.visibleComments || 0} 条；${browserCapture.visualStats.atBottom ? '已滚动到底部附近。' : '未确认到达评论底部。'}`);
      }
      if (browserCapture.incompleteReason) notes.push(`小红书后续分页已停止：${browserCapture.incompleteReason}`);
      if (/Account abnormal|账号异常|访问过于频繁|406|300011/i.test(browserCapture.incompleteReason || '')) {
        job.xhsCooldownUntil = new Date(Date.now() + Number(process.env.XHS_COOLDOWN_MS || 30 * 60 * 1000)).toISOString();
        job.xhsIncomplete = true;
        job.xhsIncompleteReason = browserCapture.incompleteReason;
        notes.push(`检测到小红书风控，已进入冷却期至 ${job.xhsCooldownUntil}。`);
        await saveJobs();
      }
      log(job, `专用浏览器评论采集完成：${comments.length} 条`);
    } else {
      notes.push(`专用浏览器未观察到评论响应：${browserCapture.error || stdout.trim().slice(0, 120) || '无评论'}`);
    }
  } catch (error) {
    log(job, `专用浏览器评论采集失败：${error.message.slice(0, 220)}`);
    notes.push(`专用浏览器评论采集失败：${error.message}`);
    const failedCapture = readJsonFile(path.join(jobDir, 'xhs_browser_capture.json'), null);
    if (failedCapture?.incompleteReason) {
      job.xhsIncomplete = true;
      job.xhsIncompleteReason = failedCapture.incompleteReason;
      notes.push(`专用浏览器停止原因：${failedCapture.incompleteReason}`);
      await saveJobs();
    }
  }
  const browserLoginRequired = /登录态|cookie 已失效|登录页|login/i.test(job.xhsIncompleteReason || '');
  if (!comments.length && !browserLoginRequired) try {
    log(job, '抓取小红书评论和子评论');
    let cursor = '';
    let page = 1;
    while (page <= 200) {
      ensureNotStopped(job);
      const payload = await requestXhsJson(`https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=${encodeURIComponent(noteId)}&cursor=${encodeURIComponent(cursor)}&top_comment_id=&image_formats=jpg,webp,avif`, headers);
      rawPages.push(payload);
      if (payload.success === false) {
        throw new Error(`小红书返回 ${payload.code || 'unknown'}：${payload.msg || '接口请求失败'}`);
      }
      const rows = payload.data?.comments || payload.comments || [];
      for (const row of rows) {
        const root = xhsCommentRow(row, 0);
        comments.push(root);
        const inlineSub = row.sub_comments || row.subComments || [];
        for (const child of inlineSub) comments.push(xhsCommentRow(child, 1, root.rpid));
        if ((row.sub_comment_count || 0) > inlineSub.length) {
          const children = await collectXhsSubComments(noteId, root.rpid, headers, job);
          comments.push(...children);
        }
      }
      log(job, `小红书评论页 ${page}: +${rows.length}，累计 ${comments.length}`);
      const nextCursor = payload.data?.cursor || payload.cursor || '';
      const hasMore = payload.data?.has_more ?? payload.has_more ?? Boolean(nextCursor && nextCursor !== cursor);
      if (!rows.length || !hasMore) break;
      cursor = nextCursor;
      page += 1;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  } catch (error) {
    log(job, `小红书评论接口失败：${error.message.slice(0, 220)}`);
    notes.push(`小红书评论接口失败：${error.message}`);
  } else if (browserLoginRequired) {
    log(job, '跳过小红书接口 fallback：浏览器登录态已失效');
    notes.push('跳过小红书接口 fallback：浏览器登录态已失效。');
  }
  if (!comments.length && Array.isArray(previousComments) && previousComments.length) {
    comments = previousComments;
    notes.push(`本次重抓未获得新评论，已保留上一次采集的 ${previousComments.length} 条评论，避免覆盖为空。`);
    log(job, `本次重抓未获得新评论，保留上一次 ${previousComments.length} 条评论`);
  } else if (Array.isArray(previousComments) && previousComments.length && comments.length < previousComments.length) {
    const before = comments.length;
    comments = mergeCommentRows(comments, previousComments);
    notes.push(`本次重抓 ${before} 条少于上次 ${previousComments.length} 条，已合并保留历史评论，当前 ${comments.length} 条。`);
    log(job, `本次重抓少于上次，合并保留到 ${comments.length} 条`);
  }
  await fs.writeFile(path.join(jobDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
  if (!fsSync.existsSync(path.join(jobDir, 'xhs_comments_pages.json'))) {
    await fs.writeFile(path.join(jobDir, 'xhs_comments_pages.json'), JSON.stringify(rawPages, null, 2));
  }
  comments = await writeComments(jobDir, comments);
  const expectedComments = Number(metadata.commentCount || 0);
  if (expectedComments && comments.length < expectedComments) {
    job.xhsIncomplete = true;
    job.xhsIncompleteReason = job.xhsIncompleteReason || `页面显示 ${expectedComments} 条评论/回复，本次只采集 ${comments.length} 条。`;
    job.xhsCompletion = {
      total: expectedComments,
      captured: comments.length,
      missing: expectedComments - comments.length,
      complete: false,
      reason: job.xhsIncompleteReason,
    };
    notes.push(`当前仍未抓全：页面显示 ${expectedComments} 条，已采集 ${comments.length} 条，还差约 ${expectedComments - comments.length} 条。`);
  } else {
    job.xhsIncomplete = false;
    job.xhsIncompleteReason = '';
    job.xhsCompletion = {
      total: expectedComments,
      captured: comments.length,
      missing: 0,
      complete: true,
      reason: '',
    };
  }
  markTimeline(job, 'interaction-done', '互动采集完成', job.xhsIncomplete ? 'failed' : 'done', `${comments.length} 条评论${expectedComments ? ` / 页面显示 ${expectedComments}` : ''}`);
  job.outputs = {
    ...(job.outputs || {}),
    json: path.join(jobDir, 'comments_all.json'),
    tsv: path.join(jobDir, 'comments_all.tsv'),
  };
  await saveJobs();
  return buildFinalMarkdown(jobDir, {
    sourceUrl: job.url,
    title: job.title,
    platform: 'xiaohongshu',
    metadata,
    transcript: [],
    comments,
    danmaku: [],
    notes,
  });
}

async function fetchXhsPageMeta(url, headers) {
  const response = await fetch(url, { headers: { ...headers, Accept: 'text/html,application/xhtml+xml' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 160)}`);
  const title = decodeHtml(text.match(/<meta\s+name="og:title"\s+content="([^"]*)"/i)?.[1]
    || text.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)?.[1]
    || text.match(/<title>([\s\S]*?)<\/title>/i)?.[1]
    || '');
  const desc = decodeHtml(text.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1]
    || text.match(/<meta\s+property="og:description"\s+content="([^"]*)"/i)?.[1]
    || '');
  const commentCount = text.match(/"commentCount"\s*:\s*"?(\d+)/)?.[1]
    || text.match(/"comment_count"\s*:\s*"?(\d+)/)?.[1]
    || '';
  const likedCount = text.match(/"likedCount"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || text.match(/"likeCount"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || text.match(/"liked_count"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || '';
  const collectedCount = text.match(/"collectedCount"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || text.match(/"collectCount"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || text.match(/"collected_count"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || '';
  const shareCount = text.match(/"shareCount"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || text.match(/"share_count"\s*:\s*"?([\d.万亿,]+)/)?.[1]
    || '';
  return { title: cleanXhsTitle(title), desc, commentCount, likedCount, collectedCount, shareCount };
}

function decodeHtml(text) {
  return decodeXml(String(text || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
}

async function collectXhsSubComments(noteId, rootId, headers, job) {
  const out = [];
  let cursor = '';
  let page = 1;
  while (page <= 100) {
    ensureNotStopped(job);
    const payload = await requestXhsJson(`https://edith.xiaohongshu.com/api/sns/web/v2/comment/sub/page?note_id=${encodeURIComponent(noteId)}&root_comment_id=${encodeURIComponent(rootId)}&num=20&cursor=${encodeURIComponent(cursor)}&image_formats=jpg,webp,avif`, headers);
    if (payload.success === false) {
      throw new Error(`小红书子评论返回 ${payload.code || 'unknown'}：${payload.msg || '接口请求失败'}`);
    }
    const rows = payload.data?.comments || payload.data?.sub_comments || payload.comments || [];
    for (const row of rows) out.push(xhsCommentRow(row, 1, rootId));
    const nextCursor = payload.data?.cursor || payload.cursor || '';
    const hasMore = payload.data?.has_more ?? payload.has_more ?? Boolean(nextCursor && nextCursor !== cursor);
    if (!rows.length || !hasMore) break;
    cursor = nextCursor;
    page += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (out.length) log(job, `小红书子评论 ${rootId}: +${out.length}`);
  return out;
}

async function requestXhsJson(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not json: ${text.slice(0, 180)}`);
  }
}

function xhsCommentRow(row, level = 0, root = '') {
  const rootId = root || String(row.root_comment_id || '');
  const parentId = level > 0 ? String(row.target_comment_id || row.parent_comment_id || row.root_comment_id || rootId || '') : '';
  const emotes = [];
  for (const item of row.pictures || row.emojis || row.content_images || []) {
    const token = item.name || item.desc || item.alt || item.text || '';
    const url = normalizeEmoteUrl(item.url || item.link || item.src || '');
    if (token && url) emotes.push({ token: token.startsWith('[') ? token : `[${token}]`, url, source: 'xiaohongshu' });
  }
  const replyTo = cleanCommentUser(
    row.target_comment?.user_info?.nickname
      || row.target_comment?.user?.nickname
      || row.target_user?.nickname
      || row.reply_to_user?.nickname
      || row.reply_user?.nickname
      || row.target_nickname
      || row.reply_to_nickname
      || ''
  );
  return {
    level,
    rpid: String(row.id || row.comment_id || row.note_id || crypto.randomUUID()),
    root: level > 0 ? rootId : '',
    parent: parentId,
    user: row.user_info?.nickname || row.user?.nickname || '',
    mid: String(row.user_info?.user_id || row.user?.user_id || ''),
    sex: '',
    userLevel: '',
    fansMedal: '',
    time: row.create_time ? localTime(Number(row.create_time) / 1000) : '',
    ctime: row.create_time || 0,
    like: row.like_count || row.likes || 0,
    child_count: row.sub_comment_count || row.sub_comments?.length || 0,
    message: row.content || row.text || '',
    replyTo,
    emotes,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function audioMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

function parseAsrTimecode(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(value) || 0;
}

function parseAsrTranscriptText(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^\[([0-9:.]+)\s*-\s*([0-9:.]+)\]\s*([^:：]+)?[:：]\s*(.*)$/.exec(trimmed);
    if (match) {
      rows.push({
        start: parseAsrTimecode(match[1]),
        end: parseAsrTimecode(match[2]),
        speaker: (match[3] || '').trim(),
        text: match[4].trim(),
      });
    } else {
      rows.push({ text: trimmed });
    }
  }
  return rows;
}

async function readAsrToken() {
  return (process.env.FLYINGLAP_ASR_TOKEN || process.env.ASR_STUDIO_API_TOKEN
    || await fs.readFile(asrTokenPath, 'utf8').then((s) => s.trim()).catch(() => '')).trim();
}

function asrHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchAsrJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
  return body;
}

async function uploadAudioToAsrStorage(job, audioPath, token) {
  const signEndpoint = `${asrBaseUrl}/api/uploads/direct-sign`;
  const stat = await fs.stat(audioPath);
  const originalName = path.basename(audioPath);
  const contentType = audioMimeType(audioPath);
  log(job, `请求 ASR 直传签名：${signEndpoint}，文件 ${originalName}，${Math.round(stat.size / 1024 / 1024)} MB`);
  const signed = await fetchAsrJson(signEndpoint, {
    method: 'POST',
    headers: {
      ...asrHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fileName: originalName,
      size: stat.size,
      contentType,
    }),
  });
  const upload = signed.upload || {};
  if (!upload.uploadUrl || !upload.fileUrl || !upload.headers) throw new Error('ASR 直传签名缺少 uploadUrl/fileUrl/headers');

  const audio = await fs.readFile(audioPath);
  const startedAt = Date.now();
  log(job, `直传音频到对象存储：PUT ${new URL(upload.uploadUrl).host}`);
  const response = await fetch(upload.uploadUrl, {
    method: upload.method || 'PUT',
    headers: upload.headers,
    body: audio,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`ASR 直传上传失败：HTTP ${response.status} ${body.slice(0, 240)}`);
  log(job, `ASR 直传完成：${Math.round((Date.now() - startedAt) / 1000)} 秒，${upload.fileUrl}`);
  return {
    sourceUrl: upload.fileUrl,
    originalName: upload.originalName || originalName,
    size: upload.size || stat.size,
    signEndpoint,
    directUploadHost: new URL(upload.uploadUrl).host,
  };
}

async function transcribeWithAsrStudio(job, audioPath, jobDir) {
  const token = await readAsrToken();
  if (!token) throw new Error(`未配置 ASR token：${asrTokenPath}`);
  const createEndpoint = `${asrBaseUrl}/api/jobs`;
  const directUpload = await uploadAudioToAsrStorage(job, audioPath, token);
  log(job, `提交自建 ASR 转写：POST ${createEndpoint}，模型 ${asrEngine}，sourceUrl`);
  markTimeline(job, 'transcribe-start', '开始转写', 'running', `自建 ASR ${asrEngine}`);
  const form = new FormData();
  form.append('sourceUrl', directUpload.sourceUrl);
  form.append('originalName', directUpload.originalName);
  form.append('sourceSize', String(directUpload.size || 0));
  form.append('jobName', `${job.title || job.id} ${path.basename(audioPath)}`.slice(0, 160));
  form.append('engineModelType', asrEngine);
  form.append('speakerDiarization', 'true');
  const created = await fetchAsrJson(createEndpoint, {
    method: 'POST',
    headers: asrHeaders(token),
    body: form,
  });
  const asrJob = created.job || {};
  if (!asrJob.id) throw new Error('ASR 未返回 job.id');
  const transcriptEndpoint = `${asrBaseUrl}/api/jobs/${asrJob.id}/transcript.txt`;
  job.transcription = {
    provider: 'self-hosted Tencent ASR Studio',
    apiBase: asrBaseUrl,
    createEndpoint,
    pollEndpoint: `${asrBaseUrl}/api/jobs/${asrJob.id}`,
    transcriptEndpoint,
    engine: asrEngine,
    jobId: asrJob.id,
    speakerDiarization: true,
    uploadMode: 'direct-cos',
    uploadSignEndpoint: directUpload.signEndpoint,
    directUploadHost: directUpload.directUploadHost,
    sourceUrl: directUpload.sourceUrl,
  };
  await saveJobs();
  await fs.writeFile(path.join(jobDir, 'asr_job.json'), JSON.stringify({ ...job.transcription, job: asrJob }, null, 2));
  log(job, `ASR 任务已创建：${asrJob.id}`);

  const started = Date.now();
  let current = asrJob;
  while (Date.now() - started < asrTimeoutMs) {
    ensureNotStopped(job);
    const status = String(current.status || '').toLowerCase();
    if (['success', 'completed', 'complete', 'done'].includes(status)) break;
    if (['failed', 'error'].includes(status)) throw new Error(current.error || current.message || `ASR 任务失败：${current.status}`);
    await sleep(asrPollIntervalMs);
    const polled = await fetchAsrJson(`${asrBaseUrl}/api/jobs/${encodeURIComponent(asrJob.id)}`, {
      headers: asrHeaders(token),
    });
    current = polled.job || polled;
    log(job, `ASR 转写中：${current.status || 'pending'}`);
  }
  const finalStatus = String(current.status || '').toLowerCase();
  if (!['success', 'completed', 'complete', 'done'].includes(finalStatus)) throw new Error('ASR 转写超时');

  const transcriptResponse = await fetch(`${asrBaseUrl}/api/jobs/${encodeURIComponent(asrJob.id)}/transcript.txt`, {
    headers: asrHeaders(token),
  });
  const transcriptText = await transcriptResponse.text();
  if (!transcriptResponse.ok) throw new Error(`ASR transcript HTTP ${transcriptResponse.status}: ${transcriptText.slice(0, 180)}`);
  const rows = parseAsrTranscriptText(transcriptText);
  await fs.writeFile(path.join(jobDir, 'video_audio_asr_transcript_raw.txt'), transcriptText);
  await fs.writeFile(path.join(jobDir, 'video_audio_asr_transcript.json'), JSON.stringify(rows, null, 2));
  await fs.writeFile(path.join(jobDir, 'transcription_api.json'), JSON.stringify(job.transcription, null, 2));
  log(job, `ASR 转写完成：${rows.length} 段`);
  markTimeline(job, 'transcribe-done', '转写完成', 'done', `自建 ASR：${rows.length} 段`);
  return rows;
}

async function transcribeAudio(job, audioPath, jobDir) {
  try {
    return await transcribeWithAsrStudio(job, audioPath, jobDir);
  } catch (error) {
    log(job, `自建 ASR 转写失败：${error.message}`);
    markTimeline(job, 'asr-failed', '自建 ASR 失败', 'failed', String(error.message || '').slice(0, 120));
  }

  const appkey = process.env.TICNOTE_API_KEY || await fs.readFile(path.join(repoRoot, 'auth/ticnote-appkey.txt'), 'utf8').then((s) => s.trim()).catch(() => '');
  if (!appkey) {
    log(job, '未配置 TICNOTE_API_KEY，跳过音频转写');
    markTimeline(job, 'transcribe-failed', '转写未完成', 'failed', '未配置 TicNote fallback');
    return [];
  }
  const output = path.join(jobDir, 'video_audio_ticnote_transcript.txt');
  job.transcription = {
    provider: 'TicNote audio-to-text fallback',
    apiBase: 'TicNote API via tools/ticnote_audio_to_text.py',
    createEndpoint: 'tools/ticnote_audio_to_text.py',
    transcriptEndpoint: output,
    engine: 'zh + speakers',
    parentId: ticnoteParentId,
  };
  await saveJobs();
  log(job, `提交 TicNote 转写 fallback：${job.transcription.createEndpoint}`);
  markTimeline(job, 'ticnote-start', 'TicNote fallback', 'running', '自建 ASR 失败后切换');
  await spawnCapture(python3, [
    path.join(repoRoot, 'tools/ticnote_audio_to_text.py'),
    audioPath,
    '--parent-id', ticnoteParentId,
    '--language', 'zh',
    '--speakers',
    '--timeout', '1200',
    '--interval', '10',
    '--output', output,
  ], {
    job,
    cwd: repoRoot,
    env: { ...process.env, TICNOTE_API_KEY: appkey },
    onOutput: (text) => {
      for (const line of text.split(/\r?\n/).filter(Boolean).slice(-3)) log(job, line.slice(0, 180));
    },
  });
  const raw = await fs.readFile(output, 'utf8');
  await fs.writeFile(path.join(jobDir, 'transcription_api.json'), JSON.stringify(job.transcription, null, 2));
  try {
    const parsed = JSON.parse(raw);
    markTimeline(job, 'transcribe-done', '转写完成', 'done', 'TicNote fallback');
    return Array.isArray(parsed) ? parsed : [{ text: raw }];
  } catch {
    markTimeline(job, 'transcribe-done', '转写完成', 'done', 'TicNote fallback');
    return [{ text: raw }];
  }
}

async function buildFinalMarkdown(jobDir, payload) {
  const lines = [];
  lines.push(`# ${payload.title}`);
  lines.push('');
  lines.push(`来源：${payload.sourceUrl}`);
  lines.push(`平台：${payload.platform}`);
  lines.push(`采集时间：${now()}`);
  lines.push('');
  lines.push('## 采集说明');
  lines.push('');
  for (const note of payload.notes || []) lines.push(`- ${note}`);
  const apiNote = transcriptionNote(payload.job);
  if (apiNote) lines.push(`- ${apiNote}`);
  const interaction = interactionStats(payload.metadata || {}, payload.platform, payload.comments || [], payload.danmaku || []);
  const interactionBits = [
    interaction.viewCount !== undefined ? `播放/观看 ${interaction.viewCount}` : '',
    interaction.likeCount !== undefined ? `点赞 ${interaction.likeCount}` : '',
    interaction.coinCount !== undefined ? `投币 ${interaction.coinCount}` : '',
    interaction.favoriteCount !== undefined ? `收藏 ${interaction.favoriteCount}` : '',
    interaction.shareCount !== undefined ? `转发/分享 ${interaction.shareCount}` : '',
    interaction.commentCount !== undefined ? `平台显示评论 ${interaction.commentCount}` : '',
    interaction.danmakuCount !== undefined ? `平台显示弹幕 ${interaction.danmakuCount}` : '',
  ].filter(Boolean);
  if (interactionBits.length) lines.push(`- 平台互动数据：${interactionBits.join('；')}。`);
  lines.push(`- 视频转写段落：${payload.transcript.length}。评论/讨论条目：${payload.comments.length}。弹幕条目：${(payload.danmaku || []).length}。`);
  lines.push('');
  if (payload.metadata?.desc) {
    lines.push('## 视频简介');
    lines.push('');
    lines.push(payload.metadata.desc);
    lines.push('');
  }
  lines.push('## 视频内容转写');
  lines.push('');
  if (payload.transcript.length) {
    for (const seg of payload.transcript) {
      const prefix = seg.start !== undefined ? `[${hms(seg.start)}-${hms(seg.end)}] ${seg.speaker || ''}: ` : '';
      lines.push(`${prefix}${seg.text || ''}`);
      lines.push('');
    }
  } else {
    lines.push('未生成视频内容转写。');
    lines.push('');
  }
  lines.push('## 评论/讨论转写');
  lines.push('');
  lines.push('| # | 层级 | 用户ID | 用户 | 性别 | 等级 | 粉丝牌 | 内容 |');
  lines.push('|---:|---:|---|---|---|---:|---|---|');
  payload.comments.forEach((row, index) => {
    const message = String(row.message || '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
    const user = String(row.user || '').replace(/\|/g, '\\|');
    const userId = String(row.mid || row.user || '').replace(/\|/g, '\\|');
    const fansMedal = String(row.fansMedal || '').replace(/\|/g, '\\|');
    lines.push(`| ${index + 1} | ${row.level || 0} | ${userId} | ${user} | ${row.sex || ''} | ${row.userLevel || ''} | ${fansMedal} | ${message} |`);
  });
  lines.push('');
  if (payload.danmaku?.length) {
    lines.push('## 弹幕转写');
    lines.push('');
    lines.push('| # | 时间 | 用户Hash | 内容 |');
    lines.push('|---:|---|---|---|');
    payload.danmaku.forEach((row, index) => {
      const text = String(row.text || '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
      lines.push(`| ${index + 1} | ${hms(row.time)} | ${row.userHash || ''} | ${text} |`);
    });
    lines.push('');
  }
  const finalPath = path.join(jobDir, 'final_text.md');
  await fs.writeFile(finalPath, lines.join('\n'));
  return finalPath;
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdownHtml(value) {
  return htmlEscape(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listType = '';
  let code = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdownHtml(paragraph.join(' '))}</p>`);
    paragraph = [];
  }
  function flushList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = '';
  }
  function flushCode() {
    if (!code) return;
    html.push(`<pre>${htmlEscape(code.join('\n'))}</pre>`);
    code = null;
  }
  function addListItem(value, type) {
    flushParagraph();
    if (listType && listType !== type) flushList();
    if (!listType) {
      listType = type;
      html.push(`<${type}>`);
    }
    html.push(`<li>${inlineMarkdownHtml(value)}</li>`);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (code) {
      if (/^```/.test(trimmed)) flushCode();
      else code.push(line);
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push('<hr>');
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, heading[1].length + 1);
      html.push(`<h${level}>${inlineMarkdownHtml(heading[2])}</h${level}>`);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (ordered[1].length <= 36 && !/[。；;，,：:].{2,}/.test(ordered[1])) {
        flushParagraph();
        flushList();
        html.push(`<h3>${inlineMarkdownHtml(ordered[1])}</h3>`);
      } else {
        addListItem(ordered[1], 'ol');
      }
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      addListItem(bullet[1], 'ul');
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      html.push(`<blockquote>${inlineMarkdownHtml(trimmed.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  if (code) flushCode();
  return html.join('\n');
}

function summaryHtmlDocument(job, markdown) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(job.title || 'AI 总结')}</title>
  <style>
    @page { margin: 18mm 16mm; }
    body { color: #1f242b; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.72; }
    h1 { font-size: 22px; margin: 0 0 12px; }
    h2 { font-size: 18px; margin: 18px 0 8px; }
    h3 { font-size: 15px; margin: 14px 0 6px; }
    h4 { font-size: 13px; margin: 12px 0 6px; }
    p { margin: 0 0 8px; }
    ul, ol { margin: 0 0 10px; padding-left: 20px; }
    li { margin: 3px 0; }
    strong { font-weight: 800; }
    code { border: 1px solid #dbe4ec; border-radius: 4px; background: #f6f9fb; padding: 1px 4px; font-family: Menlo, Consolas, monospace; font-size: .92em; }
    pre { white-space: pre-wrap; background: #111827; color: #e5e7eb; border-radius: 6px; padding: 10px; }
    blockquote { margin: 0 0 10px; border-left: 3px solid #dfe4ea; padding-left: 10px; color: #66717f; }
    hr { border: 0; border-top: 1px solid #dfe4ea; margin: 12px 0; }
    .meta { color: #66717f; border-bottom: 1px solid #dfe4ea; padding-bottom: 10px; margin-bottom: 14px; }
  </style>
</head>
<body>
  <h1>${htmlEscape(job.title || 'AI 总结')}</h1>
  <div class="meta">平台：${htmlEscape(job.platform || '')} · 导出时间：${clockTime()}</div>
  ${markdownToHtml(markdown)}
</body>
</html>`;
}

async function validPdfHeader(filePath) {
  return fs.readFile(filePath)
    .then((buffer) => buffer.length > 1024 && buffer.slice(0, 5).toString() === '%PDF-')
    .catch(() => false);
}

async function printHtmlToPdf(htmlPath, pdfPath, chromeProfile) {
  const child = spawn(chromeForPdf, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--run-all-compositor-stages-before-draw',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${chromeProfile}`,
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let exited = false;
  let exitCode = null;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  child.on('error', (error) => {
    exited = true;
    exitCode = -1;
    stderr += error.message;
  });
  const started = Date.now();
  while (Date.now() - started < 60000) {
    if (await validPdfHeader(pdfPath)) {
      if (!exited) child.kill('SIGTERM');
      return;
    }
    if (exited && exitCode !== 0) break;
    await sleep(500);
  }
  if (!exited) child.kill('SIGTERM');
  if (await validPdfHeader(pdfPath)) return;
  throw new Error(stderr.trim() || `Chrome headless PDF failed${exitCode === null ? '' : `: exit ${exitCode}`}`);
}

async function summaryPdfPath(job) {
  const summary = String(job.summary || '').trim() || await fs.readFile(path.join(jobsDir, job.id, 'gpt_summary.md'), 'utf8').catch(() => '');
  if (!summary.trim()) throw new Error('还没有 AI 总结可导出');
  const jobDir = path.join(jobsDir, job.id);
  const htmlPath = path.join(jobDir, 'gpt_summary_export.html');
  const pdfPath = path.join(jobDir, 'gpt_summary.pdf');
  const chromeProfile = path.join(jobDir, 'pdf_chrome_profile');
  await fs.writeFile(htmlPath, summaryHtmlDocument(job, summary));
  await fs.rm(pdfPath, { force: true }).catch(() => {});
  await fs.rm(chromeProfile, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(chromeProfile, { recursive: true });
  await printHtmlToPdf(htmlPath, pdfPath, chromeProfile);
  await fs.rm(chromeProfile, { recursive: true, force: true }).catch(() => {});
  return pdfPath;
}

async function runJob(job) {
  if (job.state === 'stopped' || job.deletedAt) return;
  job.stopRequested = false;
  job.state = 'running';
  job.startedAt = now();
  markTimeline(job, 'capture-started', '开始捕捉', 'running', `第 ${job.attempts || 1} 次`);
  await saveJobs();
  const jobDir = path.join(jobsDir, job.id);
  await fs.mkdir(jobDir, { recursive: true });
  try {
    ensureNotStopped(job);
    const finalPath = bilibiliBvid(job.url)
      ? await collectBilibili(job, jobDir)
      : isXiaohongshuUrl(job.url)
        ? await collectXiaohongshu(job, jobDir)
        : await collectGeneric(job, jobDir);
    ensureNotStopped(job);
    job.outputs = {
      final: finalPath,
      json: path.join(jobDir, 'comments_all.json'),
      tsv: path.join(jobDir, 'comments_all.tsv'),
      metadata: path.join(jobDir, 'metadata.json'),
    };
    const danmakuPath = path.join(jobDir, 'danmaku_all.json');
    if (fsSync.existsSync(danmakuPath)) {
      job.outputs.danmaku = danmakuPath;
      job.outputs.danmakuTsv = path.join(jobDir, 'danmaku_all.tsv');
    }
    job.state = job.xhsIncomplete ? 'partial' : 'done';
    job.finishedAt = now();
    markTimeline(job, 'job-finished', job.xhsIncomplete ? '部分完成' : '任务完成', job.xhsIncomplete ? 'failed' : 'done', job.xhsIncompleteReason || '');
    log(job, job.xhsIncomplete ? `部分完成：${job.xhsIncompleteReason || '小红书评论未抓全，可冷却后续跑。'}` : '任务完成');
  } catch (error) {
    if (job.stopRequested || /任务已手动停止/.test(error.message)) {
      job.state = 'stopped';
      job.error = '';
      markTimeline(job, 'job-finished', '任务停止', 'stopped', '');
      log(job, '任务已手动停止');
    } else {
      job.state = 'failed';
      job.error = error.message;
      markTimeline(job, 'job-finished', '任务失败', 'failed', error.message.slice(0, 140));
      log(job, `失败：${error.message}`);
    }
    job.finishedAt = now();
  } finally {
    job.stopRequested = false;
    activeProcesses.delete(job.id);
  }
  await saveJobs();
}

function scheduleJob(job) {
  if (isXiaohongshuUrl(job.url)) {
    xhsQueue = xhsQueue
      .catch(() => {})
      .then(() => runJob(job))
      .catch((error) => log(job, `后台异常：${error.message}`));
    return xhsQueue;
  }
  return runJob(job).catch((error) => log(job, `后台异常：${error.message}`));
}

function countBy(rows, getter) {
  const counts = {};
  for (const row of rows) {
    const key = getter(row) || '未知';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function topEntries(counts, limit = 12) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function danmakuAnalysisRows(rows) {
  const times = rows.map((row) => Number(row.time || 0)).filter((time) => Number.isFinite(time) && time >= 0);
  if (!times.length) return { duration: 0, buckets: [], spikes: [] };
  const duration = Math.max(...times, 1);
  const bucketCount = Math.max(12, Math.min(60, Math.ceil(duration / 30)));
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    start: (duration / bucketCount) * index,
    end: (duration / bucketCount) * (index + 1),
    count: 0,
    texts: [],
  }));
  for (const row of rows) {
    const time = Number(row.time || 0);
    if (!Number.isFinite(time) || time < 0) continue;
    const index = Math.min(bucketCount - 1, Math.floor((time / duration) * bucketCount));
    buckets[index].count += 1;
    if (buckets[index].texts.length < 30 && row.text) buckets[index].texts.push(String(row.text));
  }
  const spikes = [...buckets].sort((a, b) => b.count - a.count).slice(0, 8);
  return { duration, buckets, spikes };
}

function compactUserProfile(comments) {
  const roots = comments.filter((row) => Number(row.level || 0) === 0).length;
  return {
    total: comments.length,
    roots,
    replies: comments.length - roots,
    sex: topEntries(countBy(comments, (row) => row.sex || '未知')),
    userLevel: topEntries(countBy(comments, (row) => row.userLevel !== undefined && row.userLevel !== '' ? `LV${row.userLevel}` : '未知')),
    fansMedal: topEntries(countBy(comments, (row) => row.fansMedal ? '有粉丝牌' : '无/未知')),
  };
}

async function gptSummary(job, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY
    || await fs.readFile(path.join(repoRoot, 'auth/openai-api-key.txt'), 'utf8').then((s) => s.trim()).catch(() => '');
  if (!apiKey) throw new Error('未设置 OPENAI_API_KEY');
  const interactionOnly = options.interactionOnly === true;
  if (!job.outputs?.final && !interactionOnly) throw new Error('任务还没有 final_text.md');
  const text = job.outputs?.final ? await fs.readFile(job.outputs.final, 'utf8') : '';
  const comments = job.outputs?.json ? readJsonFile(job.outputs.json, []) : [];
  const danmaku = job.outputs?.danmaku ? readJsonFile(job.outputs.danmaku, []) : [];
  if (interactionOnly && !comments.length && !danmaku.length) throw new Error('还没有评论或弹幕数据可总结');
  const metadata = job.outputs?.metadata ? readJsonFile(job.outputs.metadata, {}) : {};
  const detailText = {
    detailed: '很详细：输出完整分节分析，观点、数字、例子都尽量展开。',
    medium: '中等：输出清晰但不冗长的分析，每节保留关键数字和代表例子。',
    brief: '简略：输出短版 overview 和最重要的结论。',
  }[options.detail] || '中等：输出清晰但不冗长的分析，每节保留关键数字和代表例子。';
  const includeComments = options.includeComments !== false;
  const includeDanmaku = options.includeDanmaku !== false;
  const includeProfile = options.includeProfile !== false;
  const userPrompt = String(options.prompt || '').trim() || [
    '你是中文内容分析助手。请只基于给定采集数据，不编造外部事实。',
    '输出 Markdown，必须覆盖：overview、内容总结、评论分析、弹幕分析、用户画像、定量摘要。定量摘要必须用 Markdown 表格呈现。',
    '如果某项数据缺失，请明确说明缺失。',
  ].join('\n');
  const compactComments = Array.isArray(comments)
    ? comments.slice(0, includeComments ? 520 : 80).map((row) => `L${row.level || 0} uid=${row.mid || row.user || ''} user=${row.user || ''} sex=${row.sex || ''} level=${row.userLevel || ''} like=${row.like || 0}: ${row.message || ''}`).join('\n')
    : '';
  const danmakuInfo = Array.isArray(danmaku) ? danmakuAnalysisRows(danmaku) : { duration: 0, buckets: [], spikes: [] };
  const compactDanmaku = Array.isArray(danmaku) && includeDanmaku
    ? [
      `总弹幕：${danmaku.length}；视频弹幕时间范围：${hms(0)}-${hms(danmakuInfo.duration)}。`,
      '热度峰值时间段（时间段 条数 样本文本）：',
      ...danmakuInfo.spikes.map((item) => `${hms(item.start)}-${hms(item.end)} ${item.count}条：${item.texts.slice(0, 18).join(' / ')}`),
      '',
      '弹幕样本：',
      ...danmaku.slice(0, 360).map((row) => `[${hms(row.time)}] ${row.text || ''}`),
    ].join('\n')
    : '未启用弹幕分析或无弹幕数据。';
  const profile = includeProfile ? compactUserProfile(Array.isArray(comments) ? comments : []) : {};
  const view = readJobView(job);
  const summaryModeNote = interactionOnly
    ? '本次为“只总结互动”：不要总结视频/图文主体内容，不要因为缺少转写而报错；重点只分析评论区、弹幕、互动数量、用户画像和情绪/观点分布。'
    : '本次为完整 AI 总结：如有视频/图文内容、转写、评论和弹幕，请综合分析。';
  const structuredContext = [
    '## 总结设置',
    summaryModeNote,
    `详细程度：${detailText}`,
    `是否分析评论：${includeComments ? '是' : '否'}`,
    `是否分析弹幕：${includeDanmaku ? '是' : '否'}`,
    `是否分析用户画像：${includeProfile ? '是' : '否'}`,
    '',
    '## 用户自定义 Prompt',
    userPrompt,
    '',
    '## 任务元数据',
    JSON.stringify({
      title: job.title,
      platform: job.platform,
      url: job.url,
      metadata,
      stats: {
        transcriptCount: view.stats.transcriptCount,
        commentCount: comments.length,
        mainCommentCount: Array.isArray(comments) ? comments.filter((row) => Number(row.level || 0) === 0).length : 0,
        danmakuCount: Array.isArray(danmaku) ? danmaku.length : 0,
        interaction: view.stats.interaction,
      },
      userProfile: profile,
    }, null, 2),
    '',
    '## 原始采集 Markdown',
    interactionOnly ? '本次只总结互动，已省略视频/图文主体 Markdown。' : text.slice(0, 70000),
    '',
    '## 评论数据（层级 用户ID 用户 性别 等级 点赞 内容）',
    compactComments,
    '',
    '## 弹幕热度和样本',
    compactDanmaku,
  ].join('\n');
  const clipped = structuredContext.slice(0, 130000);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content: [
            '你是中文内容研究和评论弹幕分析助手。只基于用户提供的采集数据回答，不编造未出现的信息。',
            '输出中文 Markdown。必须尽量使用数字、占比、时间段、样本评论或弹幕来支撑判断。',
            '如果输入里缺少图片、性别、账号等级、弹幕或其他字段，明确写“数据缺失/样本不足”，不要猜测。',
            '用户自定义 Prompt 的优先级高于默认结构，但不得要求你编造事实。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: clipped,
        },
      ],
      max_output_tokens: options.detail === 'brief' ? 1800 : options.detail === 'detailed' ? 5200 : 3500,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `OpenAI HTTP ${response.status}`);
  return body.output_text || (body.output || []).flatMap((item) => item.content || []).map((part) => part.text || '').join('\n').trim();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const body = await readJson(req);
      if (String(body.password || '') !== loginPassword) return json(res, 401, { ok: false, error: 'bad password' });
      const session = signSession({ exp: Date.now() + 60 * 60 * 24 * 30 * 1000 });
      return jsonWithHeaders(res, 200, { ok: true }, { 'Set-Cookie': `flyinglap_session=${encodeURIComponent(session)}; ${cookieFlags(req)}` });
    }

    if (url.pathname !== '/health' && !authorized(req, url)) {
      if (req.method === 'GET' && url.pathname === '/') return authHtml(res);
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return staticFile(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/app.css') return staticFile(res, path.join(publicDir, 'app.css'), 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return staticFile(res, path.join(publicDir, 'app.js'), 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const relative = path.normalize(url.pathname.replace(/^\/+/, ''));
      const filePath = path.join(publicDir, relative);
      const assetsRoot = path.join(publicDir, 'assets') + path.sep;
      if (!filePath.startsWith(assetsRoot)) return json(res, 404, { ok: false, error: 'not found' });
      const ext = path.extname(filePath).toLowerCase();
      const type = ext === '.svg' ? 'image/svg+xml; charset=utf-8'
        : ext === '.png' ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.webp' ? 'image/webp'
              : 'application/octet-stream';
      return staticFile(res, filePath, type, { 'Cache-Control': 'public, max-age=86400' });
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, jobs: jobs.length, auth: Boolean(accessToken) });

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      return json(res, 200, { ok: true, jobs: visibleJobs().map((job) => ({ ...job, preview: undefined })) });
    }

    if (req.method === 'GET' && url.pathname === '/api/emote-dictionary') {
      return json(res, 200, { ok: true, emotes: collectKnownEmoteDictionary() });
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readJson(req);
      const rawInput = String(body.url || '').trim();
      const transcribeVideo = body.transcribeVideo !== false;
      let inputUrl = '';
      try {
        inputUrl = await resolveInputUrl(rawInput);
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message });
      }
      if (!/^https?:\/\//i.test(inputUrl)) return json(res, 400, { ok: false, error: '请输入包含 http/https 的视频或图文链接' });
      const key = contentKey(inputUrl);
      const existing = jobs.find((item) => item.contentKey === key || contentKey(item.url) === key);
      if (existing) {
        existing.contentKey = key;
        existing.input = rawInput;
        existing.url = inputUrl;
        existing.transcribeVideo = transcribeVideo;
        existing.updatedAt = now();
        if (existing.state === 'queued' || existing.state === 'running') {
          log(existing, '检测到重复提交：已切回当前任务，不新建任务。');
          await saveJobs();
          return json(res, 200, { ok: true, reused: true, running: true, job: publicJob(existing) });
        }
        const cooldown = isXiaohongshuUrl(inputUrl) ? cooldownMs(existing.xhsCooldownUntil) : 0;
        if (cooldown > 0) {
          log(existing, `小红书风控冷却中，约 ${Math.ceil(cooldown / 60000)} 分钟后再续跑。`);
          await saveJobs();
          return json(res, 200, { ok: true, reused: true, cooldown: true, cooldownMs: cooldown, job: publicJob(existing) });
        }
        existing.state = 'queued';
        existing.error = '';
        existing.summary = '';
        existing.summaryAt = '';
        existing.summaryOptions = undefined;
        existing.attempts = Number(existing.attempts || 0) + 1;
        markTimeline(existing, `rerun-${existing.attempts}`, '重新捕捉', 'running', `第 ${existing.attempts} 次`);
        existing.log = [
          ...(existing.log || []),
          `[${clockTime()}] 检测到重复提交：复用当前任务，开始第 ${existing.attempts} 次慢速重抓。`,
        ].slice(-300);
        await saveJobs();
        scheduleJob(existing);
        return json(res, 200, { ok: true, reused: true, rerun: true, job: publicJob(existing) });
      }
      const job = {
        id: crypto.randomUUID(),
        contentKey: key,
        input: rawInput,
        url: inputUrl,
        title: '',
        platform: '',
        state: 'queued',
        transcribeVideo,
        createdAt: now(),
        updatedAt: now(),
        attempts: 1,
        log: rawInput === inputUrl ? ['任务已创建'] : [`任务已创建，识别链接：${inputUrl}`],
        timeline: [{ type: 'created', label: '任务创建', status: 'done', at: now(), detail: rawInput === inputUrl ? '' : '已自动识别分享链接' }],
        outputs: {},
      };
      jobs.push(job);
      await saveJobs();
      scheduleJob(job);
      return json(res, 201, { ok: true, job: publicJob(job) });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/);
    if (jobMatch) {
      const job = jobs.find((item) => item.id === jobMatch[1]);
      if (!job) return json(res, 404, { ok: false, error: 'job not found' });
      const action = jobMatch[2] || '';
      if (req.method === 'GET' && !action) return json(res, 200, { ok: true, job: publicJob(job) });
      if (req.method === 'POST' && action === 'stop') {
        if (isTerminalState(job.state)) return json(res, 200, { ok: true, job: publicJob(job) });
        job.stopRequested = true;
        job.state = 'stopped';
        job.finishedAt = now();
        job.updatedAt = now();
        const killed = stopJobProcesses(job);
        markTimeline(job, 'job-finished', '任务停止', 'stopped', killed ? `终止 ${killed} 个后台进程` : '停止排队');
        log(job, killed ? `已请求停止采集，正在终止 ${killed} 个后台进程。` : '已停止排队中的任务。');
        const progressFile = path.join(jobsDir, job.id, 'xhs_progress.json');
        const progress = readJsonFile(progressFile, {});
        await fs.writeFile(progressFile, JSON.stringify({
          ...progress,
          ok: false,
          stopped: true,
          final: true,
          stage: 'stopped',
          updatedAt: now(),
        }, null, 2)).catch(() => {});
        await saveJobs();
        return json(res, 200, { ok: true, stopped: true, killed, job: publicJob(job) });
      }
      if (req.method === 'DELETE' && !action) {
        job.stopRequested = true;
        const killed = stopJobProcesses(job);
        jobs = jobs.filter((item) => item.id !== job.id);
        await saveJobs();
        await fs.rm(path.join(jobsDir, job.id), { recursive: true, force: true }).catch(() => {});
        return json(res, 200, { ok: true, deleted: true, killed });
      }
      if (req.method === 'GET' && action === 'file') {
        const name = url.searchParams.get('name') || 'final';
        const file = name === 'final' ? job.outputs?.final
          : name === 'json' ? job.outputs?.json
            : name === 'tsv' ? job.outputs?.tsv
              : name === 'danmaku' ? job.outputs?.danmaku
                : name === 'danmaku-tsv' ? job.outputs?.danmakuTsv
                  : '';
        if (!file) return json(res, 404, { ok: false, error: 'file not found' });
        const headers = url.searchParams.get('download') === '1'
          ? { 'Content-Disposition': contentDispositionFilename(name === 'final' ? markdownDownloadName(job) : path.basename(file)) }
          : {};
        return staticFile(res, file, name === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', headers);
      }
      if (req.method === 'GET' && action === 'content-image') {
        const metadata = job.outputs?.metadata ? readJsonFile(job.outputs.metadata, {}) : {};
        const images = contentImageUrls(job, metadata);
        const index = Math.max(0, Number(url.searchParams.get('index') || 0));
        const imageUrl = images[index];
        if (!imageUrl) return json(res, 404, { ok: false, error: 'image not found' });
        const response = await fetch(imageUrl, {
          headers: {
            'User-Agent': UA,
            Referer: isXiaohongshuUrl(job.url || '')
              ? (job.url || 'https://www.xiaohongshu.com/')
              : bilibiliBvid(job.url || '')
                ? `https://www.bilibili.com/video/${bilibiliBvid(job.url || '')}/`
                : (job.url || 'https://www.bilibili.com/'),
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          },
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          return json(res, response.status, { ok: false, error: `image fetch failed: ${response.status} ${text.slice(0, 120)}` });
        }
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': response.headers.get('content-type') || 'image/webp',
          'Content-Length': body.length,
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && action === 'summary-pdf') {
        const file = await summaryPdfPath(job);
        return staticFile(res, file, 'application/pdf', {
          'Content-Disposition': contentDispositionFilename(`${cleanFilePart(job.platform || 'capture')}_${cleanFilePart(job.title || job.id || 'ai-summary')}_AI总结.pdf`),
        });
      }
      if (req.method === 'POST' && action === 'gpt-summary') {
        const options = await readJson(req).catch(() => ({}));
        markTimeline(job, 'summary-start', options.interactionOnly ? '开始互动总结' : '开始 AI 总结', 'running', openaiModel);
        try {
          const summary = await gptSummary(job, options);
          job.summary = summary;
          job.summaryAt = now();
          job.summaryOptions = {
            detail: options.detail || 'medium',
            includeComments: options.includeComments !== false,
            includeDanmaku: options.includeDanmaku !== false,
            includeProfile: options.includeProfile !== false,
            interactionOnly: options.interactionOnly === true,
            prompt: String(options.prompt || '').slice(0, 12000),
          };
          await fs.writeFile(path.join(jobsDir, job.id, 'gpt_summary.md'), summary);
          markTimeline(job, 'summary-done', options.interactionOnly ? '互动总结完成' : 'AI 总结完成', 'done', openaiModel);
          await saveJobs();
          return json(res, 200, { ok: true, summary });
        } catch (error) {
          markTimeline(job, 'summary-failed', options.interactionOnly ? '互动总结失败' : 'AI 总结失败', 'failed', error.message.slice(0, 140));
          await saveJobs();
          throw error;
        }
      }
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', message: 'flyinglap_danmu_started', port }));
});
