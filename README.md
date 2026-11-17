# 体育直播回看内核

动态直播清单 → 可用片段 → 实际可播放时间窗。用户可以从直播附近回到窗口内的旧位置，窗口向前滚动时被移出的目标会被明确重定位或拒绝。

播放器 **不是** 用一条预渲染长视频加移动进度条模拟直播：清单由动态源实时发布，片段在请求时按需编码，窗口、序号和可用范围都随源时钟推进。

## 快速开始

```bash
npm install
npm start
# 打开 http://localhost:8080/web/index.html
```

演示源默认每 4 秒发布一个新片段，窗口保留 8 段（32 秒）。可通过环境变量调整：

```bash
WINDOW_SEGMENTS=12 SEGMENT_INTERVAL_MS=3000 START_HOURS_AGO=0.5 npm start
```

## 测试

```bash
npm test          # 内核语义测试（17 项）
npm run test:e2e  # 真实 Chromium + MSE + 画面帧号校验
```

E2E 测试需要 Playwright Chromium。本环境使用的是私有解压的系统库：

```bash
export LD_LIBRARY_PATH=/workspace/.chromelibs/usr/lib/aarch64-linux-gnu:/workspace/.chromelibs/lib/aarch64-linux-gnu
```

## 三套时间，绝不混用

| 时间 | 来源 | 用途 | 规则 |
| --- | --- | --- | --- |
| 媒体序号 `msn` | `EXT-X-MEDIA-SEQUENCE` + 顺序 | 片段身份 | 同一 msn 指向同一内容；序号回退或同号换内容 = 新关系 |
| 播放时间 `mediaMs` | 仅由窗口内声明的 `EXTINF` 时长累加 | 播放器时间轴、定位 | 关系内稳定；跨清单轮询不变；**不是**绝对拍摄时间 |
| 源声明日期 | `EXT-X-PROGRAM-DATE-TIME` | 展示源时间 | 逐段保存原值；跳变/缺失照实报告，绝不用时长累加推断 |

`mediaMs` 只表示“这段素材距离时间轴起点多久”。它不会被包装成开播时刻或拍摄时刻。源声明日期与时长累加不一致时，内核在 `issues` 中报告 `declared-date-media-drift`，两者分别展示。

## 窗口与淘汰语义

- **窗口 = 结束于最新片段的连续片段串。** `msn` 出现缺口时，缺口之前的内容不再是“可用窗口”的一部分，即使它们仍出现在清单里。窗口不会跨越缺口。
- **已移出的目标必须显式处理。** `LiveView.resolveStart(t)` 返回：
  - `play` — 目标在窗口内且可播放；
  - `relocate` — 目标仅略微越界（容差内），重定位到窗口起点，并附带 `requestedMs` / `relocatedMs` / `reason`；
  - `refuse` — 目标已淘汰、位于缺口、或超过直播边缘，附带明确 `reason`。
  拒绝不会再触发任何片段请求。播放器在 `seekToMediaMs` 中只对 `ok` 的决定取流。
- **序号重置** 会创建新关系，时间轴单调续接（不从 0 重来，避免旧目标悄悄映射到新内容），旧窗口整体记为 `relation-reset`，播放器清空旧缓冲并重新锚定。
- **不连续标记**（`EXT-X-DISCONTINUITY`）只开启新的编码纪元 `epoch`，媒体时间保持连续；声明日期可按源跳变。
- **缺片** 有两种表达方式，内核分别处理：
  - 清单里 msn 直接跳过（`segment-gap` + `holes`）——该段从未出现，窗口不跨越缺口；
  - 源声明 `#EXT-X-GAP`（`declared-gap`）——该段保留序号槽位但无媒体，编号仍对齐，定位返回 `gap` 并拒绝，绝不把邻段字节拼成连续时间轴。

## 新鲜度

内核区分四种状态，页面分别标注：

| 状态 | 触发 | 最后确认范围 | 直播边缘 |
| --- | --- | --- | --- |
| `live` | 轮询成功且内容在推进 | 当前 | 可视为实时 |
| `unconfirmed` | 最近一次失败，仍在新鲜度预算内 | 保留 | **不是**实时 |
| `stale` | 失败时间超过 `staleAfterMs` | 保留 | **不是**实时 |
| `stalled` | 轮询成功但清单内容超过 `stallAfterMs` 未推进 | 保留 | **不是**实时 |

清单短时失败时保留最后确认范围并标明新鲜度；播放器不会把旧清单当成仍在持续直播（`liveEdgeIsCurrent: false`），`stalled`/`stale` 时暂停跟随旧边缘。

## 目录

```
src/kernel/manifest.mjs      清单解析（三套时间分别返回）
src/kernel/live-kernel.mjs   稳定时间轴、窗口、淘汰、新鲜度、定位决定
src/origin/dynamic-origin.mjs 滚动清单、按需片段、场景故障注入
src/origin/encode.mjs        ffmpeg 按需编码、fMP4 init 拆分、tfdt 绝对时间
src/shared/frame.mjs         程序化画面：条码 + 七段数码管帧号
src/server/server.mjs        动态源 + 静态 UI + 测试控制面
web/player.mjs               MSE 播放器：按内核决定取流/重定位/拒绝
web/ui.mjs / index.html / style.css  可用范围、播放点、三套时间、事件
test/kernel.test.mjs         内核语义测试
test/browser.test.mjs        Chromium E2E，核对真实画面帧号
```

## 画面帧号校验

每个编码帧都烧录了机器可读条码（32 位：epoch 4 + 帧号 20 + 校验 4）和人类可读帧号。播放器用 canvas 读取当前解码画面并解码条码，与内核根据 `mediaMs` 推出的预期帧号比较。测试在正常播放、回看定位、窗口滚动、序号重置后都做这一校验，因此“播放点”对应的是 **真实画面**，而不是进度条上的数字。

## 测试控制面（仅测试）

设置 `TEST_CONTROL=1` 时源暴露：

- `POST /test/advance?to=<contentIndex>` — 手动推进内容；
- `POST /test/scenario` — 修改缺片、缺口、序号重置、不连续等场景；
- `POST /test/fail?count=<n>` — 注入连续清单失败。

生产启动（`npm start`）不开启该控制面。
