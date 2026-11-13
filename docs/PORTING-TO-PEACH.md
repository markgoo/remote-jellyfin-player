# 把远程串流手势层移植到另一个 Web 影视系统（PEACH）—— 接手说明

> 目的：让接手者（人或 AI）能在不重读全部历史的情况下，判断这件事能不能做、要改哪里、
> 有哪些已知坑。**本文档只讲"怎么适配**，不重复讲 Jellyfin 业务细节。

---

## 一、先说结论

**手势能力与后端系统无关，只取决于前端播放器的 DOM 结构。**

现有实现依赖三样东西：

| 依赖 | 代码位置 | 说明 |
|---|---|---|
| `document.querySelector('video')` | `src/preload.js` `findVideo()` | 需要页面里有**原生 `<video>` 元素** |
| `mousedown` / `mouseup` | `src/preload.js` 第 245 行起 | Moonlight Direct Touch 把触摸转成这两个事件 |
| DOM 选择器判定 | `WIDGET_SELECTOR` / `SURFACE_ROOTS` | 判断"点在了画面还是控件上" |

只要目标系统满足下面三条，就能适配；不满足则要换方案：

1. **有原生 `<video>` 元素**（HLS.js / dash.js / video.js / Plyr 都满足，它们底层仍是 `<video>`）
2. **播放器在主框架，不在跨域 iframe 里**（preload 只作用于主框架）
3. **控件是 DOM 元素，不是 canvas 绘制**（canvas 内部无法做命中判定）

---

## 二、第一步：探测目标系统（必做）

在 PEACH 的播放页按 `F12`，Console 里粘贴执行：

```javascript
console.log('video  :', document.querySelectorAll('video').length);
console.log('iframe :', document.querySelectorAll('iframe').length);
console.log('canvas :', document.querySelectorAll('canvas').length);
document.querySelectorAll('iframe').forEach((f, i) =>
  console.log(`frame[${i}] src=`, f.src));
```

### 结果对照表

| 探测结果 | 可行性 | 预估工作量 | 做法 |
|---|---|---|---|
| `video:1, iframe:0` | **直接可用** | 1–2 小时 | 只改选择器常量 |
| `video:0, iframe:1`（同域） | 可做 | 半天–1 天 | 改主进程注入 frame，或改用 `webview` 标签 |
| `video:0, canvas:1` | **困难** | 需重设计 | canvas 渲染的视频无法做 DOM 命中判定，考虑放弃手势层 |
| `video:0, iframe:1`（跨域） | **受阻** | 需服务端配合 | 浏览器安全策略限制，preload 注入不进去 |

**先做这一步再动手，不要凭猜测改代码。**

---

## 三、需要改的地方（按顺序）

### 3.1 改服务地址

`config.json`：

```json
"serverUrl": "http://<PEACH 地址>"
```

或用命令行参数（`src/main.js` 支持）：

```powershell
electron . --server http://<PEACH 地址>
```

### 3.2 改选择器常量（核心工作）

文件：`src/preload.js` 第 29–38 行附近。

**现状（Jellyfin 专用）：**

```javascript
const WIDGET_SELECTOR = [
    'button', 'input', 'select', 'textarea', 'a[href]',
    '[role="button"]', '[role="slider"]', '[role="progressbar"]', '[role="menuitem"]',
    '[class*="slider" i]',
    '[data-jfp-menu-btn]', '[data-jfp-menu]'
].join(',');

const SURFACE_ROOTS = 'body, html, #reactRoot, .skinBody, .mainAnimatedPages, .page, [class*="pageContent" i]';
```

**改法：**

1. `WIDGET_SELECTOR` —— 加入 PEACH 的控件选择器，保证**点进度条/按钮时不会触发手势**
2. `SURFACE_ROOTS` —— 改成 PEACH 的页面根容器，保证**点在空白/覆盖层上仍算画面**

> **为什么要这两个常量，而不是直接用 `closest()`？**
> 见第六节「坑 1」，这是踩过的真实 bug。

### 3.3 验证命中判定

改完后，在 `config.json` 设 `"debug": true`，重启，然后在播放画面上滑一下，
日志会打出：

```
down(x,y) <DIV class="..."> video=true surface=true
```

- `surface=false` 且你确实点在画面上 → `SURFACE_ROOTS` 少了容器，或 `WIDGET_SELECTOR` 误命中
- `video=false` → 页面里没有 `<video>`，回到第二节

**这一行日志是排查手势失效的第一入口**，务必先让它变成 `surface=true`。

### 3.4 虚拟按键与字幕（几乎不用改）

| 模块 | 是否需要改 |
|---|---|
| 虚拟按键（◀ ▶ ↩ / ▲ ▼ ↩）| 不用改，位置是 `position:fixed` 绝对定位 |
| 长条工具栏（▭ ☰）| 不用改 |
| 实时字幕层 | **不用改**，它只依赖 `<video>` 的 `currentTime` |

字幕的媒体识别逻辑（`sttResolveMedia`）是 Jellyfin 专用的（读 URL hash、查 `/Sessions`），
如果要在 PEACH 上跑字幕，这部分要重写 —— 但**手势不需要它**，可以先不管。

---

## 四、架构速览（理解后再动手）

```
jellyfin-player.exe  (Electron 主进程)
    │
    ├── BrowserWindow 加载 serverUrl
    │       └── src/preload.js  ← 全部手势/按键/字幕逻辑都在这里
    │               ├── 手势引擎（mousedown/mouseup 捕获阶段）
    │               ├── 虚拟按键层
    │               ├── 长条工具栏
    │               └── 字幕渲染层
    │
    └── IPC
            ├── gesture-config  同步下发配置
            ├── gesture-log     回传日志
            └── stt:*           字幕服务（可选，Python 子进程）
```

