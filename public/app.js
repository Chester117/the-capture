const form = document.querySelector('#capture-form');
const urlInput = document.querySelector('#url-input');
const pasteButton = document.querySelector('#paste-button');
const transcribeToggle = document.querySelector('#transcribe-toggle');
const platformFilter = document.querySelector('#platform-filter');
const jobList = document.querySelector('#job-list');
const emptyState = document.querySelector('#empty-state');
const jobDetail = document.querySelector('#job-detail');
const jobTitle = document.querySelector('#job-title');
const jobUrl = document.querySelector('#job-url');
const copyContentLinkButton = document.querySelector('#copy-content-link');
const progressLog = document.querySelector('#progress-log');
const jobTimeline = document.querySelector('#job-timeline');
const captureProgress = document.querySelector('#capture-progress');
const preview = document.querySelector('#preview');
const resultView = document.querySelector('#result-view');
const contentPreview = document.querySelector('#content-preview');
const stats = document.querySelector('#stats');
const transcriptList = document.querySelector('#transcript-list');
const commentList = document.querySelector('#comment-list');
const danmakuTimeline = document.querySelector('#danmaku-timeline');
const danmakuList = document.querySelector('#danmaku-list');
const contentLink = document.querySelector('#content-link');
const finalLink = document.querySelector('#final-link');
const downloadLink = document.querySelector('#download-link');
const danmakuLink = document.querySelector('#danmaku-link');
const gptButton = document.querySelector('#gpt-button');
const gptInteractionButton = document.querySelector('#gpt-interaction-button');
const gptSettingsButton = document.querySelector('#gpt-settings-button');
const stopButton = document.querySelector('#stop-button');
const deleteButton = document.querySelector('#delete-button');
const gptModal = document.querySelector('#gpt-modal');
const gptModalClose = document.querySelector('#gpt-modal-close');
const summaryPresetButtons = document.querySelectorAll('.summary-preset');
const summaryPresetPanels = document.querySelectorAll('.summary-preset-panel');
const gptDetail = document.querySelector('#gpt-detail');
const gptIncludeComments = document.querySelector('#gpt-include-comments');
const gptIncludeDanmaku = document.querySelector('#gpt-include-danmaku');
const gptIncludeProfile = document.querySelector('#gpt-include-profile');
const gptPrompt = document.querySelector('#gpt-prompt');
const gptResetPrompt = document.querySelector('#gpt-reset-prompt');
const gptSaveSettings = document.querySelector('#gpt-save-settings');
const summaryBox = document.querySelector('#summary-box');
const summaryText = document.querySelector('#summary-text');
const summaryEmpty = document.querySelector('#summary-empty');
const summaryEmptyGpt = document.querySelector('#summary-empty-gpt');
const summaryEmptyInteraction = document.querySelector('#summary-empty-interaction');
const copySummaryMd = document.querySelector('#copy-summary-md');
const copySummaryText = document.querySelector('#copy-summary-text');
const exportSummaryPdf = document.querySelector('#export-summary-pdf');
const commentSortButtons = document.querySelectorAll('.comment-sort');
const imageLightbox = document.querySelector('#image-lightbox');
const imageLightboxImg = document.querySelector('#image-lightbox-img');
const imageLightboxClose = document.querySelector('#image-lightbox-close');

let jobs = [];
let selectedId = '';
let activeTab = 'comments';
let platformFilterValue = 'all';
let commentSort = localStorage.getItem('flyinglap_comment_sort') || 'page';
let commentSortLoading = '';
const summaryDrafts = new Map();
const progressDisplay = new Map();
const collapsedComments = new Map();
let selectedJobSnapshot = null;
let currentSummaryMarkdown = '';
let knownEmotes = new Map();
const DEFAULT_GPT_PROMPT = [
  '你是中文内容分析助手。请只基于给定采集数据，不编造外部事实。',
  '输出 Markdown，必须覆盖以下内容：',
  '1. Overview：用 3-6 句话概括这条视频/帖子最重要的信息、立场和结论。',
  '2. 内容总结：如果是视频，总结视频讲了什么；如果是小红书/图文，概括 post 正文和可见图片/素材信息。',
  '3. 评论分析：给出评论区主要观点、分歧、情绪倾向、典型高赞/高信息密度评论，并尽量估算占比。',
  '4. 弹幕分析：如果有弹幕，说明整体热度、时间轴变化、主要 spike 发生在什么时间段，以及 spike 里大家主要在说什么。',
  '5. 用户画像：如数据可用，分析账号新旧/等级、男女比例、粉丝牌或其他用户字段；没有数据就明确说明缺失，不要猜。',
  '6. 定量摘要：用 Markdown 表格列出视频转写段落数、评论数、主评论数、弹幕数、弹幕峰值时间段等关键数字。',
  '写得具体、可读，避免空泛套话。',
].join('\n');
const ARTICLE_GPT_PROMPT = [
  '你是中文网页文章摘要助手。请只基于网页正文总结，不编造外部事实。',
  '只总结文章文字内容，不要加入视频转写、评论分析、弹幕分析、用户画像或互动数据。',
  '输出 Markdown，结构清晰：先给 overview，再列关键要点，最后补充重要细节或数字。',
].join('\n');
const storedGptPrompt = localStorage.getItem('flyinglap_gpt_prompt') || '';
const initialGptPrompt = storedGptPrompt.includes('可行动结论') ? DEFAULT_GPT_PROMPT : (storedGptPrompt || DEFAULT_GPT_PROMPT);
if (storedGptPrompt && storedGptPrompt !== initialGptPrompt) localStorage.setItem('flyinglap_gpt_prompt', initialGptPrompt);
const gptSettings = {
  preset: 'video',
  detail: localStorage.getItem('flyinglap_gpt_detail') || 'medium',
  includeComments: localStorage.getItem('flyinglap_gpt_comments') !== '0',
  includeDanmaku: localStorage.getItem('flyinglap_gpt_danmaku') !== '0',
  includeProfile: localStorage.getItem('flyinglap_gpt_profile') !== '0',
  prompt: initialGptPrompt,
};
let gptPresetJobId = '';

