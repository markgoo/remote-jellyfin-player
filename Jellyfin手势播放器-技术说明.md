# Jellyfin 手势播放器技术说明

> 委托背景：用户希望通过 Moonlight 串流方式观看 Jellyfin 视频，同时保留手机端手势操作（左右滑动快进/快退、上下滑动调音量），以解决 Jellyfin 移动客户端激进预缓冲导致的流量问题。
>
> 本文档所有"已验证"的数据均来自实际环境实测，非推测。

---

## 一、目标

开发一个 Windows 桌面应用（建议 Electron），满足：

1. 全屏加载 Jellyfin Web 界面（`http://127.0.0.1:8096`）
2. 隐藏鼠标指针
3. 在视频播放区域识别鼠标拖动方向，映射为播放器操作：
   - 水平左滑 → 快退 10 秒
   - 水平右滑 → 快进 10 秒
   - 垂直上滑 → 音量 +10%
   - 垂直下滑 → 音量 -10%
   - 单击 → 播放/暂停
4. 通过 Sunshine + Moonlight 串流到手机

---

## 二、运行环境（已验证）

| 项目 | 值 |
|---|---|
| 主机名 | `MGENTSRV1` |
| 内网 IP | `<JELLYFIN_HOST>` |
| 操作系统 | Windows 10.0.19045 |
| CPU | AMD Ryzen 5 5600（6C12T） |
| GPU | NVIDIA GeForce RTX 4060 Ti 16GB |
| Node.js | **v22.18.0**（已安装，路径 `C:\Program Files\nodejs\node.exe`） |
| Python | 3.10（`C:\Users\markgoo\AppData\Local\Programs\Python\Python310\python.exe`） |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` |
| PotPlayer | **已安装** |
| VLC / Chrome | 未安装 |

### 关键服务

| 服务 | 位置 | 状态 |
|---|---|---|
| **Jellyfin Server** | `C:\Program Files\Jellyfin\Server\` | 版本 **12.1.0**，监听 `0.0.0.0:8096` |
| **Sunshine** | `C:\Program Files\Sunshine\sunshine.exe` | 版本 **2025.829.135256**，监听 47984/47989/47990/48010 |
| Sunshine 配置 | `C:\Program Files\Sunshine\config\sunshine.conf` | `hevc_mode = 2`, `locale = zh` |
| Sunshine 应用 | `C:\Program Files\Sunshine\config\apps.json` | 现有 Desktop / Steam Big Picture |
| Sunshine Web UI | `https://localhost:47990` | 自签证书，需跳过警告 |

---

## 三、Jellyfin 配置现状（已验证）

文件：`C:\ProgramData\Jellyfin\Server\config\`

| 文件 | 关键项 | 当前值 |
|---|---|---|
| `system.xml` | `RemoteClientBitrateLimit` | **0**（不限制，Direct Play） |
| `network.xml` | `LocalNetworkSubnets` | `192.168.2.0/24`, `192.168.3.0/24` |
| `encoding.xml` | `EnableThrottling` | `true` |
| `encoding.xml` | `HardwareAccelerationType` | **`none`**（纯软件转码，但实际几乎不转码） |

### 播放行为（实测）

- 客户端全部为 **Direct Play**（日志中无 ffmpeg 调用）
- 视频源主要为 **720p H.264/HEVC，1.2~4 Mbps**
- 片库规模：**9000+ 部**，目录结构 `盘符:\库名\演员名\番号\番号.mp4`
- 封面已批量压缩：平均 **47 KB/张**（原平均 252 KB）

---

## 四、网络拓扑（已验证）

```
手机（iOS/Android）
    │ WireGuard（10.11.0.x）
    ▼
腾讯云 111.229.110.129（家用入口）
    │ ZeroTier（10.147.17.0/24）
    ▼
家里路由器 192.168.2.1（ImmortalWrt，10.147.17.54）
    │ 以太网
    ▼
