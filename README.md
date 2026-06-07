# FlyingLap Danmu Capture

本机视频内容和讨论区采集服务。

## 功能

- 输入 Bilibili 视频链接后自动抓取元数据、主评论和主评论接口内嵌楼中楼预览。
- 自动下载 Bilibili 音频并调用 TicNote 转写视频口播。
- 其他视频平台会尝试用 `yt-dlp` 抓元数据和音频，再交给 TicNote 转写；评论抓取取决于平台/`yt-dlp` 能否提供。
- 支持一键 GPT 总结，需设置 `OPENAI_API_KEY`。
- 支持 Bilibili、YouTube 等视频平台按画质下载内容；最高画质合并需要 `ffmpeg`。
- 输出 Markdown、JSON、TSV，保存在 `data/jobs/<job_id>/`。

## 运行

```bash
cd /Users/homemacserver/Documents/HomeMacServer/HomemacServerAutomation/FlyingLapDanmu
PORT=8799 YT_DLP=/Users/homemacserver/.local/bin/yt-dlp PYTHON3=/usr/bin/python3 node server.mjs
```

如需稳定下载并合并最高画质视频，提供 `ffmpeg`：

```bash
FFMPEG_BIN=/path/to/ffmpeg PORT=8799 YT_DLP=/Users/homemacserver/.local/bin/yt-dlp node server.mjs
```

本机部署也支持把 ffmpeg 放在：

```text
bin/ffmpeg-darwin-arm64/ffmpeg
```

`bin/`、`data/`、日志、cookie、token 和任务输出不会进入 Git。

## Playwright/Chromium 预配置

后续如果要把小红书采集切到独立 Playwright Chromium，先安装依赖和浏览器：

```bash
cd /Users/homemacserver/Documents/HomeMacServer/HomemacServerAutomation/FlyingLapDanmu
npm install
npm run playwright:install
npm run playwright:check
```

当前代码仍沿用现有采集链路；这一步只是把 Playwright/Chromium 依赖入口准备好，避免和日常 Chrome 或其他 Codex 进程混用。

## 本机部署

已提供 LaunchAgent 模板：`com.homemacserver.flyinglap-danmu.plist`。

当前部署地址：

- 本机：`http://127.0.0.1:8799/?token=...`
- Cloudflare：`https://capture.theflyinglapdamnu.top/?token=...`

访问 token 默认生成在 `data/access_token.txt`。

Cloudflare quick tunnel 仍可临时使用：

```bash
cd /Users/homemacserver/Documents/HomeMacServer/HomemacServerAutomation/FlyingLapDanmu
PORT=8799 node run_cloudflare_quick_tunnel.mjs
```

隧道 URL 会写入 `data/public_base_url.txt`。

## 环境变量

- `PORT`: 默认 `8799`
- `TICNOTE_API_KEY`: 不设置时会尝试读取仓库里的 `auth/ticnote-appkey.txt`
- `TICNOTE_PARENT_ID`: 默认 `1956577365333659247`（Recordings）
- `OPENAI_API_KEY`: GPT 总结需要；也可以放在仓库的 `auth/openai-api-key.txt`
- `OPENAI_MODEL`: 默认 `gpt-4.1-mini`
- `FFMPEG_BIN`: 可选；用于 `yt-dlp` 合并最高视频流和音频流