async function api(path, options) {
  const headers = { ...(options?.headers || {}) };
  const res = await fetch(path, { ...(options || {}), headers });
  if (res.status === 401) {
    location.href = '/';
    throw new Error('unauthorized');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function stateLabel(state) {
  return {
    queued: '排队中',
    running: '采集中',
    partial: '部分完成',
    done: '完成',
    failed: '失败',
    stopped: '已停止',
  }[state] || state;
}

function hms(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function duration(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

function shortDuration(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec}秒`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}时${m}分`;
  return s ? `${m}分${s}秒` : `${m}分`;
}

function numberLabel(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function smoothCaptureDisplay(jobId, targets, isComplete) {
  const key = String(jobId || 'current');
  const previous = progressDisplay.get(key);
  if (!previous || isComplete) {
    progressDisplay.set(key, targets);
    return targets;
  }

  const next = {};
  for (const [name, target] of Object.entries(targets)) {
    const oldValue = Number(previous[name] ?? target);
    const nextTarget = Number(target || 0);
    if (nextTarget < oldValue) {
      next[name] = nextTarget;
      continue;
    }
    const delta = nextTarget - oldValue;
    const maxStep = name.endsWith('Pct') ? 8 : Math.max(6, Math.ceil(Math.abs(nextTarget) * 0.16));
    next[name] = Math.abs(delta) <= maxStep ? nextTarget : oldValue + Math.sign(delta) * maxStep;
  }
  progressDisplay.set(key, next);
  return next;
}

function animatedCaptureTargets(job, rawTargets) {
  const progress = job?.captureProgress;
  const running = job?.state === 'running' && progress && !progress.final && progress.stage !== 'done';
  if (!running) return rawTargets;
  const staleMs = progress.updatedAt ? Math.max(0, Date.now() - new Date(progress.updatedAt).getTime()) : 0;
  const seconds = Math.min(8, staleMs / 1000);
  const next = { ...rawTargets };
  next.scrollPct = Math.min(99, Number(next.scrollPct || 0) + seconds * 0.42);
  const scrollHeight = Number(progress.visualStats?.lastScrollHeight || 0);
  const clientHeight = Number(progress.visualStats?.clientHeight || 459);
  const maxScroll = Math.max(1, scrollHeight - clientHeight);
  next.scrollTop = Math.min(maxScroll, Number(next.scrollTop || 0) + (maxScroll * seconds * 0.0042));
  const total = Number(progress.pageCommentCount || job?.xhsCompletion?.total || job?.metadata?.commentCount || job?.view?.stats?.sourceCommentCount || 0);
  if (total && Number(next.captured || 0) < total) {
    next.captured = Math.min(total, Number(next.captured || 0) + seconds * 0.75);
    next.commentPct = Math.min(99, (next.captured / total) * 100);
  }
  return next;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function emoteTokenLabel(token) {
  return String(token || '').replace(/^\[/, '').replace(/\]$/, '').trim();
}

function localEmoteSymbol(token) {
  const label = emoteTokenLabel(token);
  const direct = {
    '笑哭R': '😂',
    '笑哭了R': '😂',
    '捂脸R': '🤦',
    '偷笑R': '🤭',
    '呃R': '😅',
    '萌萌哒R': '🥰',
    '失望R': '😞',
    '哭惹R': '😢',
    '皱眉R': '😟',
    '汗颜R': '😅',
    '微笑R': '🙂',
    '赞R': '👍',
    '点赞R': '👍',
    '暗中观察R': '👀',
    '飞吻R': '😘',
    '扶额R': '🤦',
    '哇R': '😮',
    '坏笑R': '😏',
    '害羞R': '😊',
    '黄金薯R': '🥔',
    '派对R': '🥳',
    '生气R': '😠',
    '石化R': '🗿',
    doge: '🐶',
    藏狐: '🦊',
    笑哭: '😂',
    喜极而泣: '😂',
    吃瓜: '🍉',
    大哭: '😭',
    墨镜: '😎',
    微笑: '🙂',
    生气: '😠',
    思考: '🤔',
    疑惑: '❓',
    爱心: '❤',
    星星眼: '🤩',
    OK: '👌',
    妙啊: '✨',
  };
  return direct[label] || (label.endsWith('R') ? '📕' : '🙂');
}

function localEmoteDataUrl(token) {
  const label = emoteTokenLabel(token);
  const symbol = localEmoteSymbol(token);
  const shortLabel = label.length > 4 ? `${label.slice(0, 4)}` : label;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" rx="18" fill="#fff7ed"/>
      <rect x="2" y="2" width="68" height="68" rx="16" fill="none" stroke="#fed7aa" stroke-width="3"/>
      <text x="36" y="35" text-anchor="middle" dominant-baseline="middle" font-size="30">${symbol}</text>
      <text x="36" y="58" text-anchor="middle" font-size="11" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fill="#9a3412">${shortLabel}</text>
    </svg>
  `.trim();
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function appendEmoteImage(node, token, url, source = '') {
  const img = document.createElement('img');
  img.className = url ? 'comment-emote' : 'comment-emote comment-emote-local';
  img.src = url || localEmoteDataUrl(token);
  img.alt = token;
  img.title = source === 'local' ? `${token}（本地兜底渲染）` : token;
  img.loading = 'lazy';
  img.referrerPolicy = 'no-referrer';
  node.appendChild(img);
}

async function loadEmoteDictionary() {
  try {
    const body = await api('/api/emote-dictionary');
    knownEmotes = new Map((body.emotes || []).map((item) => [item.token, item]));
  } catch {
    knownEmotes = new Map();
  }
}

function appendInlineMarkdown(parent, value) {
  const text = String(value || '');
  const pattern = /(\*\*\s*([^*]+?)\s*\*\*|__\s*([^_]+?)\s*__|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > index) parent.appendChild(document.createTextNode(text.slice(index, match.index)));
    const node = document.createElement(match[2] || match[3] ? 'strong' : match[4] ? 'code' : 'a');
    node.textContent = match[2] || match[3] || match[4] || match[5] || '';
    if (node.tagName === 'A') {
      node.href = match[6] || '#';
      node.target = '_blank';
      node.rel = 'noreferrer';
    }
    parent.appendChild(node);
    index = match.index + match[0].length;
  }
  if (index < text.length) parent.appendChild(document.createTextNode(text.slice(index)));
}

function renderMarkdown(node, markdown) {
  clear(node);
  const text = String(markdown || '');
  if (!text.trim()) return;
  const lines = text.split(/\r?\n/);
  let paragraph = [];
  let list = null;
  let code = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '));
    node.appendChild(p);
    paragraph = [];
  }

  function flushList() {
    if (list) {
      node.appendChild(list);
      list = null;
    }
  }

  function addListItem(value, ordered) {
    flushParagraph();
    if (!list || (ordered && list.tagName !== 'OL') || (!ordered && list.tagName !== 'UL')) {
      flushList();
      list = document.createElement(ordered ? 'ol' : 'ul');
    }
    const li = document.createElement('li');
    appendInlineMarkdown(li, value);
    list.appendChild(li);
  }

  function isTableRow(value) {
    return /^\s*\|.+\|\s*$/.test(value || '');
  }

  function isTableSeparator(value) {
    const cells = String(value || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function tableCells(value) {
    return String(value || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function appendTable(startIndex) {
    const headers = tableCells(lines[startIndex]);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const header of headers) {
      const th = document.createElement('th');
      appendInlineMarkdown(th, header);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let index = startIndex + 2;
    while (index < lines.length && isTableRow(lines[index])) {
      const tr = document.createElement('tr');
      const cells = tableCells(lines[index]);
      for (let cellIndex = 0; cellIndex < headers.length; cellIndex += 1) {
        const td = document.createElement('td');
        appendInlineMarkdown(td, cells[cellIndex] || '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
      index += 1;
    }
    table.appendChild(tbody);
    node.appendChild(table);
    return index - 1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (code) {
      if (/^```/.test(trimmed)) {
        node.appendChild(code);
        code = null;
      } else {
        code.textContent += `${line}\n`;
      }
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushParagraph();
      flushList();
      code = document.createElement('pre');
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
      node.appendChild(document.createElement('hr'));
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s*(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const h = document.createElement(`h${Math.min(4, heading[1].length + 1)}`);
      appendInlineMarkdown(h, heading[2]);
      node.appendChild(h);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      flushList();
      i = appendTable(i);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      if (ordered[1].length <= 36 && !/[。；;，,：:].{2,}/.test(ordered[1])) {
        flushParagraph();
        flushList();
        const h = document.createElement('h3');
        appendInlineMarkdown(h, ordered[1]);
        node.appendChild(h);
        continue;
      }
      addListItem(ordered[1], true);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      addListItem(bullet[1], false);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      const quote = document.createElement('blockquote');
      appendInlineMarkdown(quote, trimmed.replace(/^>\s?/, ''));
      node.appendChild(quote);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  if (code) node.appendChild(code);
}

function cleanFilePart(value, fallback = 'capture') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;
}

function markdownFileName(job) {
  return `${cleanFilePart(job.platform || 'video')}_${cleanFilePart(job.title || job.url || job.id)}.md`;
}

function contentPageUrl(job) {
  const raw = String(job?.url || '');
  const url = raw.match(/https?:\/\/[^\s"'<>，。；、]+/i)?.[0]?.replace(/[)）\]]+$/g, '') || raw;
  if (!url) return '#';
  const bvid = url.match(/BV[0-9A-Za-z]+/)?.[0];
  if (bvid) return `https://www.bilibili.com/video/${bvid}/`;
  try {
    const parsed = new URL(url);
    if (/xiaohongshu\.com|xhslink\.com|xhsurl\.com/i.test(parsed.hostname)) return parsed.toString();
    return parsed.toString();
  } catch {
    return url;
  }
}

function platformKey(platform = '') {
  const value = String(platform || '').toLowerCase();
  if (value.includes('xiaohongshu') || value.includes('rednote')) return 'xiaohongshu';
  if (value.includes('xiaoyuzhou') || value.includes('cosmos')) return 'xiaoyuzhou';
  if (value.includes('youtube') || value === 'yt') return 'youtube';
  if (value.includes('weibo') || value.includes('微博')) return 'weibo';
  if (value.includes('bilibili') || value.includes('b站')) return 'bilibili';
  return value || 'generic';
}

function platformLogo(platform = '') {
  const version = 'v=20260607-real-logo1';
  const logos = {
    bilibili: `/assets/platforms/bilibili.png?${version}`,
    xiaohongshu: `/assets/platforms/xiaohongshu.png?${version}`,
    xiaoyuzhou: `/assets/platforms/xiaoyuzhou.png?${version}`,
    youtube: `/assets/platforms/youtube.png?${version}`,
    weibo: `/assets/platforms/weibo.svg?${version}`,
    article: `/assets/platforms/article.svg?${version}`,
  };
  return logos[platformKey(platform)] || '';
}

function platformLogoForJob(job) {
  const fromPlatform = platformLogo(job?.platform || '');
  if (fromPlatform) return fromPlatform;
  const url = String(job?.url || '');
  if (/youtube\.com|youtu\.be/i.test(url)) return platformLogo('youtube');
  if (/bilibili\.com|b23\.tv/i.test(url)) return platformLogo('bilibili');
  if (/xiaohongshu\.com|xhslink\.com|xhsurl\.com/i.test(url)) return platformLogo('xiaohongshu');
  if (/xiaoyuzhoufm\.com|podcaster\.xiaoyuzhoufm\.com/i.test(url)) return platformLogo('xiaoyuzhou');
  if (/weibo\.com|weibo\.cn|t\.cn/i.test(url)) return platformLogo('weibo');
  return '';
}

function platformKeyForJob(job) {
  const fromPlatform = platformKey(job?.platform || '');
  if (['bilibili', 'xiaohongshu', 'xiaoyuzhou', 'youtube', 'weibo', 'article'].includes(fromPlatform)) return fromPlatform;
  const url = String(job?.url || '');
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/bilibili\.com|b23\.tv/i.test(url)) return 'bilibili';
  if (/xiaohongshu\.com|xhslink\.com|xhsurl\.com/i.test(url)) return 'xiaohongshu';
  if (/xiaoyuzhoufm\.com|podcaster\.xiaoyuzhoufm\.com/i.test(url)) return 'xiaoyuzhou';
  if (/weibo\.com|weibo\.cn|t\.cn/i.test(url)) return 'weibo';
  return fromPlatform;
}

function isArticleJob(job) {
  return platformKeyForJob(job) === 'article'
    || job?.metadata?.platform === 'article'
    || job?.view?.content?.platform === 'article';
}

async function copyText(value, button, doneText = '已复制') {
  const original = button?.textContent || '';
  const text = String(value || '');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopyText(text);
    }
  } else {
    fallbackCopyText(text);
  }
  if (button) {
    button.textContent = doneText;
    setTimeout(() => { button.textContent = original; }, 1200);
  }
}

function fallbackCopyText(value) {
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.top = '0';
  document.body.appendChild(input);
  input.select();
  input.setSelectionRange(0, input.value.length);
  const ok = document.execCommand('copy');
  input.remove();
  if (!ok) throw new Error('copy failed');
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|\n?```$/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stringBytes(value) {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeImagePdf(jpegBytes, imageWidthPx, imageHeightPx) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 36;
  const imageWidth = pageWidth - margin * 2;
  const imageHeight = imageHeightPx / imageWidthPx * imageWidth;
  const usableHeight = pageHeight - margin * 2;
  const pageCount = Math.max(1, Math.ceil(imageHeight / usableHeight));
  const imageId = 3;
  const pageStartId = 4;
  const contentStartId = pageStartId + pageCount;
  const objects = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${pageStartId + i} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  objects[imageId] = {
    header: `<< /Type /XObject /Subtype /Image /Width ${imageWidthPx} /Height ${imageHeightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>`,
    stream: jpegBytes,
  };
  for (let i = 0; i < pageCount; i += 1) {
    const pageId = pageStartId + i;
    const contentId = contentStartId + i;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    const y = pageHeight - margin - imageHeight + i * usableHeight;
    const stream = `q\n${imageWidth.toFixed(2)} 0 0 ${imageHeight.toFixed(2)} ${margin.toFixed(2)} ${y.toFixed(2)} cm\n/Im1 Do\nQ\n`;
    objects[contentId] = {
      header: `<< /Length ${stringBytes(stream).length} >>`,
      stream: stringBytes(stream),
    };
  }
  const maxId = contentStartId + pageCount - 1;
  const parts = [stringBytes('%PDF-1.4\n')];
  const offsets = [0];
  for (let id = 1; id <= maxId; id += 1) {
    offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
    const obj = objects[id];
    parts.push(stringBytes(`${id} 0 obj\n`));
    if (typeof obj === 'string') {
      parts.push(stringBytes(`${obj}\nendobj\n`));
    } else {
      parts.push(stringBytes(`${obj.header}\nstream\n`), obj.stream, stringBytes('\nendstream\nendobj\n'));
    }
  }
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  const xref = [
    'xref',
    `0 ${maxId + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${maxId + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');
  parts.push(stringBytes(xref));
  return concatBytes(parts);
}

async function exportSummaryPdfFile() {
  if (!currentSummaryMarkdown.trim()) throw new Error('还没有 AI 总结');
  if (!selectedId) throw new Error('没有选中任务');
  const response = await fetch(`/api/jobs/${selectedId}/summary-pdf`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `PDF HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const job = selectedJobSnapshot || {};
  link.href = url;
  link.download = `${cleanFilePart(job.platform || 'capture')}_${cleanFilePart(job.title || job.id || 'ai-summary')}_AI总结.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function captureStageText(job) {
  const progress = job?.captureProgress;
  if (!progress) return '';
  const visual = progress.visualStats || {};
  if (progress.stage === 'stopped') return '当前：采集已手动停止';
  if (progress.stage === 'done') return '当前：采集已结束';
  if (progress.stage === 'login-required') return '当前：小红书登录态失效';
  if (progress.stage === 'api-main-pages') return `当前：慢速补主评论页${progress.apiStats?.page ? `，第 ${progress.apiStats.page} 页` : ''}`;
  if (progress.stage === 'api-sub-pages') return `当前：慢速补子评论${progress.apiStats?.rootIndex ? `，${progress.apiStats.rootIndex}/${progress.apiStats.roots || '?'}` : ''}`;
  if (progress.stage === 'visual-scroll') {
    const scrollTop = Number(visual.lastScrollTop || 0);
    const scrollHeight = Number(visual.lastScrollHeight || 0);
    const clientHeight = Number(visual.clientHeight || 459);
    const maxScroll = Math.max(1, scrollHeight - clientHeight);
    const pct = Math.round(Math.max(0, Math.min(1, scrollTop / maxScroll)) * 100);
    return `当前：页面滚动采集评论，滚动 ${pct}% ，已捕捉 ${numberLabel(progress.comments || 0)} 条`;
  }
  return '';
}

function renderStats(view) {
  clear(stats);
  const interaction = view?.stats?.interaction || {};
  const isArticle = view?.content?.platform === 'article';
  const valueOrDash = (value) => value === undefined || value === null || value === '' ? '--' : numberLabel(value);
  const items = [
    [isArticle ? '正文段落' : '转写段落', view?.stats?.transcriptCount || 0],
    ['评论条目', view?.stats?.commentCount || 0],
    ['主评论', view?.stats?.mainCommentCount || 0],
    ['弹幕条目', view?.stats?.danmakuCount || 0],
    ['平台显示评论', interaction.commentCount ?? view?.stats?.sourceCommentCount ?? ''],
    ['点赞', interaction.likeCount],
    ['收藏', interaction.favoriteCount],
    ['转发/分享', interaction.shareCount],
    ['播放/观看', interaction.viewCount],
    ['投币', interaction.coinCount],
  ];
  for (const [label, value] of items) {
    if (value === undefined || value === null || value === '') continue;
    const item = document.createElement('div');
    item.className = 'stat';
    const strong = document.createElement('strong');
    strong.textContent = valueOrDash(value);
    const span = document.createElement('span');
    span.textContent = label;
    item.append(strong, span);
    stats.appendChild(item);
  }
}

function renderContentPreview(content) {
  clear(contentPreview);
  const text = String(content?.text || '').trim();
  const images = Array.isArray(content?.images) ? content.images.filter(Boolean) : [];
  const title = String(content?.title || '').trim();
  const hasContent = Boolean(text || images.length);
  contentPreview.classList.toggle('hidden', !hasContent);
  if (!hasContent) return;

  const head = document.createElement('div');
  head.className = 'content-preview-head';
  const heading = document.createElement('h3');
  heading.textContent = content?.platform === 'article' ? '网页正文' : '原帖内容';
  const meta = document.createElement('span');
  meta.textContent = content?.platform === 'article'
    ? `${numberLabel(text.split(/\n{2,}/).filter(Boolean).length || 1)} 段正文${images.length ? ` · ${numberLabel(images.length)} 张图片` : ''}`
    : images.length ? `${numberLabel(images.length)} 张图片` : '正文';
  head.append(heading, meta);
  contentPreview.appendChild(head);

  if (title) {
    const titleNode = document.createElement('strong');
    titleNode.className = 'content-preview-title';
    titleNode.textContent = title;
    contentPreview.appendChild(titleNode);
  }

  if (text) {
    const body = document.createElement('p');
    body.className = 'content-preview-text';
    body.textContent = text;
    contentPreview.appendChild(body);
  }

  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'content-image-grid';
    images.forEach((url, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'content-image-button';
      button.title = `放大第 ${index + 1} 张原图`;
      const img = document.createElement('img');
      img.src = url;
      img.alt = `${title || '原帖图片'} ${index + 1}`;
      img.loading = 'lazy';
      button.appendChild(img);
      button.addEventListener('click', () => openImageLightbox(url, img.alt));
      grid.appendChild(button);
    });
    contentPreview.appendChild(grid);
  }
}

function openImageLightbox(src, alt = '原帖图片放大预览') {
  imageLightboxImg.src = src;
  imageLightboxImg.alt = alt;
  imageLightbox.classList.remove('hidden');
  document.body.classList.add('lightbox-open');
}

function closeImageLightbox() {
  imageLightbox.classList.add('hidden');
  imageLightboxImg.removeAttribute('src');
  document.body.classList.remove('lightbox-open');
}

function timelineTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function normalizeClockText(value) {
  return String(value || '').replace(/\[(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\]/gi, (_, hh, mm, ss, ap) => {
    let hour = Number(hh);
    const upper = ap.toUpperCase();
    if (upper === 'PM' && hour !== 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
    return `[${String(hour).padStart(2, '0')}:${mm}:${ss}]`;
  });
}

function renderJobTimeline(job) {
  clear(jobTimeline);
  const events = (job?.timeline || []).filter((event) => event?.label || event?.type);
  jobTimeline.classList.toggle('hidden', !events.length);
  if (!events.length) return;
  const title = document.createElement('div');
  title.className = 'job-timeline-title';
  title.textContent = '任务时间轴';
  const list = document.createElement('div');
  list.className = 'job-timeline-list';
  const count = events.length;
  const availableWidth = Math.max(0, jobTimeline.clientWidth - 28);
  const itemWidth = Math.max(156, Math.floor(availableWidth / Math.max(1, count)));
  list.style.setProperty('--timeline-count', String(Math.max(1, count)));
  list.style.setProperty('--timeline-item-width', `${itemWidth}px`);
  list.style.gridTemplateColumns = `repeat(${Math.max(1, count)}, ${itemWidth}px)`;
  let activeIndex = -1;
  events.forEach((event, index) => {
    if (event.status === 'running' && !/^开始/.test(event.label || '')) activeIndex = index;
  });
  for (const [index, event] of events.entries()) {
    if (index < events.length - 1) {
      const nextStatus = events[index + 1]?.status || '';
      const segment = document.createElement('span');
      segment.className = `job-timeline-segment ${['done', 'running'].includes(nextStatus) ? 'done' : ['failed', 'stopped'].includes(nextStatus) ? 'failed' : ''}`;
      segment.style.left = `${itemWidth / 2 + index * itemWidth}px`;
      segment.style.width = `${itemWidth}px`;
      list.appendChild(segment);
    }
    const item = document.createElement('div');
    item.className = `job-timeline-item ${event.status || 'pending'}${index === activeIndex ? ' is-active' : ''}`;
    const dot = document.createElement('span');
    dot.className = 'job-timeline-dot';
    if (index < events.length - 1) {
      const started = new Date(event.at || '').getTime();
      const ended = new Date(events[index + 1].at || '').getTime();
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
        const between = document.createElement('span');
        between.className = 'job-timeline-duration';
        between.textContent = shortDuration(ended - started);
        between.style.left = `${(index + 1) * itemWidth}px`;
        list.appendChild(between);
      }
    }
    const text = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = event.label || event.type || '';
    const meta = document.createElement('span');
    meta.textContent = [timelineTime(event.at), event.detail || ''].filter(Boolean).join(' · ');
    text.append(label, meta);
    item.append(dot, text);
    list.appendChild(item);
  }
  jobTimeline.append(title, list);
  requestAnimationFrame(() => {
    list.scrollLeft = list.scrollWidth;
    requestAnimationFrame(() => { list.scrollLeft = list.scrollWidth; });
  });
}

function renderCaptureProgress(job) {
  clear(captureProgress);
  const progress = job?.captureProgress;
  const visual = progress?.visualStats || {};
  const scrollTop = Number(visual.lastScrollTop || 0);
  const scrollHeight = Number(visual.lastScrollHeight || 0);
  const clientHeight = Number(visual.clientHeight || 459);
  const maxScroll = Math.max(1, scrollHeight - clientHeight);
  const ratio = Math.max(0, Math.min(1, scrollTop / maxScroll));
  const pct = Math.round(ratio * 100);
  const elapsed = Number(progress?.elapsedMs || 0);
  const eta = ratio > 0.03 && ratio < 0.99 ? elapsed * (1 / ratio - 1) : 0;
  const completedCaptured = Number(job?.xhsCompletion?.captured || job?.view?.stats?.commentCount || 0);
  const liveCaptured = Number(progress?.comments ?? visual.visibleComments ?? completedCaptured);
  const captured = ['done', 'partial'].includes(job?.state) && completedCaptured ? completedCaptured : liveCaptured;
  const displayedTotal = Number(progress?.pageCommentCount || job?.xhsCompletion?.total || job?.metadata?.commentCount || job?.view?.stats?.sourceCommentCount || 0);
  const remaining = displayedTotal ? Math.max(0, displayedTotal - captured) : 0;
  const commentRatio = displayedTotal ? Math.max(0, Math.min(1, captured / displayedTotal)) : 0;
  const commentPct = Math.round(commentRatio * 100);
  const exceedsDisplayed = Boolean(displayedTotal && captured > displayedTotal);
  const updatedAgo = progress?.updatedAt ? Math.max(0, Date.now() - new Date(progress.updatedAt).getTime()) : 0;
  const isComplete = ['done', 'stopped'].includes(progress?.stage) || ['done', 'partial', 'failed', 'stopped'].includes(job?.state);
  const display = smoothCaptureDisplay(job?.id, animatedCaptureTargets(job, {
    scrollTop,
    scrollPct: pct,
    captured,
    commentPct,
  }), isComplete);
  const displayScrollTop = Math.round(display.scrollTop || 0);
  const displayScrollPct = Math.round(display.scrollPct || 0);
  const displayCaptured = Math.round(display.captured || 0);
  const displayCommentPct = Math.round(display.commentPct || 0);
  const isLive = job?.state === 'running' && updatedAgo < 15000 && !isComplete;
  const stageText = progress?.stage === 'api-main-pages'
    ? `正在慢速补主评论页${progress.apiStats?.page ? ` · 第 ${progress.apiStats.page} 页` : ''}`
    : progress?.stage === 'api-sub-pages'
    ? `正在慢速补子评论${progress.apiStats?.rootIndex ? ` · ${progress.apiStats.rootIndex}/${progress.apiStats.roots || '?'}` : ''}`
    : progress?.stage === 'visual-scroll'
    ? '正在滚动、展开回复并等待页面加载'
    : progress?.stage === 'login-required'
    ? '小红书登录态失效，需要重新同步 cookie'
    : progress?.stage === 'stopped'
    ? '采集已手动停止'
    : progress?.stage === 'done'
    ? '采集已结束'
    : '等待新的页面进度';
  const cooldown = job?.xhsCooldownUntil ? Math.max(0, new Date(job.xhsCooldownUntil).getTime() - Date.now()) : 0;
  const statusText = isComplete
    ? job?.state === 'partial'
      ? `部分完成 · 已抓 ${numberLabel(job?.xhsCompletion?.captured || captured)} 条`
      : stageText
    : cooldown
    ? `小红书风控冷却中 · 约 ${duration(cooldown)} 后可续跑`
    : job?.state === 'partial'
    ? `部分完成 · 已抓 ${numberLabel(job?.xhsCompletion?.captured || captured)} 条`
    : isLive || job?.state !== 'running'
    ? stageText
    : '等待新的页面进度';
  const shouldShow = job?.platform === 'xiaohongshu' && (job.state === 'running' || progress);
  captureProgress.classList.toggle('hidden', !shouldShow);
  captureProgress.classList.toggle('is-complete', Boolean(isComplete));
  if (!shouldShow) return;

  const head = document.createElement('div');
  head.className = 'capture-progress-head';
  head.innerHTML = `
    <div class="capture-title-wrap">
      <span class="capture-spinner" aria-hidden="true"></span>
      <div>
        <strong>${job?.state === 'stopped' ? '小红书页面采集已停止' : isComplete ? '小红书页面采集完成' : '小红书页面采集中'}</strong>
        <span>${statusText}</span>
      </div>
    </div>
    <div class="capture-time">
      <span>已用 ${duration(elapsed)}</span>
      <strong>${isComplete ? (job?.state === 'stopped' ? '已停止' : '已完成') : eta ? `约剩 ${duration(eta)}` : '采集中'}</strong>
    </div>
  `;

  function progressRow({ label, value, detail, width, tone = '' }) {
    const row = document.createElement('div');
    row.className = `capture-progress-row ${tone}`;
    row.innerHTML = `
      <div class="progress-row-head">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
      <div class="progress-track"><div style="width:${width}%"></div></div>
      <p>${detail}</p>
    `;
    return row;
  }

  const scrollRow = progressRow({
    label: '页面滚动',
    value: `${displayScrollPct}%`,
    detail: `${numberLabel(displayScrollTop)} / ${numberLabel(Math.round(scrollHeight))}`,
    width: displayScrollPct,
    tone: 'scroll-progress',
  });

  const commentValue = displayedTotal
    ? `${numberLabel(displayCaptured)} 条（页面显示 ${numberLabel(displayedTotal)}）`
    : `${numberLabel(displayCaptured)} 条`;
  const commentDetail = displayedTotal
    ? exceedsDisplayed
      ? `已超过页面显示数 ${numberLabel(captured - displayedTotal)} 条；包含展开回复、接口补全或 DOM 补充`
      : `按页面显示数估算还差约 ${numberLabel(remaining)} 条，当前 ${displayCommentPct}%`
    : '还没有拿到平台展示的评论数';
  const commentRow = progressRow({
    label: '评论捕捉',
    value: commentValue,
    detail: commentDetail,
    width: displayedTotal ? displayCommentPct : Math.min(100, Math.max(8, displayCaptured ? 35 : 8)),
    tone: 'comment-progress',
  });

  const grid = document.createElement('div');
  grid.className = 'capture-progress-grid';
  const items = [
    ['页面显示', displayedTotal ? numberLabel(displayedTotal) : '未知'],
    ['已捕捉评论', numberLabel(displayCaptured)],
    [exceedsDisplayed ? '超过显示' : '还差', displayedTotal ? numberLabel(exceedsDisplayed ? captured - displayedTotal : remaining) : '待计算'],
    [progress?.apiStats ? '接口页数' : '采集轮次', progress?.apiStats ? numberLabel(progress.apiStats.rawPageCount || 0) : numberLabel(visual.rounds || 0)],
  ];
  for (const [label, value] of items) {
    const item = document.createElement('div');
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    grid.appendChild(item);
  }
  captureProgress.append(head, scrollRow, commentRow, grid);
}

function renderTranscript(rows) {
  clear(transcriptList);
  if (!rows?.length) {
    transcriptList.innerHTML = '<div class="empty-inline">暂无转写内容。</div>';
    return;
  }
  for (const row of rows) {
    const item = document.createElement('article');
    item.className = 'transcript-item';
    const meta = document.createElement('div');
    meta.className = 'transcript-meta';
    meta.textContent = row.start === undefined && row.end === undefined
      ? `${row.speaker || '正文段落'}${row.index !== undefined ? ` · ${Number(row.index) + 1}` : ''}`
      : `${hms(row.start)}-${hms(row.end)}${row.speaker ? ` · ${row.speaker}` : ''}`;
    const text = document.createElement('p');
    text.textContent = row.text || '';
    item.append(meta, text);
    transcriptList.appendChild(item);
  }
}

function emoteMap(row) {
  const map = new Map();
  for (const [token, emote] of knownEmotes.entries()) {
    map.set(token, { ...emote, token, url: String(emote.url || '').startsWith('//') ? `https:${emote.url}` : emote.url });
  }
  for (const emote of row?.emotes || []) {
    const token = String(emote.token || emote.text || '').trim();
    const url = String(emote.url || '').trim();
    if (!token) continue;
    map.set(token, { ...emote, token, url: url.startsWith('//') ? `https:${url}` : url });
  }
  return map;
}

function appendRichCommentText(node, row) {
  const text = String(row?.message || '');
  const map = emoteMap(row);
  const tokenPattern = /\[[^\[\]\s]{1,24}\]/g;
  let index = 0;
  const used = new Set();
  let match;
  while ((match = tokenPattern.exec(text))) {
    if (match.index > index) node.appendChild(document.createTextNode(text.slice(index, match.index)));
    const token = match[0];
    const emote = map.get(token);
    if (emote?.url) {
      appendEmoteImage(node, token, emote.url);
    } else {
      appendEmoteImage(node, token, '', 'local');
    }
    used.add(token);
    index = match.index + token.length;
  }
  if (index < text.length) node.appendChild(document.createTextNode(text.slice(index)));
  for (const rowEmote of row?.emotes || []) {
    const token = String(rowEmote.token || rowEmote.text || '').trim();
    const emote = map.get(token);
    if (!token || used.has(token) || !emote?.url || text.includes(token)) continue;
    node.appendChild(document.createTextNode(' '));
    appendEmoteImage(node, token, emote.url);
  }
}

function renderCommentNode(row, parent) {
  const thread = document.createElement('div');
  thread.className = `comment-thread level-${Math.min(Number(row.level || 0), 2)}`;
  thread.dataset.commentId = row.id || '';
  const item = document.createElement('article');
  item.className = `comment-item level-${Math.min(Number(row.level || 0), 2)}`;
  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  const pieces = [
    `L${row.level || 0}`,
    row.time || '',
    row.replyTo ? `回复 ${row.replyTo}` : '',
    row.like ? `赞 ${numberLabel(row.like)}` : '',
    row.sex ? `性别:${row.sex}` : '',
    row.userLevel !== '' && row.userLevel !== undefined ? `LV${row.userLevel}` : '',
    row.fansMedal || '',
  ].filter(Boolean);
  const level = document.createElement('span');
  level.textContent = pieces.shift() || `L${row.level || 0}`;
  const userId = document.createElement('strong');
  userId.className = 'comment-user-id';
  userId.textContent = row.userId || 'unknown';
  meta.append(level, document.createTextNode(' · '), userId);
  for (const piece of pieces) meta.append(document.createTextNode(` · ${piece}`));
  const text = document.createElement('p');
  appendRichCommentText(text, row);
  item.append(meta, text);
  thread.appendChild(item);
  if (row.children?.length) {
    thread.classList.add('has-children');
    item.classList.add('has-children');
    item.title = `点击折叠/展开 ${numberLabel(row.children.length)} 条回复`;
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'comment-children-wrap';
    const collapseLine = document.createElement('button');
    collapseLine.type = 'button';
    collapseLine.className = 'comment-collapse-line';
    collapseLine.title = `收起 ${numberLabel(row.children.length)} 条回复`;
    collapseLine.setAttribute('aria-label', `收起 ${numberLabel(row.children.length)} 条回复`);
    const children = document.createElement('div');
    children.className = 'comment-children';
    for (const child of row.children) renderCommentNode(child, children);
    const collapsedSet = collapsedComments.get(selectedId) || new Set();
    if (collapsedSet.has(row.id || '')) {
      children.classList.add('hidden');
      childrenWrap.classList.add('is-collapsed');
      thread.classList.add('is-collapsed');
      collapseLine.title = `展开 ${numberLabel(row.children.length)} 条回复`;
      collapseLine.setAttribute('aria-label', collapseLine.title);
    }
    childrenWrap.append(collapseLine, children);
    thread.append(childrenWrap);
  }
  parent.appendChild(thread);
}

commentList.addEventListener('click', (event) => {
  if (event.target.closest('button, a, input, textarea, select')) {
    if (!event.target.closest('.comment-collapse-line')) return;
  }
  const line = event.target.closest('.comment-collapse-line');
  const item = event.target.closest('.comment-item.has-children');
  const directThread = event.target.classList?.contains('comment-thread') && event.target.classList.contains('has-children') ? event.target : null;
  const thread = line?.closest('.comment-thread') || item?.closest('.comment-thread') || directThread;
  if (!thread) return;
  const wrap = thread.querySelector(':scope > .comment-children-wrap');
  const children = wrap?.querySelector('.comment-children');
  if (!wrap || !children) return;
  const collapseLine = wrap.querySelector('.comment-collapse-line');
  const collapsed = children.classList.toggle('hidden');
  const count = children.children.length;
  const id = thread.dataset.commentId || '';
  if (id && selectedId) {
    const set = collapsedComments.get(selectedId) || new Set();
    if (collapsed) set.add(id);
    else set.delete(id);
    collapsedComments.set(selectedId, set);
  }
  if (collapseLine) {
    collapseLine.title = collapsed ? `展开 ${numberLabel(count)} 条回复` : `收起 ${numberLabel(count)} 条回复`;
    collapseLine.setAttribute('aria-label', collapseLine.title);
  }
  wrap.classList.toggle('is-collapsed', collapsed);
  thread?.classList.toggle('is-collapsed', collapsed);
});

function commentTimeValue(row) {
  const ctime = Number(row?.ctime || 0);
  if (ctime > 1000000000000) return ctime;
  if (ctime > 1000000000) return ctime * 1000;
  const text = String(row?.time || '');
  const match = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return 0;
  const [, y, m, d, hh = '0', mm = '0', ss = '0'] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)).getTime();
}

function sortedCommentTree(rows) {
  if (commentSort === 'page') {
    return (rows || []).map((row) => ({
      ...row,
      children: sortedCommentTree(row.children || []),
    }));
  }
  const sorter = commentSort === 'like'
    ? (a, b) => Number(b.like || 0) - Number(a.like || 0) || commentTimeValue(b) - commentTimeValue(a)
    : (a, b) => commentTimeValue(b) - commentTimeValue(a) || Number(b.like || 0) - Number(a.like || 0);
  return (rows || []).map((row) => ({
    ...row,
    children: sortedCommentTree(row.children || []),
  })).sort(sorter);
}

function syncCommentSortButtons() {
  commentSortButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.sort === commentSort);
    button.classList.toggle('loading', button.dataset.sort === commentSortLoading);
    button.disabled = Boolean(commentSortLoading);
    button.setAttribute('aria-busy', button.dataset.sort === commentSortLoading ? 'true' : 'false');
  });
}

function renderComments(rows, job) {
  clear(commentList);
  syncCommentSortButtons();
  if (!rows?.length) {
    const recentLog = (job?.log || []).slice(-8).join('\n');
    const xhsFailure = job?.platform === 'xiaohongshu'
      && job?.state !== 'running'
      && /小红书评论接口失败|Account abnormal|专用浏览器评论采集失败/.test(recentLog);
    commentList.innerHTML = job?.state === 'running'
      ? '<div class="empty-inline">正在采集评论，完成后会显示在这里。</div>'
      : xhsFailure
      ? '<div class="empty-inline">页面信息已抓到，但小红书评论接口被登录状态或风控拦截；请看下方日志里的失败码。</div>'
      : '<div class="empty-inline">暂无评论数据。</div>';
    return;
  }
  for (const row of sortedCommentTree(rows)) renderCommentNode(row, commentList);
}

function renderDanmakuTimeline(rows) {
  clear(danmakuTimeline);
  danmakuTimeline.classList.toggle('hidden', !rows?.length);
  if (!rows?.length) return;
  const times = rows.map((row) => Number(row.time || 0)).filter((time) => Number.isFinite(time) && time >= 0);
  if (!times.length) {
    danmakuTimeline.classList.add('hidden');
    return;
  }
  const duration = Math.max(...times, 1);
  const bucketCount = Math.max(12, Math.min(60, Math.ceil(duration / 30)));
  const buckets = Array.from({ length: bucketCount }, () => 0);
  for (const time of times) {
    const index = Math.min(bucketCount - 1, Math.floor((time / duration) * bucketCount));
    buckets[index] += 1;
  }
  const max = Math.max(...buckets, 1);

  const head = document.createElement('div');
  head.className = 'timeline-head';
  const title = document.createElement('strong');
  title.textContent = '弹幕热度时间轴';
  const scale = document.createElement('span');
  scale.textContent = `峰值 ${max} 条 / 桶`;
  head.append(title, scale);

  const body = document.createElement('div');
  body.className = 'timeline-body';
  const axis = document.createElement('div');
  axis.className = 'timeline-axis';
  axis.innerHTML = `<span>${max}</span><span>热度</span><span>0</span>`;
  const bars = document.createElement('div');
  bars.className = 'timeline-bars';
  buckets.forEach((count, index) => {
    const bar = document.createElement('div');
    bar.className = 'timeline-bar';
    bar.style.height = `${Math.max(4, Math.round((count / max) * 100))}%`;
    const start = (duration / bucketCount) * index;
    const end = (duration / bucketCount) * (index + 1);
    bar.title = `${hms(start)}-${hms(end)}：${count} 条`;
    bars.appendChild(bar);
  });
  body.append(axis, bars);

  const labels = document.createElement('div');
  labels.className = 'timeline-labels';
  labels.innerHTML = `<span>${hms(0)}</span><span>${hms(duration / 2)}</span><span>${hms(duration)}</span>`;
  danmakuTimeline.append(head, body, labels);
}

function syncGptSettingsForm() {
  summaryPresetButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.summaryPreset === gptSettings.preset);
  });
  summaryPresetPanels.forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.summaryPanel !== gptSettings.preset);
  });
  gptDetail.value = gptSettings.detail;
  gptIncludeComments.checked = gptSettings.includeComments;
  gptIncludeDanmaku.checked = gptSettings.includeDanmaku;
  gptIncludeProfile.checked = gptSettings.includeProfile;
  gptPrompt.value = gptSettings.prompt;
}