<JELLYFIN_HOST>（本机，Jellyfin + Sunshine）
```

### 其他路径

| 路径 | 地址 |
|---|---|
| ZeroTier 办公室路由 | `10.147.17.11`（MGOFFICE / 192.168.126.1） |
| 办公室网段 | `192.168.123.0/24`、`192.168.126.0/24`（经 `10.147.17.11` 路由） |

---

## 五、Moonlight 串流的关键限制（实测确认）

### 5.1 触摸事件被转换为鼠标事件

**Moonlight 客户端不转发原生触摸事件（touchstart/touchmove/touchend），只转发鼠标事件。**

因此电脑端收到的永远是：

```
mousedown → mousemove → mouseup
```

**手势识别必须基于鼠标事件实现，不能监听 touch 事件。**

### 5.2 两种触摸模式

| 模式 | 手指操作 | 产生的鼠标事件 | 是否可用于手势 |
|---|---|---|---|
| **Trackpad（触摸板）** | 手指滑动 = 指针相对移动 | 只有 `mousemove`，**无拖动** | ❌ 不可用 |
| **Direct Touch（直接触摸）** | 手指位置 = 指针绝对位置 | `mousedown` + `mousemove` + `mouseup` | ✅ **必须用这个** |

**结论：实施前必须在 Moonlight 客户端设置中启用 Direct Touch 模式。**

### 5.3 码率控制（实测数据）

Moonlight 码率恒定，与内容无关：

| 码率设置 | 每小时流量 | 每分钟 | 10 秒预览 |
|---|---|---|---|
| 3 Mbps | 1.32 GB | 22.5 MB | 3.8 MB |
| **4 Mbps** | **1.76 GB** | 30 MB | **5 MB** |
| 5 Mbps | 2.20 GB | 37.5 MB | 6.2 MB |
| 8 Mbps | 3.52 GB | 60 MB | 10 MB |

**实测：默认码率下串流时约 3.6 Mbps（15 秒 ≈ 6.8 MB）。**

### 5.4 为什么用户要走这条路

Jellyfin 移动客户端（特别是 ddPlayer）采用激进预缓冲：

```
实测：90 秒内传输 1.1 GB（跑满 100 Mbps 上行）
单次 10 秒预览 = 200~500 MB
```

对比 Moonlight 串流同一内容：**1.5 分钟仅 48 MB，降低约 23 倍。**

---

## 六、技术方案

### 6.1 架构

```
Electron 主进程
├── BrowserWindow（无边框全屏）
│   └── 加载 http://127.0.0.1:8096
├── 注入 CSS：* { cursor: none !important; }
└── 注入 JS：手势识别脚本
        ├── 拦截 video 元素区域的鼠标拖动
        ├── 计算滑动距离/方向
        └── 调用 video.currentTime / video.volume
```

### 6.2 关键技术点

**① Jellyfin Web 播放器基于 HTML5 `<video>`，可直接操作：**

```javascript
const video = document.querySelector('video');
video.currentTime += 10;                              // 快进 10 秒
video.volume = Math.min(1, video.volume + 0.1);       // 音量 +10%
video.paused ? video.play() : video.pause();          // 播放/暂停
```

**② 手势识别核心逻辑：**

```javascript
let startX = 0, startY = 0, startT = 0, dragging = false;
const THRESHOLD = 80;   // 最小识别距离（px）
const MAX_TIME = 800;   // 最长识别时间（ms）

document.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startY = e.clientY;
    startT = Date.now();
    dragging = true;
});

document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (Date.now() - startT > MAX_TIME) return;   // 太慢不算手势

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const video = document.querySelector('video');
    if (!video) return;

    if (Math.abs(dx) > Math.abs(dy)) {
        if (Math.abs(dx) < THRESHOLD) return;
        video.currentTime += (dx > 0 ? 10 : -10);
    } else {
        if (Math.abs(dy) < THRESHOLD) return;
        video.volume = Math.max(0, Math.min(1, video.volume + (dy > 0 ? -0.1 : 0.1)));
    }
});
```

**③ 防止与 Jellyfin 原播放器控件冲突：**

Jellyfin 的进度条、音量按钮等控件有自己的鼠标事件处理。建议：

- 只在 `video` 元素上监听（不监听整个 document）
- 或检查事件目标：`if (e.target.closest('.videoOsd')) return;`
- 或在 `mouseup` 时判断滑动起点是否在控件区域内

**④ 全屏配置：**

```javascript
const win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
});
win.loadURL('http://127.0.0.1:8096');
```

**⑤ 隐藏鼠标（多保险）：**

```javascript
// 注入 CSS
const style = document.createElement('style');
style.textContent = '*, *::before, *::after { cursor: none !important; }';
document.head.appendChild(style);

// 兜底：定期强制
setInterval(() => { document.body.style.cursor = 'none'; }, 1000);
```

---

## 七、已知问题与坑（重要）

### 7.1 ⚠️ 本机 TLS/Schannel 损坏

**实测：这台机器的 Windows TLS（Schannel）不可用。**

| 工具 | HTTPS 结果 |
|---|---|
| .NET `Invoke-WebRequest` | ❌ `Authentication failed` |
| `curl.exe` | ❌ `SEC_E_NO_CREDENTIALS (0x8009030E)` |
| **Python (OpenSSL)** | ✅ **正常** |
| **Node.js (OpenSSL)** | ✅ **正常**（推断，未实测） |

**影响：`npm install electron` 可能失败。**

**解决方案：**
- 用 `npm config set registry https://registry.npmmirror.com`（国内镜像）
- 或用 Python/Node 的下载能力代下 Electron 二进制
- 或手动下载 Electron 预编译包

### 7.2 ⚠️ Moonlight 串流时的鼠标可见性

- Sunshine 串流默认会渲染鼠标指针
- 需在 Electron 应用内用 CSS 隐藏（见 6.2 ⑤）
- **但不能保证 100% 生效**（某些全屏场景下由系统绘制）
- 备选：用 Windows API 设置系统级隐藏（`ShowCursor(false)`），但会影响其他程序

### 7.3 ⚠️ 视频区域与 UI 区域的事件冲突

