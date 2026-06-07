import { chromium } from 'playwright';

const executablePath = chromium.executablePath();
console.log(JSON.stringify({
  ok: true,
  browser: 'chromium',
  executablePath,
}, null, 2));