function setGptPreset(preset, { resetPrompt = false } = {}) {
  const next = preset === 'article' ? 'article' : 'video';
  gptSettings.preset = next;
  if (resetPrompt) {
    gptSettings.prompt = next === 'article' ? ARTICLE_GPT_PROMPT : DEFAULT_GPT_PROMPT;
  } else if (next === 'article' && (!gptSettings.prompt || gptSettings.prompt === DEFAULT_GPT_PROMPT)) {
    gptSettings.prompt = ARTICLE_GPT_PROMPT;
  } else if (next === 'video' && (!gptSettings.prompt || gptSettings.prompt === ARTICLE_GPT_PROMPT)) {
    gptSettings.prompt = DEFAULT_GPT_PROMPT;
  }
  syncGptSettingsForm();
}

function saveGptSettingsFromForm() {
  gptSettings.preset = document.querySelector('.summary-preset.active')?.dataset.summaryPreset || gptSettings.preset || 'video';
  gptSettings.detail = gptDetail.value;
  gptSettings.includeComments = gptIncludeComments.checked;
  gptSettings.includeDanmaku = gptIncludeDanmaku.checked;
  gptSettings.includeProfile = gptIncludeProfile.checked;
  gptSettings.prompt = gptPrompt.value.trim() || (gptSettings.preset === 'article' ? ARTICLE_GPT_PROMPT : DEFAULT_GPT_PROMPT);
  localStorage.setItem('flyinglap_gpt_detail', gptSettings.detail);
  localStorage.setItem('flyinglap_gpt_comments', gptSettings.includeComments ? '1' : '0');
  localStorage.setItem('flyinglap_gpt_danmaku', gptSettings.includeDanmaku ? '1' : '0');
  localStorage.setItem('flyinglap_gpt_profile', gptSettings.includeProfile ? '1' : '0');
  localStorage.setItem('flyinglap_gpt_prompt', gptSettings.prompt);
}

