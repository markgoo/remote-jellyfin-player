'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ---------- 配置 ----------
const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8096',
    seekMode: 'scaled',         // scaled: 快进秒数随滑动距离变化(默认)| fixed: 每次固定秒数
    seekStepSeconds: 10,        // scaled 模式:每 pixelsPerStep 像素对应的秒数 | fixed 模式:每次固定秒数
    pixelsPerStep: 250,         // scaled 模式:每滑 N 像素 = seekStepSeconds(越大越不敏感)
    seekMinSeconds: 5,          // scaled 模式单次快进下限
    seekMaxSeconds: 60,         // scaled 模式单次快进上限(防止一滑跳太远)
    seekDebounceMs: 250,        // 连续滑动合并窗口:期间只记目标,超时才真正 seek(避免反复重缓冲)
    volumeStep: 0.1,            // 竖滑一次的音量变化(0~1)
    swipeThresholdPx: 80,       // 手势生效最小滑动距离
    swipeMaxMs: 800,            // 手势最长识别时间
    axisLockPx: 10,             // 位移超过该值才视为拖动(之下算单击)
    doubleTapMs: 300,           // 双击判定窗口
    toastMs: 800,               // 反馈浮层显示时长
    enableBackGesture: true,    // 左边缘向右滑 = 返回上一层
    backEdgeWidthPx: 48,        // 左边缘热区宽度(按下点在此范围内才算返回手势)
    backSwipeThresholdPx: 100,  // 返回手势的最小水平位移
    enableBigControls: true,    // 放大 Jellyfin 自带控件的触摸热区(不改界面版式/字号)
    osdButtonMinPx: 60,         // 播放器 OSD 按钮最小边长(原 41px)
    sliderHeightPx: 46,         // 进度条/音量条的可点高度(原 28px)
    sliderThumbPx: 28,          // 进度条滑块手柄尺寸
    menuButtonSizePx: 48,       // 右上角选项按钮直径

    // ---------- 虚拟按键(手机上直接点,不依赖滑动) ----------
    enableNavButtons: true,     // 播放页显示 ◀ ▶ ↩;浏览页显示 ▲ ▼ ↩
    navButtonSizePx: 108,       // 常规按键直径(↩ ◀ ▶)
    navScrollButtonSizePx: 120, // ▲▼ 滚动键单独放大(比常规键大一点,但不过分)
    navScrollGapPx: 20,         // ▲▼ 之间的间距
    navButtonOpacity: 0.32,     // 平时透明度(不挡画面)
    navButtonBgAlpha: 0.35,     // 底色黑度
    navScrollRatio: 0.7,        // ▲▼ 每次滚动多少屏(0~1)

    // 界面整体放大倍数(相对 Jellyfin 原始尺寸;1 = 原样)
    uiScale: 1.0,

    // ---------- 实时语音字幕 ----------
    enableLiveSubtitle: true,   // ☰ 菜单里是否显示「实时字幕」开关
    sttPort: 8765,              // 本地字幕服务端口(仅 127.0.0.1)
    sttPreload: true,           // 启动即加载模型(首次约 5s,换来首个窗口不卡)
    sttDevice: 'cuda',          // cuda | cpu
    sttComputeType: 'float16',  // cuda 用 float16;cpu 用 int8
    sttModelPath: '',           // 留空用默认(VideoCaptioner 的 large-v2)
    sttLanguage: 'ja',          // 源语言
    sttTranslator: 'ollama',    // 翻译后端: ollama | openai | deepl | none
    sttLlm: 'qwen3.5:9b',       // Ollama 翻译模型
    ollamaUrl: 'http://127.0.0.1:11434/api/generate',
    openaiBaseUrl: '',          // OpenAI 兼容地址(留空则回退 ollama)
    openaiApiKey: '',
    openaiModel: '',
    deeplApiKey: '',
    deeplFree: true,
    deeplTargetLang: 'ZH-HANS',
    deeplSourceLang: 'JA',
    sttWindowSeconds: 10,       // 预取窗口秒数
    sttLookaheadSeconds: 60,    // 提前算到播放位置之后多少秒
    sttBackfillRangeSeconds: 60, // 空闲时回补当前位置往前多少秒(0=关闭)
    sttCacheEnabled: true,      // 字幕磁盘缓存:同片重看秒出,不用再算

    // ---------- 幻觉过滤(发布默认值,已用真实片源实测) ----------
    // Whisper 在弱语音段会编出训练数据里的片尾字幕(「ご視聴ありがとうございました」
    // 「次回予告」等),和实际内容无关,会让字幕和画面严重对不上。
    // 这几项默认值经实测:过滤掉 8 条幻觉、保留 12 条真实对话,无误杀。
    sttFilterEnabled: true,             // 总开关
    sttFilterPhraseLogprob: -0.35,      // 命中词表时的置信度门限
    sttFilterMinLogprob: -1.05,         // 绝对置信度下限(低于必丢)
    sttFilterMaxNoSpeech: 0.60,         // 静音概率上限
    sttFilterSpeechNoSpeechLogprob: -0.35,  // 高静音概率下的置信度门限
    sttFilterMaxRepeat: 2,              // 同窗口同句重复次数上限(循环幻觉)
    sttFilterPhrases: [                 // 幻觉词表(命中且置信度不高则丢)
        'ご視聴ありがとうございました',
        'ご視聴ありがとうございます',
        '本日はご覧いただきありがとう',
        '最後までご視聴いただき',
        'チャンネル登録',
        '高評価',
        '次回予告',
        'お疲れ様でした',
        'おつかれさまでした',
        'おやすみなさい',
        '字幕は自動生成',
        '字幕by',
        'Amara.org',
        'Subscribe',
    ],
    sttFilterMarkers: ['★', '☆', '「', '『', '♪'],   // 带这些标记的视为真实台词,不丢
    subtitleShowSource: true,   // 字幕显示原文(双语叠层)
    subtitleColor: '#ffffff',   // 字幕颜色:必须显式指定,否则继承正文深色,深色画面上看不见
    subtitleFontPx: 30,         // 译文字号
    subtitleBottomPx: 90,       // 字幕距底部距离
    sttIdleGraceMs: 45000,      // 离开播放页多久才自动停(期间换片/切页都不关,保留字幕状态)

    debug: false                // true 时记录每次按下的手势面判定过程到日志文件
};