**关键设计：所有交互逻辑都在 preload 里**，主进程只负责创建窗口和转发 IPC。
所以适配新系统**不需要碰 `src/main.js`**（除非要改注入方式）。

---

## 五、手势判定流程（改选择器前务必读懂）

```
mousedown (捕获阶段)
    │
    ├─ 点在左边缘 48px 内？
    │      → 登记为「返回手势候选」（不受画面限制，列表页也能用）
    │
    └─ 否则：findVideo() 找到可见 <video>
            │
            └─ isVideoSurface(target, video, x, y)
                    │
                    ├─ target 就是 video 或在其内部 → true
                    │
                    ├─ 从 target 逐级向上走：
                    │     命中 SURFACE_ROOTS  → break（是画面）
                    │     命中 WIDGET_SELECTOR → false（是控件）
                    │     走到 body/documentElement 还没命中 → 视为画面
                    │
                    └─ 兜底：坐标必须落在 video 的 boundingClientRect 内
```

**这里是整个项目最容易出错的地方**，第六节坑 1 详细说明了原因。

---

## 六、已知坑（都是实际踩过的，别重复）

### 坑 1：`closest()` 会让手势全部失效

**现象**：所有滑动都没反应，日志显示 `surface=false`。

**原因**：原本用 `target.closest(WIDGET_SELECTOR)` 判断是否点在控件上。
但 `closest()` 会一路查到 `<body>`，而 Jellyfin 播放时 `<body>` 恰好带有
`hide-scroll` 之类的 class，被当成"控件"，于是**每次都判定为点在控件上**。

**现在的做法**：改成逐级向上遍历（`parentElement`），
遇到 `SURFACE_ROOTS` 就停（说明是页面容器，不是控件）。

**移植时注意**：`SURFACE_ROOTS` 必须包含 PEACH 的页面根容器，
否则会重现同样的 bug。

### 坑 2：Moonlight 必须开 Direct Touch 模式

Trackpad 模式只产生 `mousemove`，**没有 `mousedown`/`mouseup`**，手势必然失效。
这不是代码问题，是客户端设置。

### 坑 3：滑动会触发播放器自己的暂停

Jellyfin 12.x 把「单击暂停」绑在 `pointerdown` 上，并有 300ms 延时。
滑动手势会被它拦截，导致"滑完就暂停"。

**现有解法**（如果 PEACH 有类似行为，可复用）：
- 在**捕获阶段**拦下 `pointerdown` 并 `stopPropagation()`
- 单击回放时，手动 `dispatchEvent(new PointerEvent('pointerdown'))` 补发

代码在 `redispatchNativeTap()`。

### 坑 4：连续滑动会重复触发 seek 导致卡顿

每次滑动都设 `video.currentTime`，会反复重缓冲。

**现有解法**：`seekBy()` 里做 250ms 去抖（`cfg.seekDebounceMs`），
期间只记录目标位置，超时才真正跳转一次。

### 坑 5：进度条等控件必须排除

如果不排除，用户拖进度条会被识别成"横滑快进"，行为错乱。
这就是 `WIDGET_SELECTOR` 里要有 `[role="slider"]`、`[class*="slider" i]` 的原因。

**移植时**：先手动测一遍 PEACH 的进度条、音量条、按钮，
确认拖动它们时日志里 `surface=false`。

---

## 七、验收清单（改完逐条过）

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 点视频画面 | 日志 `video=true surface=true` |
| 2 | 点进度条 | 日志 `surface=false`，且进度条能正常拖动 |
| 3 | 横滑右手 | 快进，左下角出现 `⏩ +Ns` 提示 |
| 4 | 横滑左手 | 快退，提示 `⏪ -Ns` |
| 5 | 竖滑上/下 | 音量变化，提示 `🔊` |
| 6 | 左边缘右滑 | 返回上一层 |
| 7 | 单击画面 | PEACH 原生行为（不额外触发） |
| 8 | 双击画面 | 播放/暂停 |
| 9 | 连续快速滑动 | 只跳转一次，不卡顿 |
| 10 | 虚拟按键 | ◀ ▶ ↩ 可点，位置正确 |
| 11 | 工具栏 | ▭ 能开关控制栏，☰ 能开菜单 |

---

## 八、如果要连字幕一起移植（另一件事）

字幕功能比手势复杂得多，涉及：

- Python 子进程（faster-whisper + 翻译后端）
- 媒体识别（现在是 Jellyfin 专用：URL hash、`/Sessions`、`[data-id]`）
- 会话生命周期（换片跟随、缓存、幻觉过滤）

**建议分两步**：先把手势跑通（1–2 小时），字幕单独评估。

如果要动字幕，`sttResolveMedia()` 是必须重写的入口 ——
它决定了"当前播放的是哪部片"，字幕缓存和会话都靠它。

---

## 九、相关文件

| 文件 | 内容 |
|---|---|
| `src/preload.js` | **全部手势/按键/字幕逻辑**，约 1650 行 |
| `src/main.js` | 主进程：窗口创建、IPC、字幕服务管理 |
| `config.json` | 全部可调参数（含手势灵敏度、按键尺寸等）|
| `HANDOFF.md` | 原项目完整交接记录（含字幕部分的深度踩坑）|
| `README.md` | 项目说明与安装步骤 |

---

## 十、给接手者的第一句话

**不要先改代码。** 先做第二节的探测，把四个数字（`video` / `iframe` / `canvas` 数量）
和一张播放页的 DOM 结构截图拿到，再决定方案。

如果探测结果是 `video:1, iframe:0`，这件事很简单；
如果是 `video:0` 且播放器在跨域 iframe / canvas 里，**及时止损，换思路**。