function openGptModal() {
  syncGptSettingsForm();
  gptModal.classList.remove('hidden');
}

function closeGptModal() {
  gptModal.classList.add('hidden');
}

function renderDanmaku(rows) {
  renderDanmakuTimeline(rows || []);
  clear(danmakuList);
  if (!rows?.length) {
    danmakuList.innerHTML = '<div class="empty-inline">暂无弹幕数据。</div>';
    return;
  }
  for (const row of rows) {
    const item = document.createElement('article');
    item.className = 'danmaku-item';
    const meta = document.createElement('div');
    meta.className = 'danmaku-meta';
    meta.textContent = `${hms(row.time)}${row.userHash ? ` · ${row.userHash}` : ''}`;
    const text = document.createElement('p');
    text.textContent = row.text || '';
    item.append(meta, text);
    danmakuList.appendChild(item);
  }
}

function renderJobView(job) {
  const view = job.view;
  resultView.classList.toggle('hidden', !view);
  preview.classList.toggle('hidden', Boolean(view) || !job.preview);
  if (!view) {
    clear(contentPreview);
    contentPreview.classList.add('hidden');
    preview.textContent = job.preview || '';
    return;
  }
  renderContentPreview(view.content || {});
  renderStats(view);
  renderTranscript(view.transcript || []);
  renderComments(view.comments || [], job);
  renderDanmaku(view.danmaku || []);
  activateTab(activeTab);
}