// ---------- 文件日志(Sunshine 启动时无终端,排查靠这个) ----------

let logFilePath = null;

function appendLog(line) {
    try {
        if (!logFilePath) {
            // 优先 exe 旁边(Program Files 不可写则落到 userData)
            const dirs = [path.dirname(process.execPath), app.getPath('userData')];
            for (const d of dirs) {
                try { fs.accessSync(d, fs.constants.W_OK); } catch (_) { continue; }
                logFilePath = path.join(d, 'jellyfin-player.log');
                try {
                    if (fs.statSync(logFilePath).size > 512 * 1024) {
                        fs.renameSync(logFilePath, logFilePath + '.old');
                    }
                } catch (_) { /* 尚无日志文件 */ }
                break;
            }
            if (!logFilePath) return;
        }
        const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
        fs.appendFileSync(logFilePath, `[${stamp}] ${line}\n`);
    } catch (_) { /* 日志失败不影响运行 */ }
}

function loadConfig() {
    // 打包后读 exe 旁边的 config.json(部署时用户可改);开发时读项目根目录
    const candidates = [
        path.join(path.dirname(process.execPath), 'config.json'),
        path.join(app.getAppPath(), 'config.json')
    ];
    let fileCfg = {};
    for (const p of candidates) {
        try {
            fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
            break;
        } catch (_) { /* 尝试下一个 */ }
    }
    return Object.assign({}, DEFAULTS, fileCfg);
}

function resolveServerUrl(cfg) {
    const argv = process.argv;
    let url = null;
    const i = argv.indexOf('--server');
    if (i !== -1 && argv[i + 1]) url = argv[i + 1];
    if (!url && process.env.JELLYFIN_URL) url = process.env.JELLYFIN_URL;
    return url || cfg.serverUrl;
}

// ---------- 单实例 ----------
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    });
}

// 允许无用户手势自动播放(Jellyfin 内部跳转场景)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const HIDE_CURSOR_CSS = '*, *::before, *::after { cursor: none !important; }';

// ---------- 实时语音字幕服务(Python 子进程) ----------
// 负责:预取音频窗口 → Whisper 识别 → LLM 翻译。
// 模型常驻(首次加载约 5 秒),之后每个窗口约 3.5 秒,远快于播放。

let sttProc = null;
let sttPort = 0;

function sttScriptPath() {
    // 打包后 app.asar 内无法直接执行 python 脚本,所以:
    //   1) 优先用 exe 旁边的 tools/stt(部署时一起拷)
    //   2) 开发时用仓库内 tools/stt
    const cands = [
        path.join(path.dirname(process.execPath), 'tools', 'stt', 'server.py'),
        path.join(app.getAppPath(), '..', 'tools', 'stt', 'server.py'),
        path.join(__dirname, '..', 'tools', 'stt', 'server.py'),
    ];
    for (const p of cands) {
        try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* 下一个 */ }
    }
    return null;
}

