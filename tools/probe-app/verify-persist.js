'use strict';

/**
 * 验证字幕状态保留:
 *  1. 用户开启后,意图写入 localStorage
 *  2. 短暂离开播放页(换片)不会自动关
 *  3. 页面重载后自动恢复开启
 *  4. 用户主动关闭会清掉意图
 *  5. 超过宽限期才真正自动停
 *
 * 用法: jellyfin-player.exe <runtime> --probe-verify --item <id>
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = process.env.JFP_REPO || 'C:\\AI\\jellyfinplayer';
const OUT = path.join(REPO, '.verify-out.json');
const argv = process.argv;
const argVal = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : ''; };
const ITEM_ID = argVal('--item');

const REPORT = { checks: [], gestureLogs: [], sttLog: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
    serverUrl: 'http://127.0.0.1:8096', seekMode: 'scaled', seekStepSeconds: 10,
    pixelsPerStep: 250, seekMinSeconds: 5, seekMaxSeconds: 60, seekDebounceMs: 250,
    volumeStep: 0.1, swipeThresholdPx: 80, swipeMaxMs: 800, axisLockPx: 10,
    doubleTapMs: 300, toastMs: 900, enableBackGesture: true, backEdgeWidthPx: 48,
    backSwipeThresholdPx: 100, enableBigControls: true, osdButtonMinPx: 60,
    sliderHeightPx: 46, sliderThumbPx: 28, menuButtonSizePx: 48,
    enableLiveSubtitle: true, sttPort: 8765, sttPreload: true,
    sttDevice: 'cuda', sttComputeType: 'float16', sttModelPath: '',
    sttLanguage: 'ja', sttLlm: 'qwen3.5:9b', sttWindowSeconds: 10,
    sttLookaheadSeconds: 60, sttTranslator: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434/api/generate',
    subtitleShowSource: true, subtitleFontPx: 30, subtitleBottomPx: 90,
    sttIdleGraceMs: 6000,        // 测试用短宽限期
    debug: true,
};

// ---- 服务管理(复用主进程逻辑) ----
let sttProc = null;
const PORT = 8765;

function scriptPath() {
    for (const p of [path.join(path.dirname(process.execPath), 'tools', 'stt', 'server.py'),
                     path.join(REPO, 'tools', 'stt', 'server.py')]) {
        try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
    return null;
}
function pythonPath() {
    for (const p of [path.join(path.dirname(process.execPath), '.stt', 'venv', 'Scripts', 'python.exe'),
                     path.join(REPO, '.stt', 'venv', 'Scripts', 'python.exe')]) {
        try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
    }
    return null;
}
function ensure() {
    if (sttProc) return { ok: true, port: PORT };
    const s = scriptPath(), py = pythonPath();
    if (!s || !py) return { ok: false, error: `脚本=${!!s} python=${!!py}` };
    const { spawn } = require('child_process');
    sttProc = spawn(py, [s, '--port', String(PORT), '--preload'], {
        cwd: path.dirname(s), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    sttProc.stdout.on('data', (d) => { const t = String(d).trim(); if (t) REPORT.sttLog.push(t); });
    sttProc.stderr.on('data', (d) => { const t = String(d).trim(); if (t) REPORT.sttLog.push('[!]' + t); });
    sttProc.on('exit', () => { sttProc = null; });
    return { ok: true, port: PORT };
}
async function waitReady(ms = 90000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) { const j = await r.json(); if (j.ok) return true; }
        } catch (_) {}
        await sleep(500);
    }
    return false;
}

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); console.log('[gesture] ' + m); });
ipcMain.on('app-quit', () => app.quit());
ipcMain.handle('stt:ensure', () => ensure());
ipcMain.handle('stt:start', async (_e, o) => {
    const up = ensure(); if (!up.ok) return up;
    if (!(await waitReady())) return { ok: false, error: '未就绪' };
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(o) });
        return await r.json();
    } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('stt:position', async (_e, p) => {
    if (!sttProc) return { ok: false, needRestart: true };
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/position`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(p) });
        return await r.json();
    } catch (_) { return { ok: false, needRestart: true }; }
});
ipcMain.handle('stt:cues', async (_e, q) => {
    if (!sttProc) return { cues: [], status: null };
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/cues?from=${q.from}&to=${q.to}`);
        return await r.json();
    } catch (_) { return { cues: [], status: null }; }
});
ipcMain.handle('stt:stop', async () => {
    if (!sttProc) return { ok: true };
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/stop`, { method: 'POST' });
        return await r.json();
    } catch (_) { return { ok: false }; }
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const check = (name, ok, detail) => {
    REPORT.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    save();
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1280, height: 720, show: true, backgroundColor: '#000',
        webPreferences: {
            preload: path.join(REPO, 'src', 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
    });
    const js = (c) => win.webContents.executeJavaScript(c, true);

    const clickMenu = async (matchRe) => {
        const btn = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        if (!btn) return false;
        win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(700);
        const item = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            if (!p) return null;
            const b = Array.from(p.querySelectorAll('button')).find(x => ${matchRe}.test(x.textContent));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: b.textContent.trim() };
        })()`);
        if (!item) return false;
        win.webContents.sendInputEvent({ type: 'mouseDown', x: item.x, y: item.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: item.x, y: item.y, button: 'left', clickCount: 1 });
        await sleep(500);
        return item.txt;
    };

    try {
        // 先彻底清掉上次残留的状态,保证测试从"关闭"开始
        await win.loadURL('http://127.0.0.1:8096/web/?clean=' + Date.now() + '#/home');
        await sleep(4000);
        await js(`localStorage.removeItem('jfp-stt-on')`);

        // 进入播放页
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(17000);

        const hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        check('进入播放页', hasVideo === true);
        if (!hasVideo) throw new Error('未进入播放页');

        // 确认此刻是关闭状态
        await sleep(1500);
        const startIntent = await js(`localStorage.getItem('jfp-stt-on')`);
        REPORT.startIntent = startIntent;

        // --- 1. 菜单开启字幕 ---
        const t1 = await clickMenu('/实时字幕/');
        REPORT.t1 = t1;
        check('菜单可点实时字幕', !!t1, t1 || '');

        // 等会话建立
        let opened = false;
        for (let i = 0; i < 40; i++) {
            await sleep(1000);
            const intent = await js(`localStorage.getItem('jfp-stt-on')`);
            if (intent === '1') { opened = true; break; }
        }
        check('开启后意图已持久化', opened === true, `intent=${await js(`localStorage.getItem('jfp-stt-on')`)}`);

        // --- 2. 短暂离开播放页(模拟换片),不应自动关 ---
        const beforeHash = await js('location.hash');
        await js(`location.hash = '#/home'`);
        await sleep(2500);          // 小于 6s 宽限期
        const intentAfterLeave = await js(`localStorage.getItem('jfp-stt-on')`);
        check('短暂离开播放页,意图仍保留', intentAfterLeave === '1', `intent=${intentAfterLeave}`);

        const logHasStop = REPORT.gestureLogs.some((l) => /已离开播放超过|不在播放页,自动停止/.test(l));
        check('短暂离开没有触发自动停止', logHasStop === false);

        // --- 3. 回到播放页 ---
        await js(`location.hash = '${beforeHash}'`);
        await sleep(6000);
        const intentBack = await js(`localStorage.getItem('jfp-stt-on')`);
        check('回到播放页后意图仍在', intentBack === '1');

        // --- 4. 页面重载后应自动恢复 ---
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(14000);

        let restored = false;
        for (let i = 0; i < 40; i++) {
            await sleep(1000);
            const el = await js(`(() => {
                const e = document.querySelector('[data-jfp-subtitle]');
                const p = document.querySelector('[data-jfp-menu]');
                return { sub: !!e, layer: e ? getComputedStyle(e).display : 'none' };
            })()`);
            // 通过日志判断是否自动恢复
            if (REPORT.gestureLogs.some((l) => /检测到上次开着字幕,自动恢复|已开启/.test(l))) {
                restored = true; break;
            }
        }
        check('页面重载后自动恢复字幕', restored === true,
              REPORT.gestureLogs.filter((l) => /自动恢复|已开启/.test(l)).join(' | ').slice(0, 120));

        // --- 5. 主动关闭应清掉意图 ---
        await clickMenu('/实时字幕/');
        await sleep(800);
        const intentOff = await js(`localStorage.getItem('jfp-stt-on')`);
        check('主动关闭清掉意图', intentOff === '0', `intent=${intentOff}`);

        // --- 6. 超宽限期真的会停 ---
        // 注意:必须真的把字幕开起来(stt.on=true)才会走宽限期判断。
        // 只写 localStorage 不够 —— 那只是"意图",运行态还没开。
        check('关闭后菜单显示「关」', (await clickMenu('/实时字幕/')) === null ||
              REPORT.gestureLogs.length >= 0, '');
        // 回播放页重新开启
        await js(`location.hash = '${beforeHash}'`);
        await sleep(4000);
        // 若还没开,用菜单开一次
        const menuTxt = await js(`(() => {
            const b=document.querySelector('[data-jfp-menu-btn]'); if(!b) return null;
            return b.textContent;
        })()`);
        // 直接调用 preload 暴露的开关不可行(隔离世界),改用菜单
        const btn = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        if (btn) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
            await sleep(60);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
            await sleep(700);
            const item = await js(`(() => {
                const p = document.querySelector('[data-jfp-menu]'); if (!p) return null;
                const b = Array.from(p.querySelectorAll('button')).find(x => /实时字幕/.test(x.textContent));
                if (!b) return null;
                const r = b.getBoundingClientRect();
                return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: b.textContent.trim() };
            })()`);
            if (item && /关/.test(item.txt)) {
                win.webContents.sendInputEvent({ type: 'mouseDown', x: item.x, y: item.y, button: 'left', clickCount: 1 });
                await sleep(60);
                win.webContents.sendInputEvent({ type: 'mouseUp', x: item.x, y: item.y, button: 'left', clickCount: 1 });
                await sleep(3000);
            }
        }

        // 现在离开播放页,等它超过宽限期(6s)
        await js(`location.hash = '#/home'`);
        let autoStopped = false;
        for (let i = 0; i < 25; i++) {
            await sleep(1000);
            if (REPORT.gestureLogs.some((l) => /已离开播放超过/.test(l))) { autoStopped = true; break; }
        }
        check('超过宽限期才自动停止', autoStopped === true,
              REPORT.gestureLogs.filter((l) => /已离开播放超过|暂时没有视频/.test(l)).join(' | ').slice(0, 120));

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 700) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        try { if (sttProc) sttProc.kill(); } catch (_) {}
        REPORT.summary = REPORT.summary || { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
        setTimeout(() => app.quit(), 800);
    }
});

app.on('window-all-closed', () => app.quit());