function activateTab(name) {
  activeTab = name;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== name);
  });
}

function renderJobs() {
  jobList.innerHTML = '';
  const visible = platformFilterValue === 'all' ? jobs : jobs.filter((job) => platformKeyForJob(job) === platformFilterValue);
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'job-list-empty';
    empty.textContent = '这个平台暂时没有任务。';
    jobList.appendChild(empty);
    return;
  }
  for (const job of visible) {
    const item = document.createElement('button');
    item.type = 'button';
    const logoSrc = platformLogoForJob(job);
    item.className = `job-item${job.id === selectedId ? ' active' : ''}${logoSrc ? '' : ' no-logo'}`;
    if (logoSrc) {
      const logo = document.createElement('img');
      logo.className = 'platform-logo';
      logo.src = logoSrc;
      logo.alt = job.platform || 'platform';
      logo.loading = 'lazy';
      logo.addEventListener('error', () => {
        logo.remove();
        item.classList.add('no-logo');
      }, { once: true });
      item.appendChild(logo);
    }
    const body = document.createElement('div');
    body.className = 'job-item-body';
    const title = document.createElement('strong');
    title.textContent = job.title || job.url;
    const meta = document.createElement('span');
    meta.textContent = `${stateLabel(job.state)} · ${job.platform || 'video'}`;
    body.append(title, meta);
    item.appendChild(body);
    item.addEventListener('click', () => selectJob(job.id));
    jobList.appendChild(item);
  }
}

