# remote-jellyfin-player v1.0.0

远程串流场景下的 Jellyfin 播放器。首个发布版本。

## 三个特性

### 1. 解决远程转码播放时上传流量过大的问题

远程播放时 Jellyfin 需要转码,上传流量由两块叠加:转码输出的码率,以及**每次起播都要重新协商、探测、缓冲并激进预取**的开销。后者是总量被推高的主因 —— 尤其在多部剧集反复切换时,看了十几秒却付了一整段缓冲的流量。

本项目通过单一恒定码率的视频通道输出,切剧不重建通道,总上传量 = 码率 × 实际观看时长。

实测对比:

| 方案 | 预览 10 秒 | 来回切 10 次 | 完整看 2 小时 |
|---|---|---|---|
| Jellyfin 直连/转码播放 | ~81 MB | ~800 MB | 1.2 GB |
| **Moonlight 串流 @4 Mbps** | **5 MB** | **50 MB** | 3.5 GB |

切换场景下差距 **20~40 倍**。

### 2. 在 Moonlight 或类似串流方案上,提供原生播放器缺失的基础手势

Moonlight 的 Direct Touch 把触摸转成鼠标事件转发给主机,Jellyfin 官方播放器不把它当触摸处理:

- 左右滑动不快进快退
- 上下滑动不调音量
- 每次滑动还会撞上它自己的单击暂停逻辑

本项目在 preload 层识别手势:横滑快进退(按距离 5–60 秒)、竖滑调音量、左边缘右滑返回、双击播放/暂停,并提供虚拟按键(`◀ ▶ ↩` / `▲ ▼ ↩`)兜底。

### 3. 为视频提供实时字幕

不依赖字幕文件,直接对音频流做识别 + 翻译。预取未来窗口,字幕比画面**提前 6 秒以上**就绪。

翻译后端可插拔:`ollama`(默认,本地免费离线)、任何 OpenAI 兼容接口、`deepl`、或 `none`(只显示原文)。

## 下载说明

`remote-jellyfin-player-v1.0.0-win-x64.zip`(112 MB)包含程序本体与 Electron 运行时。

**实时字幕需要额外环境**,本包不含:

- Python 3.10 + faster-whisper
- Whisper 模型(large-v2 约 2.9 GB)
- 翻译后端(Ollama 或其他)
- NVIDIA 显卡驱动(CPU 也能跑,但慢)

完整步骤见 [README 的安装章节](https://github.com/markgoo/remote-jellyfin-player#安装与运行--installation)。

**仅使用手势功能的话,解压后直接运行 `jellyfin-player.exe` 即可,无需额外依赖。**

## 已知限制

- 仅提供 Windows x64 构建
- 本包不含 Python 环境,实时字幕需自行安装(原因:环境有 2.1 GB,且需匹配用户自己的显卡与驱动)
- 首次使用需要在目标机接一次物理键盘完成 Jellyfin 登录(Moonlight 无法输入文字),之后登录态会保留

## 排查问题

日志默认写在 exe 同目录的 `jellyfin-player.log`。遇到问题时:

1. 把 `config.json` 的 `debug` 改成 `true`,重启应用
2. 复现问题
3. 把日志交给 AI 分析即可 —— 日志里保留了手势判定、字幕会话、预取窗口、跳转对齐等完整上下文

详见 [README 的排查章节](https://github.com/markgoo/remote-jellyfin-player#排查问题日志)。