| 区域 | 默认行为 |
|---|---|
| 视频画面中央 | Jellyfin 无响应 → **可安全拦截** |
| 底部进度条 | 拖动 = 调进度 → 冲突 |
| 右侧音量/设置面板 | 点击 = 操作 → 冲突 |

**必须在 `mouseup` 时判断事件目标，排除 UI 控件区域。**

### 7.4 ⚠️ Jellyfin DOM 结构不稳定

Jellyfin 的 class 名（如 `.videoOsd`、`.videoPlayerContainer`）可能在版本升级时变化。

**建议：**
- 用结构选择器（`document.querySelector('video')`）而非 class
- 或做多重 fallback 检测

### 7.5 ⚠️ Direct Touch 模式的副作用

Direct Touch 模式下：
- 手指必须精确点在目标上（没有触摸板的相对移动便利）
- 瀑布流滚动可能需要双指
- **体验需要实测验证**

### 7.6 音频设备问题

本机在 RDP 会话下无音频设备，Kodi 等程序会报 `DSERR_NODRIVER`。
**退出 RDP 后恢复正常**（用户确认）。Electron 应用可能遇到类似问题，但不影响画面串流。

---

## 八、Sunshine 集成

### 8.1 在 `apps.json` 添加应用条目

文件：`C:\Program Files\Sunshine\config\apps.json`

```json
{
  "name": "Jellyfin",
  "cmd": "\"C:\\Program Files\\JellyfinPlayer\\jellyfin-player.exe\"",
  "auto-detach": true,
  "wait-all": true,
  "image-path": "jellyfin.png"
}
```

### 8.2 权限说明

- `C:\Program Files\Sunshine\config\` 下的文件**可写**（已实测复制成功）
- 但 `C:\Program Files\Kodi\addons\skin.estuary\xml\` 不可写（ACL 拒绝）
- `C:\Users\markgoo\AppData\Roaming\` 下的文件写入需要提权

---

## 九、验收标准

| 编号 | 测试项 | 预期结果 |
|---|---|---|
| 1 | 启动应用 | 全屏显示 Jellyfin 瀑布流，无窗口边框，无鼠标指针 |
| 2 | 点击封面 | 进入详情页 |
| 3 | 点击播放 | 视频开始播放 |
| 4 | 播放中向右滑动 80px+ | 快进 10 秒 |
| 5 | 播放中向左滑动 80px+ | 快退 10 秒 |
| 6 | 播放中向上滑动 | 音量增加 |
| 7 | 播放中向下滑动 | 音量减少 |
| 8 | 单击视频画面 | 播放/暂停切换 |
| 9 | 拖动底部进度条 | **正常拖动，不触发手势** |
| 10 | Moonlight 串流下重复 4~9 | 全部正常，无鼠标指针可见 |
| 11 | 流量测量 | 4 Mbps 码率下，浏览+播放 60 秒 ≈ 30 MB |

---

## 十、参考：Jellyfin API（备选方案）

如果 DOM 操作不稳定，可改用 Jellyfin API 控制播放：

```
POST /Sessions/Playing/Progress     # 上报进度
GET  /Items/{itemId}/PlaybackInfo   # 获取播放信息
POST /Sessions/Playing/Stopped      # 停止播放
```

但**手势控制建议直接操作 `<video>` 元素**，延迟更低。

---

## 十一、流量数据参考

### 用户实际使用模式

> "我不用输入，只要看瀑布流就选择就行"
> "这种片不会看完的，就是不停地切换、预览"

### 三种方案对比（实测）

| 方案 | 10 秒预览 | 切换 10 次 | 完整看 2 小时 |
|---|---|---|---|
| **ddPlayer 直连** | 200~500 MB | 2~5 GB | 1.2 GB |
| **Moonlight @4Mbps** | 5 MB | 50 MB | 3.5 GB |
| Jellyfin App | ~81 MB | ~800 MB | 1.2 GB |

**结论：对"快速切换预览"场景，Moonlight 优势 20~40 倍。**

---

## 十二、附：不要重复的弯路

以下方案已由用户测试并否决，**新实施者不必再试**：

| 方案 | 否决原因 |
|---|---|
| **Kodi + Jellyfin 插件** | 配置繁琐（插件+4依赖），且配置页输入框被 `<enable>false</enable>` 禁用，必须走向导弹窗，实际操作困难 |
| **Jellyfin `RemoteClientBitrateLimit` 限速** | 设 3000 会让分辨率降到 **416p**（画面马赛克）；设 8000 仍缩 416p 且流量更大 |
| **降低片源码率** | 已是 720p / 1.2~4 Mbps，已是最优状态 |
| **改 `EnableThrottling`** | 只对转码生效，Direct Play 无效 |
| **VNC 播放视频** | 无视频编码，流量爆炸 |
| **RDP 播放视频** | 二次编解码，画质损失且流量不比 Direct Play 少 |

---

*文档生成时间：2026-11-10*
*所有实测数据来源：本机 Jellyfin 日志、nftables 计数器、vnstat、Sunshine/Moonlight 实测*