async function loadJobs(options = {}) {
  const { refreshSelected = true, preserveScroll = false } = options;
  const body = await api('/api/jobs');
  jobs = body.jobs || [];
  if (!selectedId && jobs.length) selectedId = jobs[0].id;
  renderJobs();
  if (refreshSelected && selectedId) await loadJob(selectedId, { preserveScroll });
}

async function loadJob(id, options = {}) {
  const sameJob = selectedId === id;
  const shouldPreserveScroll = options.preserveScroll && sameJob;
  const scrollX = shouldPreserveScroll ? window.scrollX : 0;
  const scrollY = shouldPreserveScroll ? window.scrollY : 0;
  selectedId = id;
  renderJobs();
  const { job } = await api(`/api/jobs/${id}`);
  selectedJobSnapshot = job;
  if (gptPresetJobId !== job.id) {
    gptPresetJobId = job.id;
    setGptPreset(isArticleJob(job) ? 'article' : 'video', { resetPrompt: true });
  }
  emptyState.classList.add('hidden');
  jobDetail.classList.remove('hidden');
  jobTitle.textContent = job.title || job.url;
  jobUrl.textContent = job.url;
  jobUrl.title = job.url || '';
  const liveLine = captureStageText(job);
  const logLines = liveLine ? [...(job.log || []), liveLine] : (job.log || []);
  const logWasPinned = progressLog.scrollHeight - progressLog.scrollTop - progressLog.clientHeight < 16;
  progressLog.innerHTML = logLines.map((line) => `<div>${normalizeClockText(line)}</div>`).join('');
  if (logWasPinned) progressLog.scrollTop = progressLog.scrollHeight;
  renderJobTimeline(job);
  renderCaptureProgress(job);
  contentLink.href = contentPageUrl(job);
  finalLink.href = `/api/jobs/${id}/file?name=final`;
  downloadLink.href = `/api/jobs/${id}/file?name=final&download=1`;
  downloadLink.setAttribute('download', markdownFileName(job));
  danmakuLink.href = `/api/jobs/${id}/file?name=danmaku`;
  finalLink.classList.toggle('hidden', !job.outputs?.final);
  downloadLink.classList.toggle('hidden', !job.outputs?.final);
  danmakuLink.classList.toggle('hidden', !job.outputs?.danmaku);
  renderJobView(job);
  const localSummary = summaryDrafts.get(job.id);
  const isSummaryRunning = localSummary === '正在生成总结...';
  const hasInteractionData = Boolean((job.view?.stats?.commentCount || 0) > 0 || (job.view?.stats?.danmakuCount || 0) > 0 || job.outputs?.json || job.outputs?.danmaku);
  const canFullSummary = ['done', 'partial'].includes(job.state) || Boolean(job.outputs?.final);
  gptButton.textContent = isSummaryRunning ? '总结中...' : 'AI 总结';
  gptInteractionButton.textContent = isSummaryRunning ? '总结中...' : '只总结互动';
  summaryEmptyGpt.textContent = isSummaryRunning ? '总结中...' : 'AI 总结';
  summaryEmptyInteraction.textContent = isSummaryRunning ? '总结中...' : '只总结互动';
  gptButton.disabled = isSummaryRunning || !canFullSummary;
  summaryEmptyGpt.disabled = isSummaryRunning || !canFullSummary;
  gptInteractionButton.disabled = isSummaryRunning || !hasInteractionData;
  summaryEmptyInteraction.disabled = isSummaryRunning || !hasInteractionData;
  contentLink.classList.toggle('hidden', !job.url);
  stopButton.classList.toggle('hidden', !['queued', 'running'].includes(job.state));
  stopButton.disabled = !['queued', 'running'].includes(job.state);
  deleteButton.disabled = false;
  const summary = localSummary || job.summary || '';
  currentSummaryMarkdown = summary;
  summaryBox.classList.toggle('hidden', !summary);
  summaryEmpty.classList.toggle('hidden', Boolean(summary));
  summaryBox.classList.toggle('error', Boolean(localSummary?.startsWith('总结失败：')));
  renderMarkdown(summaryText, summary);
  if (shouldPreserveScroll) {
    requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
  }
}

