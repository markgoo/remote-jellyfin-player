# 部署说明 —— Jellyfin 手势播放器

> 目标机:`<JELLYFIN_HOST>`(MGENTSRV1,Jellyfin + Sunshine 所在机器)
> 开发机已验证:手势引擎自测 9/9 通过(含打包产物冒烟)。
> 背景与技术规格见根目录《Jellyfin手势播放器-技术说明.md》。

## 一、拷贝产物

把开发机上 `dist\win-unpacked\` 整个文件夹拷到目标机,例如:

```
C:\Program Files\JellyfinPlayer\
    jellyfin-player.exe
    config.json        ← 用户可编辑,见下
    ...(其余运行时文件)
```

> 目标机 Schannel 损坏、无法 npm install,所以**不要**在目标机上构建,直接拷贝成品。

## 二、config.json(与 exe 同目录)

```json
{
  "serverUrl": "http://127.0.0.1:8096",   // 目标机上 Jellyfin 就是本机,保持 127.0.0.1
  "seekMode": "fixed",                     // fixed=每次手势固定秒数 | scaled=按滑动距离折算
  "seekStepSeconds": 10,                   // 每次快进/快退秒数(scaled 模式=每 80px 的秒数)
  "pixelsPerStep": 80,
  "volumeStep": 0.1,
  "swipeThresholdPx": 80,                  // 手势生效最小滑动距离
  "swipeMaxMs": 800,                       // 超时不算手势
  "axisLockPx": 10,
  "doubleTapMs": 300,
  "toastMs": 800
}
```

改完重启应用即生效。

## 三、Sunshine 添加应用

文件:`C:\Program Files\Sunshine\config\apps.json`,在 `apps` 数组里加一项:

```json
{
  "name": "Jellyfin",
  "cmd": "\"C:\\Program Files\\JellyfinPlayer\\jellyfin-player.exe\"",
  "auto-detach": true,
  "wait-all": true,
  "image-path": "jellyfin.png"
}
```

> 注意是 `auto-detach`(分离启动),不是 `auto-detect`。写错会导致应用启动后
> Sunshine 以为它已退出。

`image-path` 指向 `C:\Program Files\Sunshine\config\` 下的封面图,放一张 `jellyfin.png` 即可;
没有图会显示默认图标。

改完后重启 Sunshine 服务(或在 Web 管理页 `https://localhost:47990` 里重载应用列表)。

## 四、在 Moonlight 里创建快捷方式

Sunshine 端配好应用后,Moonlight 客户端会自动列出,**不需要在手机上手动添加**。
如果没出现,按下面排查。

### 手机上出现快捷方式的步骤

1. **确认 Sunshine 端已生效**
   在目标机浏览器打开 `https://localhost:47990` → `Applications` 页,
   应能看到名为 `Jellyfin` 的条目。没有就说明 `apps.json` 格式写错或没重载。

2. **手机 Moonlight 刷新主机**
   打开 Moonlight → 点右上角或长按主机图标 → `Refresh` / 刷新。
   应用列表在每次连接到主机时自动拉取。

3. **点 Jellyfin 图标即可启动**
   启动后 Sunshine 会执行 `cmd` 里配置的路径,画面经串流推送到手机。
   `auto-detach: true` 保证应用在后台独立运行,不随 Sunshine 的连接状态被强行结束。

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| Moonlight 里看不到 Jellyfin | ① `apps.json` 的 JSON 格式错误(逗号/引号);② 没重启 Sunshine;③ 手机没刷新列表 |
| 点了图标没反应 | `cmd` 路径不对,或 exe 有权限问题。先在目标机手动双击 exe 确认能启动 |
| 启动后立刻退回 Moonlight 主界面 | 检查是不是写成了 `auto-detect`;也看目标机日志 `%ProgramFiles%\Sunshine\config\sunshine.log` |
| 图标是灰色的默认图 | 缺少 `image-path` 指定的 png,或文件名大小写不符 |
| 手机能看到图标但连不上 | Sunshine 的网络/防火墙问题,与本文档无关,先确认其他应用(如 Desktop)能连 |

### 建议同时保留 Desktop 条目

`apps.json` 里通常保留一条 `Desktop`,用于串流整个桌面。调试播放器(看报错、改配置)
时用得上;日常使用直接点 `Jellyfin` 图标。

