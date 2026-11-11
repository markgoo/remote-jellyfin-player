'use strict';

/**
 * 集成测试:真实 Jellyfin 播放页 → 点 ☰ → 开启实时字幕 → 验证字幕出现。
 * 用法: jellyfin-player.exe <runtime> --probe-verify --item <id>
 *
 * 注意:会真的启动 Python 字幕服务并使用 GPU。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const REPO = process.env.JFP_REPO || 'C:\\AI\\jellyfinplayer';
const OUT = path.join(REPO, '.verify-out.json');
const argv = process.argv;
const argVal = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : ''; };
const ITEM_ID = argVal('--item');

const REPORT = { checks: [], sttLog: [], gestureLogs: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
    serverUrl: 'http://127.0.0.1:8096', seekMode: 'scaled', seekStepSeconds: 10,
    pixelsPerStep: 250, seekMinSeconds: 5, seekMaxSeconds: 60, volumeStep: 0.1,
    swipeThresholdPx: 80, swipeMaxMs: 800, axisLockPx: 10, doubleTapMs: 300, toastMs: 900,
    enableBackGesture: true, backEdgeWidthPx: 48, backSwipeThresholdPx: 100,
    enableBigControls: true, osdButtonMinPx: 60, sliderHeightPx: 46, sliderThumbPx: 28,
    menuButtonSizePx: 48,
    enableLiveSubtitle: true, sttPort: 8765, sttPreload: true,
    sttDevice: 'cuda', sttComputeType: 'float16', sttModelPath: '',
    sttLanguage: 'ja', sttLlm: 'qwen3.5:9b',
    sttWindowSeconds: 10, sttLookaheadSeconds: 60,
    subtitleShowSource: true, subtitleFontPx: 30, subtitleBottomPx: 90,
    debug: true,
};

// ---------- 复刻主进程的字幕服务管理 ----------
let sttProc = null;
const STT_PORT = 8765;

function sttScriptPath() {
    const cands = [
        path.join(path.dirname(process.execPath), 'tools', 'stt', 'server.py'),
        path.join(REPO, 'tools', 'stt', 'server.py'),
    ];
    for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
    return null;
}
function sttPythonPath() {
    const cands = [
        path.join(path.dirname(process.execPath), '.stt', 'venv', 'Scripts', 'python.exe'),
        path.join(REPO, '.stt', 'venv', 'Scripts', 'python.exe'),
    ];
    for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (_) {} }
    return null;
}

function ensureSttService() {
    if (sttProc) return { ok: true, port: STT_PORT };
    const script = sttScriptPath();
    const python = sttPythonPath();
    if (!script || !python) return { ok: false, error: `缺脚本=${!script} 缺环境=${!python}` };

    sttProc = spawn(python, [script, '--port', String(STT_PORT), '--preload'], {
        cwd: path.dirname(script), windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    sttProc.stdout.on('data', (d) => {
        const s = String(d).trim();
        if (s) { REPORT.sttLog.push(s); console.log(`[stt] ${s}`); }
    });
    sttProc.stderr.on('data', (d) => {
        const s = String(d).trim();
        if (s) { REPORT.sttLog.push('[!] ' + s); console.log(`[stt!] ${s}`); }
    });
    sttProc.on('exit', (c) => { REPORT.sttLog.push(`exit=${c}`); sttProc = null; });
    return { ok: true, port: STT_PORT };
}

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
        } catch (err) { lastErr = err.message; }
        await sleep(500);
    }
    return { ok: false, error: `未就绪: ${lastErr}` };
}

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); console.log('[gesture] ' + m); });
ipcMain.on('app-quit', () => app.quit());
ipcMain.handle('stt:ensure', () => ensureSttService());
ipcMain.handle('stt:start', async (_e, opts) => {
    const up = ensureSttService();
    if (!up.ok) return up;
    const ready = await waitSttReady(up.port);
    if (!ready.ok) { REPORT.sttLog.push('[!] ' + ready.error); return { ok: false, error: ready.error }; }
    REPORT.sttLog.push(`[ready] ${JSON.stringify(ready)}`);
    try {
        const r = await fetch(`http://127.0.0.1:${up.port}/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts),
        });
        return await r.json();
    } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('stt:position', async (_e, pos) => {
    if (!sttProc) return { ok: false };
    try {
        const r = await fetch(`http://127.0.0.1:${STT_PORT}/position`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pos),
        });
        return await r.json();
    } catch (_) { return { ok: false }; }
});
ipcMain.handle('stt:cues', async (_e, q) => {
    if (!sttProc) return { cues: [], status: null };
    try {
        const r = await fetch(`http://127.0.0.1:${STT_PORT}/cues?from=${q.from}&to=${q.to}`);
        return await r.json();
    } catch (_) { return { cues: [], status: null }; }
});
ipcMain.handle('stt:stop', async () => {
    if (!sttProc) return { ok: true };
    try {
        const r = await fetch(`http://127.0.0.1:${STT_PORT}/stop`, { method: 'POST' });
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

    try {
        // 进入播放页
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);

        // 点播放:详情页主按钮
        const clicked = await js(`(() => {
            const b = document.querySelector('.btnPlay');
            if (b) { b.click(); return 'btnPlay'; }
            const alt = Array.from(document.querySelectorAll('button'))
                .find(x => /^(播放|Play)/i.test((x.textContent||'').trim()));
            if (alt) { alt.click(); return 'text'; }
            return 'none';
        })()`);
        REPORT.playClick = clicked;
        console.log('play click: ' + clicked);
        await sleep(18000);

        // 兜底:若还在详情页,再试一次
        let hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        if (!hasVideo) {
            const again = await js(`(() => {
                const b = document.querySelector('.btnPlay');
                if (b) { b.click(); return true; }
                return false;
            })()`);
            REPORT.playClick2 = again;
            if (again) await sleep(16000);
            hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        }

        check('进入播放页', hasVideo === true, win.webContents.getURL());
        if (!hasVideo) throw new Error('未进入播放页: ' + win.webContents.getURL());

        // 打开菜单,确认有实时字幕项
        const btn = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(600);

        const menuItems = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            return p ? Array.from(p.querySelectorAll('button')).map(b => b.textContent.trim()) : [];
        })()`);
        REPORT.menuItems = menuItems;
        check('菜单含「实时字幕」', menuItems.some(t => /实时字幕/.test(t)), menuItems.join(' | '));

        // 点「实时字幕」
        const liveBtn = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            if (!p) return null;
            const b = Array.from(p.querySelectorAll('button')).find(x => /实时字幕/.test(x.textContent));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
        })()`);
        if (!liveBtn) throw new Error('找不到实时字幕菜单项');

        win.webContents.sendInputEvent({ type: 'mouseDown', x: liveBtn.x, y: liveBtn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: liveBtn.x, y: liveBtn.y, button: 'left', clickCount: 1 });
        await sleep(3000);

        // 等服务启动 + 首个窗口
        REPORT.sttLog.length = 0;
        let cues = 0;
        for (let i = 0; i < 40; i++) {      // 最多等 40 秒
            await sleep(1000);
            const st = await js(`(() => {
                const el = document.querySelector('[data-jfp-subtitle]');
                return { exists: !!el, visible: el ? getComputedStyle(el).display !== 'none' : false };
            })()`);
            // 用主进程直接查服务
            try {
                const r = await fetch(`http://127.0.0.1:${STT_PORT}/status`);
                const s = await r.json();
                if (s && s.cues > 0) { cues = s.cues; REPORT.status = s; break; }
            } catch (_) { /* 服务还没起 */ }
        }
        check('字幕服务产生了字幕', cues > 0, `cues=${cues}`);
        if (REPORT.status) {
            check('字幕领先播放位置',
                  REPORT.status.leadSeconds !== undefined && REPORT.status.leadSeconds >= 0,
                  `lead=${REPORT.status.leadSeconds}s position=${REPORT.status.position}s`);
        }

        // 等字幕真正渲染出来
        await sleep(3000);
        const rendered = await js(`(() => {
            const el = document.querySelector('[data-jfp-subtitle]');
            if (!el) return { exists: false };
            return { exists: true, visible: getComputedStyle(el).display !== 'none',
                     text: el.textContent.trim(), html: el.innerHTML.length };
        })()`);
        REPORT.rendered = rendered;
        check('字幕层已创建', rendered.exists === true);
        check('字幕已渲染到画面', !!(rendered.exists && rendered.html > 0),
              rendered.text ? rendered.text.slice(0, 80) : '(空)');

        // 关闭开关
        await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); return !!b; })()`);
        const btn2 = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: btn2.x, y: btn2.y, button: 'left', clickCount: 1 });
        await sleep(600);
        const liveBtn2 = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            if (!p) return null;
            const b = Array.from(p.querySelectorAll('button')).find(x => /实时字幕/.test(x.textContent));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), txt: b.textContent.trim() };
        })()`);
        REPORT.liveBtn2 = liveBtn2;
        check('再次打开菜单时开关显示「开」', !!(liveBtn2 && /开/.test(liveBtn2.txt)), liveBtn2 && liveBtn2.txt);

        if (liveBtn2) {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: liveBtn2.x, y: liveBtn2.y, button: 'left', clickCount: 1 });
            await sleep(60);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: liveBtn2.x, y: liveBtn2.y, button: 'left', clickCount: 1 });
            await sleep(1500);
            const afterOff = await js(`(() => {
                const el = document.querySelector('[data-jfp-subtitle]');
                return el ? getComputedStyle(el).display : 'no-el';
            })()`);
            check('关闭后字幕层隐藏', afterOff === 'none' || afterOff === 'no-el', afterOff);
        }

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 800) }];
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