async function selectJob(id) {
  await loadJob(id);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  const body = await api('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, transcribeVideo: transcribeToggle.checked }),
  });
  urlInput.value = '';
  selectedId = body.job.id;
  await loadJobs();
});

pasteButton.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch {
    pasteButton.textContent = '粘贴失败';
    setTimeout(() => { pasteButton.textContent = '粘贴'; }, 1400);
  }
});

stopButton.addEventListener('click', async () => {
  if (!selectedId) return;
  stopButton.disabled = true;
  stopButton.textContent = '停止中...';
  try {
    await api(`/api/jobs/${selectedId}/stop`, { method: 'POST' });
    await loadJob(selectedId);
  } finally {
    stopButton.textContent = '停止采集';
  }
});

deleteButton.addEventListener('click', async () => {
  if (!selectedId) return;
  const current = jobs.find((job) => job.id === selectedId);
  if (!confirm(`删除任务「${current?.title || current?.url || selectedId}」？`)) return;
  deleteButton.disabled = true;
  try {
    await api(`/api/jobs/${selectedId}`, { method: 'DELETE' });
    selectedId = '';
    await loadJobs({ preserveScroll: true });
    if (!jobs.length) {
      jobDetail.classList.add('hidden');
      emptyState.classList.remove('hidden');
    }
  } finally {
    deleteButton.disabled = false;
  }
});

