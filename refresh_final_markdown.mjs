import fs from 'node:fs/promises';
import path from 'node:path';

const appDir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: node refresh_final_markdown.mjs <job_id>');
  process.exit(1);
}

const jobDir = path.join(appDir, 'data/jobs', jobId);
const metadata = JSON.parse(await fs.readFile(path.join(jobDir, 'metadata.json'), 'utf8'));
const comments = JSON.parse(await fs.readFile(path.join(jobDir, 'comments_all.json'), 'utf8'));
const transcript = JSON.parse(await fs.readFile(path.join(jobDir, 'video_audio_ticnote_transcript.txt'), 'utf8'));

function hms(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function escapeCell(value) {
  return String(value || '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

const lines = [];
lines.push(`# ${metadata.title || jobId}`);
lines.push('');
lines.push(`来源：https://www.bilibili.com/video/${metadata.bvid || ''}/`);
lines.push('平台：bilibili');
lines.push(`刷新时间：${new Date().toISOString()}`);
lines.push('');
lines.push('## 采集说明');
lines.push('');
lines.push(`- 视频转写段落：${transcript.length}。评论/讨论条目：${comments.length}。`);
lines.push('- 评论表仅保留层级、用户ID、用户名和评论内容，便于后续阅读和 AI 总结。');
lines.push('');
if (metadata.desc) {
  lines.push('## 视频简介');
  lines.push('');
  lines.push(metadata.desc);
  lines.push('');
}
lines.push('## 视频内容转写');
lines.push('');
for (const seg of transcript) {
  const prefix = `[${hms(seg.start)}-${hms(seg.end)}] ${seg.speaker || ''}: `;
  lines.push(`${prefix}${seg.text || ''}`);
  lines.push('');
}
lines.push('## 评论/讨论转写');
lines.push('');
lines.push('| # | 层级 | 用户ID | 用户 | 内容 |');
lines.push('|---:|---:|---|---|---|');
comments.forEach((row, index) => {
  lines.push(`| ${index + 1} | ${row.level || 0} | ${escapeCell(row.mid || row.user)} | ${escapeCell(row.user)} | ${escapeCell(row.message)} |`);
});
lines.push('');

await fs.writeFile(path.join(jobDir, 'final_text.md'), lines.join('\n'));
console.log(`refreshed ${path.join(jobDir, 'final_text.md')}`);
