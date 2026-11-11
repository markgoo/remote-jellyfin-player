# 交接说明(写给在目标机上继续开发的 AI)

> 你在目标机 `<JELLYFIN_HOST>`(MGENTSRV1,Jellyfin 12.1.0 + Sunshine)上工作。
> 本项目是"Jellyfin 手势播放器":Electron 套壳加载 Jellyfin Web,把 Moonlight
> Direct Touch 转发的鼠标事件识别为手机式手势。源码已推送本仓库,开发机无法
> 访问 Jellyfin(网络不通),真实 DOM 验证只能在**你这台机器**上完成——这是你的首要任务。

## 0. 必读文件

1. `Jellyfin手势播放器-技术说明.md` —— 完整技术规格、实测数据、已否决方案(**不要重复弯路**,见其 §12)
2. `docs/deploy.md` —— 部署/配置/Moonlight 设置/排查
3. `src/preload.js` —— 手势引擎(核心,~250 行,先通读)
4. `src/main.js` —— 主进程

## 1. 当前状态

| 项 | 状态 |
|---|---|
| 手势引擎 + 自测 | ✅ `--local-test --selftest` 输出 `SELFTEST PASS`(真实 exe 验证) |
| 打包产物 | ✅ `dist/win-unpacked/`(已含下述两处修复) |
| **真实 Jellyfin 12.1 DOM 验证** | ✅ **已完成**(2026-11-10,目标机 MGENTSRV1,8/8 通过) |
| 用户反馈的两个故障 | ✅ 均已定位并修复,见 §2 |

### 已修复的两个真实故障(2026-11-10)

> 两处都只在真实 Jellyfin 播放页才暴露,本地 local-test 页永远测不出来。

**① 没有 ✕ 退出按钮 — `installExitButton is not defined`**

`src/preload.js` 里原本写成**具名函数表达式**再立即调用:

```js
(function installExitButton() { ... })();   // ❌ 名字只在函数体内可见
```

外层作用域的 `installExitButton` 根本不存在,于是每秒执行的自愈定时器
(`setInterval(... installExitButton() ...)`)每次都抛 `ReferenceError`,
按钮永远挂不上。控制台每秒刷一条同名报错,极易看出。
**已改为函数声明** `function installExitButton() {...}` + 首次调用。

**② 播放时左右滑动无效 — 手势面永远判成控件**

`isVideoSurface()` 原来用 `target.closest(WIDGET_SELECTOR)`,而 `closest()`
会**一路查到 `<body>`**。Jellyfin 播放时 `<body>` 的 class 是:

```
BODY.[libraryDocument mouseIdle hide-scroll]
```

旧的 `WIDGET_SELECTOR` 含 `[class*="scroll" i]`,于是**任何一次点击都被判成
"点在小部件上"**,`surface` 恒为 `false`,全部滑动手势失效。

实测日志(修复前,真实播放页):
```
down(633,329) <DIV class="page libraryPage mainAnimatedPage"> video=true surface=false
```

**修复要点**(见 `src/preload.js`):
- 删掉 `[class*="scroll" i]` / `[class*="menu" i]` / `[class*="header" i]` 等泛化关键词,
  `WIDGET_SELECTOR` 只留 `button/input/select/textarea/a[href]/role=[...]/[class*=slider i]/[data-jfp-exit]`;