async function runGptSummary(interactionOnly = false) {
  if (!selectedId) return;
  const jobId = selectedId;
  const isCurrentJob = () => selectedId === jobId;
  saveGptSettingsFromForm();
  gptButton.disabled = true;
  gptInteractionButton.disabled = true;
  summaryEmptyGpt.disabled = true;
  summaryEmptyInteraction.disabled = true;
  const activeButton = interactionOnly ? gptInteractionButton : gptButton;
  const activeEmptyButton = interactionOnly ? summaryEmptyInteraction : summaryEmptyGpt;
  activeButton.textContent = '总结中...';
  activeEmptyButton.textContent = '总结中...';
  summaryEmptyGpt.textContent = '总结中...';
  summaryEmptyInteraction.textContent = '总结中...';
  summaryDrafts.set(jobId, '正在生成总结...');
  if (isCurrentJob()) {
    currentSummaryMarkdown = '正在生成总结...';
    summaryBox.classList.remove('hidden');
    summaryEmpty.classList.add('hidden');
    summaryBox.classList.remove('error');
    renderMarkdown(summaryText, '正在生成总结...');
    activateTab('summary');
  }
  try {
    const body = await api(`/api/jobs/${jobId}/gpt-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...gptSettings, summaryPreset: gptSettings.preset, interactionOnly }),
    });
    summaryDrafts.delete(jobId);
    if (isCurrentJob()) {
      currentSummaryMarkdown = body.summary || '';
      summaryBox.classList.remove('hidden');
      renderMarkdown(summaryText, currentSummaryMarkdown);
    }
    await loadJobs();
  } catch (error) {
    const message = `总结失败：${error.message || '未配置 OpenAI API Key 或请求失败'}`;
    summaryDrafts.set(jobId, message);
    if (isCurrentJob()) {
      currentSummaryMarkdown = message;
      summaryBox.classList.remove('hidden');
      summaryEmpty.classList.add('hidden');
      summaryBox.classList.add('error');
      renderMarkdown(summaryText, message);
    }
  } finally {
    gptButton.textContent = 'AI 总结';
    gptInteractionButton.textContent = '只总结互动';
    summaryEmptyGpt.textContent = 'AI 总结';
    summaryEmptyInteraction.textContent = '只总结互动';
    gptButton.disabled = false;
    gptInteractionButton.disabled = false;
    summaryEmptyGpt.disabled = false;
    summaryEmptyInteraction.disabled = false;
    if (selectedId) {
      loadJob(selectedId, { preserveScroll: true }).catch(() => {});
    }
  }
}

copyContentLinkButton.addEventListener('click', async () => {
  if (!selectedJobSnapshot) return;
  try {
    await copyText(contentPageUrl(selectedJobSnapshot), copyContentLinkButton);
  } catch {
    copyContentLinkButton.textContent = '复制失败';
    setTimeout(() => { copyContentLinkButton.textContent = '复制链接'; }, 1200);
  }
});

copySummaryMd.addEventListener('click', async () => {
  if (!currentSummaryMarkdown.trim()) return;
  try {
    await copyText(currentSummaryMarkdown, copySummaryMd);
  } catch {
    copySummaryMd.textContent = '复制失败';
    setTimeout(() => { copySummaryMd.textContent = '拷贝 MD'; }, 1200);
  }
});

copySummaryText.addEventListener('click', async () => {
  if (!currentSummaryMarkdown.trim()) return;
  try {
    await copyText(stripMarkdown(currentSummaryMarkdown), copySummaryText);
  } catch {
    copySummaryText.textContent = '复制失败';
    setTimeout(() => { copySummaryText.textContent = '拷贝纯文本'; }, 1200);
  }
});

exportSummaryPdf.addEventListener('click', async () => {
  if (!currentSummaryMarkdown.trim()) return;
  const original = exportSummaryPdf.textContent;
  exportSummaryPdf.disabled = true;
  exportSummaryPdf.textContent = '生成中...';
  try {
    await exportSummaryPdfFile();
    exportSummaryPdf.textContent = original;
    exportSummaryPdf.disabled = false;
  } catch {
    exportSummaryPdf.textContent = '导出失败';
    setTimeout(() => {
      exportSummaryPdf.textContent = original;
      exportSummaryPdf.disabled = false;
    }, 1400);
  }
});

gptButton.addEventListener('click', () => runGptSummary(false));
gptInteractionButton.addEventListener('click', () => runGptSummary(true));
summaryEmptyGpt.addEventListener('click', () => runGptSummary(false));
summaryEmptyInteraction.addEventListener('click', () => runGptSummary(true));

gptSettingsButton.addEventListener('click', openGptModal);
gptModalClose.addEventListener('click', closeGptModal);
summaryPresetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setGptPreset(button.dataset.summaryPreset || 'video', { resetPrompt: true });
  });
});
gptSaveSettings.addEventListener('click', () => {
  saveGptSettingsFromForm();
  closeGptModal();
});
gptResetPrompt.addEventListener('click', () => {
  gptPrompt.value = gptSettings.preset === 'article' ? ARTICLE_GPT_PROMPT : DEFAULT_GPT_PROMPT;
});
gptModal.addEventListener('click', (event) => {
  if (event.target === gptModal) closeGptModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !imageLightbox.classList.contains('hidden')) closeImageLightbox();
  if (event.key === 'Escape') closeGptModal();
});
imageLightboxClose.addEventListener('click', closeImageLightbox);
imageLightbox.addEventListener('click', (event) => {
  if (event.target === imageLightbox) closeImageLightbox();
});
syncGptSettingsForm();
platformFilter.value = platformFilterValue;
platformFilter.addEventListener('change', () => {
  platformFilterValue = platformFilter.value || 'all';
  renderJobs();
});

setInterval(() => {
  loadJobs({ refreshSelected: false }).catch(() => {});
  if (selectedId && selectedJobSnapshot && ['queued', 'running'].includes(selectedJobSnapshot.state)) {
    loadJob(selectedId, { preserveScroll: true }).catch(() => {});
  }
}, 2500);

setInterval(() => {
  if (!selectedJobSnapshot) return;
  if (selectedJobSnapshot.platform !== 'xiaohongshu') return;
  if (selectedJobSnapshot.state !== 'running') return;
  if (!selectedJobSnapshot.captureProgress) return;
  renderCaptureProgress(selectedJobSnapshot);
}, 33);

loadEmoteDictionary().finally(() => loadJobs()).catch((error) => {
  preview.textContent = error.message;
});

document.querySelectorAll('[data-tab]').forEach((button) => {
  button.addEventListener('click', () => activateTab(button.dataset.tab));
});

commentSortButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    commentSort = button.dataset.sort || 'time';
    localStorage.setItem('flyinglap_comment_sort', commentSort);
    commentSortLoading = commentSort;
    syncCommentSortButtons();
    try {
      if (selectedId) await loadJob(selectedId);
    } finally {
      commentSortLoading = '';
      syncCommentSortButtons();
    }
  });
});
