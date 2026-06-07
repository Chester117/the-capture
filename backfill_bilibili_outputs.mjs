import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const appDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const dataDir = path.join(appDir, 'data');
const jobsDir = path.join(dataDir, 'jobs');
const jobsPath = path.join(dataDir, 'jobs.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function hms(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function localTime(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function decodeXml(text) {
  return String(text || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
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
  };
}

async function writeComments(jobDir, rows) {
  await fs.writeFile(path.join(jobDir, 'comments_all.json'), JSON.stringify(rows, null, 2));
  const tsv = [
    ['level', 'rpid', 'root', 'parent', 'time', 'user', 'mid', 'sex', 'user_level', 'fans_medal', 'like', 'message'].join('\t'),
    ...rows.map((row) => [row.level, row.rpid, row.root, row.parent, row.time, row.user, row.mid, row.sex || '', row.userLevel || '', row.fansMedal || '', row.like, String(row.message).replace(/\r?\n/g, '\\n')].join('\t')),
  ].join('\n');
  await fs.writeFile(path.join(jobDir, 'comments_all.tsv'), tsv);
}

async function fetchDanmaku(jobDir, metadata) {
  const response = await fetch(`https://comment.bilibili.com/${metadata.cid}.xml`, {
    headers: { 'User-Agent': UA, Referer: `https://www.bilibili.com/video/${metadata.bvid}/` },
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
  await fs.writeFile(path.join(jobDir, 'danmaku_all.json'), JSON.stringify(rows, null, 2));
  const tsv = [
    ['time', 'mode', 'size', 'color', 'timestamp', 'user_hash', 'id', 'text'].join('\t'),
    ...rows.map((row) => [hms(row.time), row.mode, row.size, row.color, row.timestamp, row.userHash, row.id, String(row.text).replace(/\r?\n/g, '\\n')].join('\t')),
  ].join('\n');
  await fs.writeFile(path.join(jobDir, 'danmaku_all.tsv'), tsv);
  return rows;
}

function esc(value) {
  return String(value || '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

async function rebuildMarkdown(jobDir, metadata, comments, danmaku) {
  const transcriptPath = path.join(jobDir, 'video_audio_ticnote_transcript.txt');
  const transcript = fsSync.existsSync(transcriptPath) ? JSON.parse(await fs.readFile(transcriptPath, 'utf8')) : [];
  const lines = [];
  lines.push(`# ${metadata.title || ''}`, '', `来源：https://www.bilibili.com/video/${metadata.bvid || ''}/`, '平台：bilibili', `刷新时间：${new Date().toISOString()}`, '');
  lines.push('## 采集说明', '', `- 视频转写段落：${transcript.length}。评论/讨论条目：${comments.length}。弹幕条目：${danmaku.length}。`, '');
  if (metadata.desc) lines.push('## 视频简介', '', metadata.desc, '');
  lines.push('## 视频内容转写', '');
  for (const seg of transcript) lines.push(`[${hms(seg.start)}-${hms(seg.end)}] ${seg.speaker || ''}: ${seg.text || ''}`, '');
  lines.push('## 评论/讨论转写', '', '| # | 层级 | 用户ID | 用户 | 性别 | 等级 | 粉丝牌 | 内容 |', '|---:|---:|---|---|---|---:|---|---|');
  comments.forEach((row, index) => lines.push(`| ${index + 1} | ${row.level || 0} | ${esc(row.mid || row.user)} | ${esc(row.user)} | ${esc(row.sex)} | ${row.userLevel || ''} | ${esc(row.fansMedal)} | ${esc(row.message)} |`));
  lines.push('', '## 弹幕转写', '', '| # | 时间 | 用户Hash | 内容 |', '|---:|---|---|---|');
  danmaku.forEach((row, index) => lines.push(`| ${index + 1} | ${hms(row.time)} | ${esc(row.userHash)} | ${esc(row.text)} |`));
  lines.push('');
  await fs.writeFile(path.join(jobDir, 'final_text.md'), lines.join('\n'));
}

const jobs = JSON.parse(await fs.readFile(jobsPath, 'utf8'));
for (const job of jobs) {
  const jobDir = path.join(jobsDir, job.id);
  const metadataPath = path.join(jobDir, 'metadata.json');
  const pagesPath = path.join(jobDir, 'comments_main_pages.json');
  if (!fsSync.existsSync(metadataPath) || !fsSync.existsSync(pagesPath)) continue;
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  if (!metadata.bvid || !metadata.cid) continue;
  const pages = JSON.parse(await fs.readFile(pagesPath, 'utf8'));
  const comments = [];
  const seen = new Set();
  for (const page of pages) {
    for (const reply of page.replies || []) {
      for (const row of [replyRow(reply, 0), ...(reply.replies || []).map((child) => replyRow(child, 1))]) {
        if (row.rpid && !seen.has(row.rpid)) {
          seen.add(row.rpid);
          comments.push(row);
        }
      }
    }
  }
  await writeComments(jobDir, comments);
  const danmaku = await fetchDanmaku(jobDir, metadata);
  job.outputs = {
    ...(job.outputs || {}),
    danmaku: path.join(jobDir, 'danmaku_all.json'),
    danmakuTsv: path.join(jobDir, 'danmaku_all.tsv'),
  };
  await rebuildMarkdown(jobDir, metadata, comments, danmaku);
  console.log(`${job.id}: comments=${comments.length} danmaku=${danmaku.length}`);
}
await fs.writeFile(jobsPath, JSON.stringify(jobs, null, 2));