- 判定改为**逐级向上遍历**到 `video`/`body`/`documentElement` 即停,不再无脑 `closest()`;
- 新增 `SURFACE_ROOTS` 白名单(body/html/#reactRoot/.skinBody/.mainAnimatedPages/.page 等),
  避免整层页面容器被误判;
- 教训:**永远不要把整页级容器 class 放进控件黑名单**。

### 真实播放页 DOM 结构(实测,改代码前先看)

```
BODY.libraryDocument.hide-scroll.mouseIdle          ← 旧的 scroll 关键词在这里踩雷
└ MAIN / #reactRoot
  └ DIV.skinBody
    └ DIV.mainAnimatedPages.skinBody
      └ DIV#videoOsdPage.page.libraryPage.mainAnimatedPage   ← 画面中心命中的就是它
        └ video [0,0,1266,657] readyState=4                 ← 铺满,blob: 源
```

- 画面中心命中 `#videoOsdPage`,**不是** `<video>`;所以不能用"目标是不是 video"来判定;
- 12.1 播放页**没有** `.videoOsd` 这个 class(`hasVideoOsd=false`),旧假设不成立;
- 进度条是 `input[type=range]` + `.sliderContainer`,靠 `input`/`[class*=slider]` 就能排除。

### 播放路由的坑(写自动化测试必读)

Jellyfin 12.1 用 React Router:
- 直接设 `location.hash = '#/video?id=...'` → **不重新挂载**,停在原页;
- 加载 `#/video?id=...` → 被重定向回 `#/home`;
- 可用路径:`#/details?id=<id>` → 点 `.btnPlay` → 进入 `#/video`。
- 注意别用 `[class*="play" i]` 找播放按钮,会先命中 `videoPlayerContainer`。

## 2. 怎么复验(可重复执行的验收)

仓库内有 `tools/probe-app/`(探针,不进打包产物),它用**真实 preload** 加载真实
Jellyfin、派发**真实输入事件**,把结果写成 `.verify-out.json`:

```powershell
# 1. 造一个可写运行时(把探针塞进 resources/app 覆盖 asar)
robocopy dist\win-unpacked .final-check /E /XD resources
mkdir .final-check\resources\app
copy tools\probe-app\main.js .final-check\resources\app\main.js
# package.json 的 main 改成 main.js 后启动:
$env:JFP_REPO='C:\AI\jellyfinplayer'
.final-check\jellyfin-player.exe --no-sandbox --user-data-dir=.userdata `
  --probe-verify --item <JellyfinItemId>
```

期望输出(全部 PASS 即通过):
```
PASS 提示浮层存在 / 提示在左下角 / 提示字号不显眼(<=16px)
PASS 左边缘右滑触发返回逻辑 / 首页时提示"已在首页"而非误跳
PASS 边缘短滑(<100px)不触发返回 / 边缘垂直拖动不触发返回
PASS 详情页左边缘右滑可返回上一层
PASS 右滑后仍在播放(不暂停) / 左滑后仍在播放(不暂停)
PASS 短滑快进少 / 中滑快进中 / 长滑快进多且不超上限 / 越远快进越多
PASS 单击仍触发原生暂停
```

> 取 ItemId:`GET /Items?Recursive=true&IncludeItemTypes=Movie&Limit=3`,
> 带请求头 `Authorization: MediaBrowser Token="<AccessToken>", Client="x", Device="x", DeviceId="x", Version="1.0.0"`。
> AccessToken 可从 `%APPDATA%\jellyfin-player\Local Storage` 里的已登录凭证拿,或看启动日志
> 的 `Stored JSON credentials`。

### 目标机调试的两个环境坑

1. **`ELECTRON_RUN_AS_NODE=1`** 会让 exe 变成纯 Node 运行,报 `bad option: --remote-debugging-port`。
   启动前清掉:`Remove-Item Env:ELECTRON_RUN_AS_NODE`。
2. Electron 需要写 `%APPDATA%`,在受限环境里会崩在
   `platform_channel.cc(89) Check failed: 拒绝访问 (0x5)`。用
   `--user-data-dir=<仓库内目录>` 并确认该目录可写即可。

## 3. 原故障排查记录(保留,供参考)

**症状 = 无按钮 + 无手势 + 单击是 Jellyfin 原生行为**。现在已知根因就是上面 ①②,
不必再怀疑"跑的是旧版 zip"。

## 4. 手势引擎设计决策(改代码前必读,这些是踩过坑的)

1. **手势面判定 = 坐标落在 `<video>` 画面内 + 从目标逐级向上到 body 都没有命中真正的小部件**。
   - 不要用 `closest()` 一把梭:它会查到 `<body>`,而 body 带 `hide-scroll` 等泛化 class;
   - **教训:绝对不要把 `[class*="osd"]`/`[class*="scroll"]`/`[class*="menu"]` 这类
     整页级关键词加回 `WIDGET_SELECTOR`** —— 两次事故都是这么死的(第一次 osd 覆盖层,
     第二次 body 的 hide-scroll)。
2. `WIDGET_SELECTOR` 只放真正的小部件:`button/input/select/textarea/a[href]/role=[...]/[class*=slider]`。
   若实测发现某控件没被排除,往里**加具体选择器**,不要放宽判定逻辑。
3. 单击/双击管线:单击先扣 300ms,无第二击则**重放原生事件序列**;第二击=播放/暂停,
   并拦截原生 dblclick;拖动手势结束后 150ms 内吞 click。
4. `findVideo()` 每次手势重新查询(播放器会重建 video);静音视频排后面。
5. preload 契约:执行时 `documentElement` 可能为 null(打包环境实测),已有守卫,别去掉。
6. **preload 里不要写 `(function name(){...})()` 再在外层按名字调用** —— 具名函数表达式
   的名字不进入外层作用域,会静默失败并每帧刷 `ReferenceError`。
7. 反馈靠 toast(屏幕上方 18%);所有动作写 `jellyfin-player.log`。
8. 右上角 ✕ 按钮:点按=退出,按住拖动=挪位;每秒自愈重挂。
   它是 `button` 且带 `data-jfp-exit`,天然被排除在手势外。

## 5. 用户已拍板的交互(不要再问)

- 单击画面 = Jellyfin 原生行为(不劫持);双击 = 播放/暂停
- **快进是按距离折算的**(`seekMode: "scaled"`,默认):滑得越远快进越多,
  但夹在 `seekMinSeconds`(默认 5s)~ `seekMaxSeconds`(默认 60s)之间,
  且不超过片长一半。锚点:每 `pixelsPerStep`(默认 250px)= `seekStepSeconds`(10s)。

  | 滑动距离 | 80px | 250px | 500px | 1000px | ≥1500px |
  |---|---|---|---|---|---|
  | 快进 | 5s(下限) | 10s | 20s | 40s | 60s(上限) |

- **左边缘向右滑 = 返回上一层**(`enableBackGesture`,默认开):热区 `backEdgeWidthPx`(48px),
  最小水平位移 `backSwipeThresholdPx`(100px),且需基本水平(横向 > 纵向×1.2)。
  首页没有上一层时提示"← 已在首页",不会误跳。
- 反馈提示在**左下角、15px 半透明小字**(刻意低调,不挡画面、不抢 OSD)。
- **右上角是「☰ 选项」按钮**(不再是 ✕):
  - 点按 = 弹出菜单(`⚙ 设置` → `#/mypreferencesmenu`,`⏻ 退出` → 退出应用)
  - 按住拖动 = 挪位置(避免挡住 Jellyfin 自带控件),位置存在 `localStorage: jfp-menu-pos`,
    重挂/重载后自动恢复,换分辨率会被夹回屏幕内
  - 拖动不会误触发菜单;菜单点空白处或再点按钮即收起
- **Jellyfin 自带控件放大**(`enableBigControls`,默认开)——**只放大控件热区,不放大界面**:

  | 控件 | 原始 | 放大后 |
  |---|---|---|
  | OSD 按钮 | 41×41 | **60×60** |
  | 进度条高 | 28px | **46px** |
  | 滑块手柄 | 默认 | 28px |
  | 控制栏总高 | 223px | 242px(+8.5%) |
  | **界面字号** | 14.88px | **14.88px(不变)** |

  参数:`osdButtonMinPx`、`sliderHeightPx`、`sliderThumbPx`。
  实现只注入按钮/进度条的 `min-width`/`min-height`/`height`,
  **不动 `html` 根字号、不动字号与间距**,所以版面、文字、卡片尺寸保持 Jellyfin 原样。

  > 踩过的弯路:最初用「抬 `html` 根字号」的整体缩放(`uiScale`),虽然也能把按钮
  > 放大到 60px,但会把整个界面(字号、卡片、控制栏)一起放大,控制栏涨到 274px
  > 占屏 40%。用户明确要的是**只放大控件**,已改为现在这套定向方案。
  > **不要再用根字号缩放**。
- 手势参数全部在 `config.json`(与 exe 同目录),改完重启生效

## 5.1 与 Jellyfin 原生事件的冲突(踩过坑,改手势必读)

Jellyfin 12.1 播放器的「单击暂停」绑在 **`pointerdown`** 上,且是 300ms 延时执行:

```js
addEventListener(view, "pointerdown", e => {
  case "mouse": e.button || (U ? (clearTimeout(U), U=0)
                              : U = setTimeout(() => { y.f.playPause(j); }, 300));
})
```

引擎原来只拦 `click`,于是:按下 → 挂定时器 → 拖动 150ms → 抬手快进 → **300ms 后定时器仍把视频暂停**,
表现为"滑动后暂停,再滑动又恢复"。

**现在做法**:在 `pointerdown` 捕获阶段 `stopPropagation()`,从源头不让 Jellyfin 起那个定时器。
配套两点缺一不可:
1. 自己重放单击时**必须补发 `PointerEvent('pointerdown')`**,否则 Jellyfin 的单击暂停就没了;
2. 补发的 pointerdown 必须被 `if (redispatching) return;` 放行,否则会被自己的拦截器吃掉。

> 这三条是一组,改任意一条都要重跑 §2 里「单击仍触发原生暂停」的检查。

## 6. 目标机构建须知

- 本机 Schannel 损坏(`curl`/`Invoke-WebRequest` 不能走 HTTPS),但 **Node 用 OpenSSL,大概率正常**(.npmrc 已配 npmmirror 镜像)。
- 优先级:**直接用拷来的 zip 运行** > 本机 `npm install && npx electron .`(若 TLS 报错别死磕,回退 zip)。
- Node v22.18.0 已装。物理键盘调试键:F11 全屏 / Ctrl+R 重载 / F12 DevTools / Alt+F4 退出。

### 只改 `src/` 时的快速打包(不需要联网)

`npx electron-builder` 每次都想重新下载 Electron,在受限环境会失败
(`mkdir ...\AppData\Local\electron: Access is denied`)。若 Electron 运行时已存在
(`dist/win-unpacked/` 里那份),只需替换 `resources/app.asar`:

```powershell
# 1. 造 asar(只含 src/test/package.json)
mkdir .build-app
copy src .build-app\src -Recurse
copy test .build-app\test -Recurse
# package.json 里 "main": "src/main.js"
copy package.json .build-app\package.json
node -e "require('@electron/asar').createPackage('.build-app','.build-app.asar')"

# 2. 替换进产物
copy .build-app.asar dist\win-unpacked\resources\app.asar -Force
```

验证替换成功:

```powershell
node -e "const a=require('@electron/asar');const c=a.extractFile('dist/win-unpacked/resources/app.asar','src/preload.js').toString();console.log(c.includes('SURFACE_ROOTS'))"
```

## 7. 部署状态(2026-11-10 已完成)

| 项 | 位置/状态 |
|---|---|
| 应用产物 | `C:\Program Files\JellyfinPlayer\`(含 `config.json`、`jellyfin.png`) |
| Sunshine 条目 | `apps.json` 已有 `Jellyfin`,cmd 指向上面那个 exe |
| 服务 | `SunshineService` Running,端口 47989/47984/47990 均监听 |
| `config.json` | `debug: true`(排查期开启,稳定后可改回 false) |

**部署时踩到的坑(重要)**:Sunshine 以 `LocalSystem` 运行,首次启动报
`Couldn't run ... Permission denied`。原因**不是** exe 的 ACL(与 sunshine.exe 一致),
而是 **`Program Files\JellyfinPlayer` 目录不可写** —— 应用要在 exe 旁写
`jellyfin-player.log` 和 Electron 运行时缓存。已给 `SYSTEM`/`Users` 授予写权限:

```powershell
$acl = Get-Acl 'C:\Program Files\JellyfinPlayer'
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  'NT AUTHORITY\SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl 'C:\Program Files\JellyfinPlayer' $acl
```

验证方式:用 `schtasks /RU SYSTEM` 以 SYSTEM 身份跑,日志出现
`gesture engine ready` + `surface=true` + `SELFTEST PASS` 即成功。

> 注意:`C:\AI\jellyfinplayer\dist\win-unpacked\` 是构建输出,部署副本在
> `C:\Program Files\JellyfinPlayer\`。改代码后两个地方都要更新。

## 8. 验收清单(技术说明 §9,全部通过才算完)

1. 启动:全屏瀑布流、无边框、无鼠标指针
2~3. 点封面进详情、点播放正常
4~8. 播放中:右滑快进 10s / 左滑快退 10s / 上滑音量+ / 下滑音量− / 双击暂停(每次有 toast)
9. 拖底部进度条不触发手势
10. 手机 Moonlight(Direct Touch 开)重复 4~9,无可见指针,✕ 可退出
11. 流量:4Mbps 下浏览+播放 60 秒 ≈ 30MB

> 1~8 已在目标机自动化验证通过(`tools/probe-app/`,见 §2)。
> **10、11 仍需真机 Moonlight 手测** —— 自动化测不到触摸转发与流量。

## 9. 实时语音字幕(预取方案,已验证可行)

目标:对**视频里的语音**做实时识别 + 翻译,不依赖任何字幕文件(类似 iOS 26 Live Translation)。

### 结论:预取方案成立,余量充足

播放时后台并行"预取未来 10 秒音频 → 识别 → 翻译",因为 Jellyfin 的流**可寻址**,
任意时间点的音频都能立刻切出来,**完全不需要自写播放器**。

实测(1280x720, RTX 4060 Ti, large-v2):

| 环节 | 耗时 |
|---|---|
| ffmpeg 切 10 秒音频 | 0.04s |
| Whisper large-v2 识别 | **1.5s**(6.5x 实时) |
| qwen3.5:9b 批量翻译 | **1.6~2.2s** |
| 合计 | **3.1~3.9s** |

**字幕稳定领先画面 6 秒以上** → 播放时零等待。

### 组件与路径

```
tools/stt/bench.py            识别基准(窗口/整段)
tools/stt/live.py             端到端原型:预取→识别→翻译
.stt/venv/                    Python 环境
C:\AI\VideoCaptioner-...\VideoCaptioner\AppData\models\faster-whisper-large-v2
                              复用的模型(2.9GB,已在用)
```

### 踩过的坑(照着做能省几小时)

1. **`pip install faster-whisper` 会误拉 torch(4GB+)**
   faster-whisper 用 `ctranslate2`,**不需要 torch**。正确装法:
   `ctranslate2` + `numpy` + `pyyaml` + `av` + `tokenizers` + `onnxruntime` + `huggingface_hub`,
   最后把 faster-whisper 的 wheel **直接解压**到 site-packages(本机 pip 有卡死 bug)。
   卡死时会残留高 CPU 的 python 进程占着文件锁,必须杀掉再重试。

2. **GPU 必须补 cuBLAS + cuDNN**
   只装 ctranslate2 会报 `Library cublas64_12.dll is not found`。
   装 `nvidia-cublas-cu12`(736MB)+ `nvidia-cudnn-cu12`(1058MB),
   并**必须把它们的 bin 目录加进 PATH**:
   ```
   .stt/venv/Lib/site-packages/nvidia/cublas/bin
   .stt/venv/Lib/site-packages/nvidia/cudnn/bin
   ```

3. **最大的坑:模型必须常驻**
   每次 `transcribe()` 重新初始化要 5 秒,曾把 10 秒音频测成 27 秒。
   模型加载一次常驻内存后,同样的音频只要 1.5 秒。

4. **`beam_size=1` 比 5 快 3 倍**,质量差异很小;`vad_filter` 对已切好的窗口无收益。

5. **批量翻译比逐句快 2~3 倍**:一次请求翻整个窗口,按编号解析回。

### 模型选择(实测)

| 模型 | 耗时 | 质量 |
|---|---|---|
| `qwen3:0.6b` | 1.38s | ❌ 完全不翻译,原样返回日文 |
| **`qwen3.5:9b`** | **1.64s** | ✅ 最优,选它 |
| `deepseek-r1:14b` | 11.96s | 慢 7 倍,质量无提升 |
| `qwen3:30b-a3b` | 20s | 慢 12 倍,有误译 |

> 更大的模型会吃光 10 秒窗口的余量。9B 是"够快且质量达标"的平衡点,
> 与 iOS 用 3B 级专用模型的思路一致——不是越大越好。

### 为什么 large-v2 不能换成 whisper.cpp small

标点还原是决定性的:

```
whisper.cpp small:  できたからねいやいやいやマジで待ってください(无标点)
faster-whisper v2:  いやいや、話しといてください。マジっすか。めちゃめちゃ頑張るんで。
```

没有标点 → 断句靠猜 → 翻译质量崩。**必须用带标点还原的 faster-whisper。**

### 待做与已做

**已接进播放器**(2026-11-11):
- `☰` 菜单里加了「🌐 实时字幕：开/关」开关
- 双语叠层渲染:日语原文(小字,72% 不透明)在上、中文译文(大字)在下
- 主进程管 Python 服务子进程,IPC 通道:`stt:ensure/start/position/cues/stop`
- 部署时 `tools/stt/` 与 `.stt/venv/` 必须和 exe 一起拷(主进程按 exe 位置找)

**实现要点(踩过的坑)**:

1. **播放页地址不带 id**:`#/video` 没有 `?id=`,地址栏抓不到媒体 Id。
   解决:优先查 `/Sessions` 接口的 `NowPlayingItem`,用 `hashchange` 记住详情页 id 兜底。

2. **Jellyfin 12.1 不接受 URL 里的 `api_key` 参数**(实测 400)。
   必须用 `Authorization: MediaBrowser Token="..."` 请求头;
   给 ffmpeg 时用 `-headers` 传。

3. **服务启动要等就绪**:模型加载 5s + 预热 1s,期间 `fetch` 会
   `fetch failed`。必须轮询 `/health` 通过后再发 `/start`。

4. **预热不能每次重做**(实测坑):原实现每次 `/start` 都重新预热
   11~18 秒,这是"点开关很久没反应"的主因。
   现在预热只在模型加载后用**静音音频**做一次(0.6s),用户点开关前就已完成。

5. **会话线程不能太早启动**(单元测试发现的真实缺陷):
   线程在 `__init__` 里启动的话,那一刻它还没被登记为 `STATE['session']`,
   会误判"我不是当前会话"而立刻退休。必须**先登记再 `start()`**。

### 会话生命周期设计(核心,别改乱)

之前是"打补丁":换片靠客户端比对 id、停止靠 `stop_flag`,
结果是换片不跟随、关掉后线程还在跑。现在统一成一套语义:

```
Session
  ├ id          唯一编号 s{n}-{ts}
  ├ mediaKey    身份标识(itemId 优先),客户端与服务端用同一个值
  ├ _alive()    三重校验:未退休 + 仍是 STATE['session'] + 媒体未变
  └ retire()    标记退休,线程在下一个检查点立刻退出
```

**关键规则**:
1. `_alive()` 在**每个耗时步骤后**都要检查(切音频 / 识别 / 翻译之后),
   不能在旧片上继续烧 GPU。
2. 客户端每 500ms 做一次「对账」(`sttReconcile`),只看四种情况:
   不在播放页 → 停;itemId 变了 → 换;一致 → 只报位置;识别不到 → 不动。
3. `/start` 幂等:同一 `itemId` 重复调用**复用会话**,不重建、不重算。
4. `/position` 带 `mediaKey`;与服务的值不一致 → 回 `needRestart`,客户端据此重建。
5. 线程 **先登记再 start()**,否则会秒退。

**测试**:
```
tools/stt/test_session.py   会话生命周期单元测试(18 项,不需要 GPU)
tools/stt/test_e2e.py       换片/复用/停止端到端(15 项,用真实流)
```

### 滑动卡顿与字幕错位(2026-11-11 修复)

用户反馈:滑几次之后开始卡顿,滑多了字幕会不匹配。

**① 卡顿 = 连续 seek 反复重缓冲**

每次 `video.currentTime = x` 都会让解码器重新定位 + 重新缓冲。
连滑 4 次就是 4 次重缓冲,观感就是"越滑越卡"。

修法(`src/preload.js` `seekBy`):**去抖合并**。
滑动只累加"待跳秒数"并给 toast,`seekDebounceMs`(默认 250ms)内没有新滑动
才真正执行一次 seek。连续滑动 = 一次跳转,只重缓冲一次。

**② 字幕错位 = 跳转后预取没重排**

`_loop` 里的判断顺序踩了坑:
```python
if done >= target: 休息   # ← 这个在前面
if 跳转: 重新对齐          # ← 永远走不到
```
用户往回拖时 `done`(很远) 恒 >= `target`(很小),循环一直休息,
**跳转永远检测不到** → 字幕一直按旧位置生成 → 错位。

修法:把**跳转判断提到休息判断之前**,并按窗口边界对齐:
```python
if done < pos - back_tol or done > pos + fwd_tol:   # 先判跳转
    self.done_until = (pos // window) * window      # 对齐到窗口边界
    continue
if done >= target: 休息                              # 再判休息
```
容差 `back_tol = lookahead*0.5`、`fwd_tol = lookahead + window*2`,
避免正常播放(本来就领先一个 lookahead)被误判成跳转。

**③ seek 后要立刻同步位置**

客户端原来只在 500ms 对账时上报位置,seek 后这段时间服务端仍按旧位置生成。
现在 seek 执行后**立刻** `stt:position` 上报新位置。

**测试**:
```
tools/stt/test_jump.py      跳转对齐(前向/回退)
tools/stt/test_seek.py      连续跳转与字幕覆盖
```

### 手机屏偏小的两项改进(2026-11-11)

用户反馈:手机上界面元素还是太小,且希望有虚拟按键。

**关键发现:桌面是 2196×1270,不是 1366×768。**
60px 的按钮在 2196 宽下只占 2.7%,串到手机小屏上就是很小。
所以尺寸参数要按"占屏比例"来想,不能按绝对像素。

**① 界面整体放大 `uiScale`**

之前只有"定向加热区"(按钮变大、界面不变)。手机上文字/卡片也太小,需要整体放大。

```json
"uiScale": 1.25           // 根字号 14.88px → 18.56px,卡片/文字一起变大
"osdButtonMinPx": 72,     // ×1.25 = 90px
"sliderHeightPx": 56,     // ×1.56 = 70px
"sliderThumbPx": 34,
"menuButtonSizePx": 64
```

**踩过的二次坑**:只抬 `html` 根字号会让**固定 px 的图标相对变小**。
所以 `uiCss()` 里图标尺寸也要乘 `scale`,并且 OSD 图标要用更高优先级覆盖通用规则。

**② 虚拟按键(不依赖滑动,直接点)**

按**场景**挂不同按键,离开场景自动消失:

| 场景 | 按键 | 位置 | 行为 |
|---|---|---|---|
| 播放页(有 `<video>`) | `◀` | 左侧垂直居中 | 快退(复用 `seekBy`) |
| | `▶` | 右侧垂直居中 | 快进 |
| | `↩` | 左上 | 返回(复用 `goBack`) |
| 浏览页(无 `<video>`) | `↩` | 左上 | 返回 |
| | `▲` | 左侧中上 | 向上滚动 |
| | `▼` | 左侧中下 | 向下滚动 |

- 尺寸 `navButtonSizePx`(108px)、透明度 `navButtonOpacity`(0.34)
- **▲▼ 可以单独放大**:`navScrollButtonSizePx`(150px)、间距 `navScrollGapPx`(24px)。
  滚动键使用频率高、手指面积需求大,所以和 ◀▶↩ 分开配置。
  实测:▲▼ 150×150 / 字号 63px,其余 108×108 / 字号 45px。
- ▲▼ 的位置按"一对"整体居中计算(不是各自相对屏幕中心偏移),
  这样放大后不会挤在一起或偏到一边。
- **每个都可拖动**,位置存 `localStorage: jfp-pos-{back,prev,next,up,down}`
- 靠 1s 自愈定时器维持,`navScene()` 判断当前场景

**滚动容器的坑(重要)**:

Jellyfin 的滚动容器**不固定**,实测:
- 电影/列表页真正可滚的是 **`<body>`**(`overflow-y:auto`,over=5643)
- `html` 的 scrollHeight 同样大,但 `overflow:visible`,**不能滚**
- 首页在内容加载完之前 `scrollHeight == clientHeight`,**根本不可滚**

所以 `findScrollContainer()` 按"实际可滚量 + overflowY"来找,候选里必须包含
`body` / `#reactRoot` / `documentElement` / `scrollingElement`,不能只查 `.page`。

**另一个坑**:`body` 设了 overflow:auto 时,`body.scrollTop` 常恒为 0,
真实滚动量记在 `document.documentElement.scrollTop`。所以读位置要三方取最大,
滚动时也要同时 `window.scrollBy` 兜底。

### 手机端参数化建议

这些数值都是按 2196×1270 桌面调的。若换分辨率或觉得不够大,按比例调:

```
uiScale         1.25 → 1.4    (界面再放大一档)
navButtonSizePx 108  → 140    (虚拟按键)
osdButtonMinPx  72   → 90
subtitleFontPx  38   → 46
```

### 字幕与画面对不上 = Whisper 幻觉(2026-11-11 修复)

用户反馈:播到某段之后,字幕内容和画面完全对不上。

**根因**:Whisper 在弱语音/静音段会"脑补"训练数据里的片尾字幕。
实测同一段音频,识别出的内容与实际内容无关:

| 时间 | 实际内容 | Whisper 输出 | 判断 |
|---|---|---|---|
| 240s | 弱语音 | `お疲れ様でした` | ❌ 幻觉 |
| 270s | 弱语音 | `次回予告` | ❌ 幻觉 |
| 228s | 弱语音 | `ご視聴ありがとうございました` | ❌ 幻觉 |
| 300s | 正常对话 | 4 句对话 | ✅ |

这些幻觉的**识别耗时也异常快**(0.4s vs 正常 1.5s),可作为旁证。

**修复:四层过滤,全部可配置**

`tools/stt/server.py` 的 `is_hallucination()`,判据按顺序短路:

| 判据 | 默认值 | 说明 |
|---|---|---|
| 说话人标记 | `★ ☆ 「 『 ♪` | **有标记就保留**,不参与过滤 |
| 同句重复 | `>= 2` 次 | 循环幻觉(实测「大きな声がする」连出 3 次)|
| 幻觉词表 + 置信度 | `< -0.35` | 片尾语/订阅引导 |
| 绝对置信度 | `< -1.05` | 极端模糊 |
| 静音概率 | `> 0.6` 且 lp `< -0.35` | 基本没人说话 |

**防误杀的关键**:实测发现真实台词(带 `★` 说话人标记)置信度也可能低到 -0.91,
所以标记检测必须在最前面短路返回 `False`。这条是踩过坑的,别删。

**配置项**(`config.json`,发布默认值已实测):

```json
"sttFilterEnabled": true,               // 总开关
"sttFilterPhraseLogprob": -0.35,        // 命中词表时的置信度门限
"sttFilterMinLogprob": -1.05,           // 绝对置信度下限
"sttFilterMaxNoSpeech": 0.6,            // 静音概率上限
"sttFilterSpeechNoSpeechLogprob": -0.35,// 高静音概率下的置信度门限
"sttFilterMaxRepeat": 2,                // 同句重复次数上限
"sttFilterPhrases": [ ... 14 条 ... ],  // 幻觉词表,可自行增删
"sttFilterMarkers": ["★","☆","「","『","♪"]  // 带这些标记视为真实
```

设置面板里也有「字幕过滤(消除幻觉)」分组,可直接调数值。

**配置链路**:`config.json` → preload `sttStartPayload().filter` → IPC → HTTP `/start`
→ `apply_filter_config()`。传 `None`/`{}` 会**重置为默认**而不是沿用上次值
(否则用户关掉过滤后重开会话,config 写着开启却不生效,会让人困惑)。

**实测效果**:过滤掉 8 条幻觉、保留 12 条真实对话,包括之前被误杀的
`★おうくん、何を見ているの?★`,零误杀。

### 字幕磁盘缓存(2026-11-11)

用户要求:同一部片重看时字幕不用重新算。

**实现**:`tools/stt/server.py` 的 `cache_load/cache_save/cache_clear`

- 按 `itemId` 分文件存 `.stt/cache/<itemId>.json`
- 结构 `{itemId, updated, count, cues:[{start,end,text,zh,logprob}]}`
- **原子写入**:先写 `.tmp` 再 `os.replace`,崩溃不留半截文件
- **命中即跳过**:启动时读缓存,`done_until` 直接推到已缓存区间末尾,不重算
- **节流落盘**:每 5 秒一次(避免每窗口重写整个 JSON),退出时补一次
- **安全**:itemId 只允许字母数字/`-`/`_`,防路径穿越;坏文件当没有,不抛异常
- **上限**:单文件 8MB,超了不再追加

**实测**:
```
第一次: cacheHit=0,  cues=11        ← 真算
停止:  退出前已保存缓存 11 条
第二次: cacheHit=11, done=80s       ← 秒出,不重算
```

**配置**:`sttCacheEnabled`(默认 true),也传 `cache:false` 可单次禁用。
接口:`POST /cache/info`(查,不传 itemId 则列全部)、`POST /cache/clear`。

**踩过的坑**:

**① 缓存让续算点跳飞(最严重)**

原实现:`done_until = max(start_from, 缓存末尾)`。

问题:缓存只覆盖过 1787s 附近(上次看到那儿),这次从 **0** 开始播,
`done_until` 被拉成 1787 → 片头 0~1786s **永远算不到**。日志实测:

```
会话建立 from=1787s        ← 被缓存拉飞
窗口 t=1787s, 150s, 30s    ← 起点乱跳,片头全丢
```

修法:`_contiguous_end_from()` —— 从**当前播放位置**往后找"缓存连续覆盖到哪",
遇到空洞就停。实测:缓存有 0~100 和 1780~1800、从 0 起播 → 返回 100,
不会被 1780 的缓存骗走。

**② 预取只往前推进,补不上前面的空洞**

即使起点对了,从 30s 开始播时 0~30s 已经过去,永远不会回补。

修法:`_find_gap_before()` + 回补状态机。会话开始后先检查"当前位置之前
有没有大段没被 cue 覆盖的区间"(>2 个窗口),有就优先补,补到当前位置
再恢复正常跟随。

**③ 播放器销毁/换片瞬间 `currentTime` 变 0**

被误判成"用户拖回开头",预取窗口被拉回 0s,字幕错乱。
现在:刚才还在 30 秒外、突然贴近 0 → 先忽略一次,连续两次才认。

**② 预取只往前推进,补不上前面的空洞**

**分两版做过,第一版是错的,记下来别重犯:**

- **错误做法**:会话开始时检查"当前位置之前有没有洞",有就**优先**回补。
  实测:从 2940s 续播的 54 分钟片,去补 0~2940s 需要约 5 分钟,
  用户 3 秒后就离开了,一帧字幕都没算出来。

- **正确做法(现在)**:`_next_backfill()` + **只吃空闲时间**。
  优先级严格是:① 追进度(落后于 pos 时) ② 领先够了才回补 ③ 正常往后预取。
  范围 `sttBackfillRangeSeconds`(默认 60s,0 = 关闭)。

实测(从 300s 起播):
```
窗口 t=300s, 310s, 320s, 330s, 340s    ← 先追到 340s(领先 33s)
空闲回补 t=250s                         ← 领先够了才回补
空闲回补 t=260s
doneUntil=350 没被回补拉回去
```

**关键坑**:回补窗口结束时**不能**把 `done_until` 往回写,否则正常预取
进度会被破坏,下一次又从头算,无限循环。现在只在 `off+dur > done_until`
时才更新。

## 10. 常用命令速查

```bash
git pull                        # 拿最新源码
npx electron .                  # 直连本机 Jellyfin (127.0.0.1:8096)
npx electron . --local-test     # 本地测试页(拖入视频手动试手势)
jellyfin-player.exe --local-test --selftest   # 无人值守自检(应输出 SELFTEST PASS)
type jellyfin-player.log        # 看手势日志(debug 模式有判定过程)
```