## 五、Moonlight 客户端设置(手机,关键!)

1. **必须开启 Direct Touch(直接触摸)模式** —— 触摸板(Trackpad)模式只产生 mousemove,
   手势识别所需的 mousedown/mouseup 不存在,手势必然失效(技术说明 §5.2)。
2. 码率建议 4 Mbps(流量/画质平衡点,技术说明 §5.3)。
3. 分辨率建议与片源匹配(720p 片源,1080p 串流即可)。

## 六、首次登录(一次性)

Moonlight 无法输入文字。第一次启动需要在目标机**接一次物理键盘**:

1. 在目标机上直接运行 `jellyfin-player.exe`(或经 Sunshine 串流后在 RDP…不行,RDP 会占用会话;
   最简单是现场操作一次);
2. 登录 Jellyfin 用户,勾选**"记住我"(Remember Me)**;
3. 之后登录态保存在应用 userData 中,串流直接进入首页。

## 七、手势操作一览(给手机端用)

| 操作 | 效果 |
|---|---|
| 横滑 ≥80px(右) | 快进(默认 +10 秒) |
| 横滑 ≥80px(左) | 快退 −10 秒 |
| 竖滑 ≥80px(上) | 音量 +10% |
| 竖滑 ≥80px(下) | 音量 −10% |
| 单击画面 | 原生行为(Jellyfin 12.x 为暂停/弹控制栏) |
| 双击画面 | 播放/暂停 |
| 底部进度条拖动 | 正常调进度,不会误触发手势 |
| 右上角长条工具栏 | `▭` 开关 Jellyfin 控制栏 · `☰` 打开选项菜单(含设置/退出);整体可拖动,位置会记忆 |

每次手势屏幕上方有短暂提示(`⏩ +10秒` / `🔊 80%` 等)。
若工具栏挡住了 Jellyfin 的按钮,按住拖到别的角落即可,位置会记住。

## 八、现场验证清单(对应技术说明 §9)

先在目标机本机验证(可开终端运行以便看日志):

```cmd
cd /d C:\Program Files\JellyfinPlayer
jellyfin-player.exe
```

- [ ] 1. 全屏显示 Jellyfin 瀑布流,无窗口边框、无鼠标指针
- [ ] 2/3. 点封面进详情、点播放正常
- [ ] 4~8. 播放中用鼠标模拟滑动:右滑/左滑快进退、上/下滑音量、双击暂停
- [ ] 9. 拖底部进度条不触发手势
- [ ] 终端应能看到 `[gesture] seek +10.0s` / `[gesture] volume → 90%` 等日志
  (没有日志 = 手势没识别,通常是点在了控件区)

再跑一次引擎自检(目标机上也能跑,不依赖 Jellyfin):

```cmd
jellyfin-player.exe --local-test --selftest
```

约 20 秒后终端应输出 `SELFTEST PASS`,窗口自动关闭。

最后手机 Moonlight(Direct Touch 已开)重复 4~9,并观察流量(技术说明 §9 第 10/11 条)。

## 九、排查

**日志文件**:所有手势动作都记录在 `jellyfin-player.log`(exe 旁边;若目录不可写则在
`%APPDATA%\jellyfin-player\`),Sunshine 启动看不到终端时靠它排查。

| 现象 | 处理 |
|---|---|
| 手势完全无反应 | ① Moonlight 是不是 Trackpad 模式?→ 切 Direct Touch;② 打开 config.json 的 `"debug": true` 重启,复现一次滑动,把日志里 `down(...)` 那几行发回来 |
| 滑动被当成暂停/单击 | 同上开 debug 发日志(手势面判定需要针对实际 DOM 再校准) |
| 拖进度条时也快进了 | 同上,发 debug 日志 |
| 画面上有鼠标指针 | 一般不会(双层 CSS 隐藏);若系统级仍显示,反馈处理 |
| 想调整手势灵敏度 | 改 config.json 的 `swipeThresholdPx` / `swipeMaxMs` / `seekStepSeconds` |
| 页面白屏/异常 | 现场按 `Ctrl+R` 重载;`F12` 开 DevTools 看 Console |
| 需要退出 | 点右上角工具栏的 `☰` → 退出;或物理键盘 `Alt+F4` |

物理键盘调试键:`F11` 切全屏、`Ctrl+R` 重载、`F12` DevTools、`Alt+F4` 退出。