function sttPythonPath() {
    const cands = [
        path.join(path.dirname(process.execPath), '.stt', 'venv', 'Scripts', 'python.exe'),
        path.join(app.getAppPath(), '..', '.stt', 'venv', 'Scripts', 'python.exe'),
        path.join(__dirname, '..', '.stt', 'venv', 'Scripts', 'python.exe'),
    ];
    for (const p of cands) {
        try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* 下一个 */ }
    }
    return null;
}

// 等服务真正能响应(模型加载 + 预热要几秒到十几秒)
async function waitSttReady(port, timeoutMs = 90000) {
    const t0 = Date.now();
    let lastErr = '';
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (r.ok) {
                const j = await r.json();
                if (j && j.ok) return { ok: true, ...j };
            }
        } catch (err) {
            lastErr = err.message;
        }
        await new Promise((res) => setTimeout(res, 500));
    }
    return { ok: false, error: `字幕服务未就绪(${timeoutMs / 1000}s 超时): ${lastErr}` };
}

function ensureSttService(cfg) {
    if (sttProc) return { ok: true, port: sttPort };
    if (cfg.enableLiveSubtitle === false) return { ok: false, error: '已在配置中禁用' };

    const script = sttScriptPath();
    const python = sttPythonPath();
    if (!script || !python) {
        return { ok: false, error: `找不到字幕服务(${script ? '有脚本' : '缺脚本'} / ${python ? '有环境' : '缺 .stt/venv'})` };
    }

    sttPort = cfg.sttPort || 8765;
    const args = [script, '--port', String(sttPort)];
    if (cfg.sttPreload !== false) args.push('--preload');
    if (cfg.sttDevice) args.push('--device', cfg.sttDevice);
    if (cfg.sttComputeType) args.push('--compute-type', cfg.sttComputeType);
    if (cfg.sttModelPath) args.push('--model', cfg.sttModelPath);

    try {
        sttProc = spawn(python, args, {
            cwd: path.dirname(script),
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        appendLog(`[stt] 启动字幕服务 pid=${sttProc.pid} port=${sttPort}`);
        sttProc.stdout.on('data', (d) => {
            const s = String(d).trim();
            if (s) { console.log(`[stt] ${s}`); appendLog(`[stt] ${s}`); }
        });
        sttProc.stderr.on('data', (d) => {
            const s = String(d).trim();
            if (s) { console.log(`[stt!] ${s}`); appendLog(`[stt!] ${s}`); }
        });
        sttProc.on('exit', (code) => {
            appendLog(`[stt] 字幕服务退出 code=${code}`);
            sttProc = null;
        });
        return { ok: true, port: sttPort };
    } catch (err) {
        appendLog(`[stt] 启动失败: ${err.message}`);
        sttProc = null;
        return { ok: false, error: err.message };
    }
}

function stopSttService() {
    if (!sttProc) return;
    const p = sttProc;
    sttProc = null;
    try { p.kill(); } catch (_) { /* ignore */ }
    appendLog('[stt] 字幕服务已停止');
}

// 只在真正退出时杀服务;窗口关闭不等同于退出(Electron 里窗口可能重建)
app.on('before-quit', stopSttService);

function createWindow() {
    const cfg = loadConfig();
    const localTest = process.argv.includes('--local-test');

    const win = new BrowserWindow({
        fullscreen: true,
        frame: false,
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    win.setMenuBarVisibility(false);
    win.once('ready-to-show', () => win.show());

    // 手势引擎取配置
    ipcMain.on('gesture-config', (event) => { event.returnValue = cfg; });
    // 手势引擎日志:终端 + 文件(Sunshine 启动时看不到终端)
    ipcMain.on('gesture-log', (_e, msg) => {
        console.log(`[gesture] ${msg}`);
        appendLog(msg);
    });
    // 页面内 ✕ 按钮退出
    ipcMain.on('app-quit', () => app.quit());

    // ---------- 实时字幕 IPC ----------
    // 渲染进程不能直接跨域请求 127.0.0.1:8765(CSP/CORS),统一由主进程代理。
    ipcMain.handle('stt:ensure', () => ensureSttService(cfg));

    ipcMain.handle('stt:start', async (_e, opts) => {
        const up = ensureSttService(cfg);
        if (!up.ok) return up;

        // 关键:服务刚启动时模型还在加载,直接 fetch 会失败。
        // 必须先等 /health 通过再发 /start。
        const ready = await waitSttReady(up.port, cfg.sttReadyTimeoutMs || 90000);
        if (!ready.ok) {
            appendLog(`[stt] ${ready.error}`);
            return { ok: false, error: ready.error };
        }
        appendLog('[stt] 服务就绪,开始会话');

        try {
            const r = await fetch(`http://127.0.0.1:${up.port}/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts),
            });
            return await r.json();
        } catch (err) {
            appendLog(`[stt] start 失败: ${err.message}`);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('stt:position', async (_e, pos) => {
        if (!sttProc) return { ok: false, needRestart: true };
        try {
            const r = await fetch(`http://127.0.0.1:${sttPort}/position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(pos),
            });
            return await r.json();
        } catch (_) { return { ok: false, needRestart: true }; }
    });

    ipcMain.handle('stt:cues', async (_e, q) => {
        if (!sttProc) return { cues: [], status: null };
        try {
            const url = `http://127.0.0.1:${sttPort}/cues?from=${q.from}&to=${q.to}`;
            const r = await fetch(url);
            return await r.json();
        } catch (_) { return { cues: [], status: null }; }
    });

    ipcMain.handle('stt:stop', async () => {
        if (!sttProc) return { ok: true };
        try {
            const r = await fetch(`http://127.0.0.1:${sttPort}/stop`, { method: 'POST' });
            return await r.json();
        } catch (_) { return { ok: false }; }
    });

    // ---------- 设置持久化 ----------
    // 写回 exe 旁边的 config.json(部署时用户可改的那份),并更新内存中的 cfg。
    ipcMain.handle('settings:save', async (_e, patch) => {
        if (!patch || typeof patch !== 'object') return { ok: false, error: '无效参数' };
        try {
            // 找到实际的 config 文件
            const candidates = [
                path.join(path.dirname(process.execPath), 'config.json'),
                path.join(app.getAppPath(), 'config.json'),
            ];
            let target = null;
            for (const p of candidates) {
                try { fs.accessSync(p, fs.constants.W_OK); target = p; break; } catch (_) { /* 下一个 */ }
            }
            if (!target) return { ok: false, error: '找不到可写的 config.json' };

            // 读现有内容(保留未在设置面板里出现的键)
            let onDisk = {};
            try { onDisk = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) {}
            const merged = Object.assign({}, onDisk, patch);

            fs.writeFileSync(target, JSON.stringify(merged, null, 2) + '\n', 'utf8');

            // 更新内存配置,让部分项立即生效
            const needsRestart = ['sttTranslator', 'openaiBaseUrl', 'openaiApiKey',
                'openaiModel', 'deeplApiKey', 'deeplFree', 'sttLanguage', 'sttLlm',
                'sttWindowSeconds', 'sttPreload', 'sttLookaheadSeconds']
                .some((k) => k in patch && String(patch[k]) !== String(cfg[k]));
            Object.assign(cfg, patch);

            appendLog(`[settings] 已保存 ${Object.keys(patch).length} 项 → ${target}`);
            return {
                ok: true,
                path: target,
                restartHint: needsRestart ? '字幕服务参数已更新,重新开启字幕后生效' : '',
            };
        } catch (err) {
            appendLog(`[settings] 保存失败: ${err.message}`);
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('settings:get', () => ({ ok: true, cfg }));

    // 隐藏光标(主进程侧保险,页面导航后重注入)
    const injectCursor = () => win.webContents.insertCSS(HIDE_CURSOR_CSS, { cssOrigin: 'user' }).catch(() => {});
    win.webContents.on('did-finish-load', injectCursor);
    win.webContents.on('did-navigate', injectCursor);

    // 页面控制台透传(排查 Jellyfin DOM 用)
    win.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) console.log(`[page] ${message}`);
    });
    // 自测结果经标题回传
    win.on('page-title-updated', (e, title) => {
        if (title.startsWith('SELFTEST')) {
            e.preventDefault();
            console.log(title);
        }
    });

    // 物理键盘调试快捷键(Moonlight 下无键盘,仅供服务器现场排查)
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            event.preventDefault();
        } else if (input.key === 'r' && input.control) {
            win.webContents.reload();
            event.preventDefault();
        } else if (input.key === 'F12') {
            win.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    if (localTest) {
        const selftest = process.argv.includes('--selftest');
        win.loadFile(path.join(__dirname, '..', 'test', 'local-test.html'),
            selftest ? { query: { selftest: '1' } } : undefined);
    } else {
        win.loadURL(resolveServerUrl(cfg));
    }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
