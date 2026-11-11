'use strict';

/**
 * 验证字幕生成稳定性:开启后持续播放,确认服务不中断、字幕持续产出。
 * 用法: jellyfin-player.exe <runtime> --probe-verify --item <id>
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

const REPORT = { checks: [], gestureLogs: [], sttLog: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgPath = path.join(REPO, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.debug = true;

let sttProc = null;
const PORT = cfg.sttPort || 8765;

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
    sttProc = spawn(py, [s, '--port', String(PORT), '--preload'], {
        cwd: path.dirname(s), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    sttProc.stdout.on('data', (d) => { const t = String(d).trim(); if (t) REPORT.sttLog.push(t); });
    sttProc.stderr.on('data', (d) => { const t = String(d).trim(); if (t) REPORT.sttLog.push('[!]' + t); });
    sttProc.on('exit', (c) => { REPORT.sttLog.push('EXIT code=' + c); sttProc = null; });
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
ipcMain.handle('settings:save', () => ({ ok: true, path: cfgPath }));
ipcMain.handle('settings:get', () => ({ ok: true, cfg }));

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
        // 清干净起手
        await win.loadURL('http://127.0.0.1:8096/web/?c=' + Date.now() + '#/home');
        await sleep(4000);
        await js(`localStorage.removeItem('jfp-stt-on')`);

        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(17000);

        const hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        check('进入播放页', hasVideo === true);
        if (!hasVideo) throw new Error('未进入播放页');

        // 手动开启
        // 等菜单按钮挂上(preload 的 1s 自愈定时器可能需要一轮)
        let btn = null;
        for (let i = 0; i < 20; i++) {
            btn = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
            if (btn) break;
            await sleep(500);
        }
        check('菜单按钮存在', !!btn, btn ? `(${btn.x},${btn.y})` : '等 10 秒仍无');
        if (!btn) {
            REPORT.domProbe = await js(`(() => ({
                url: location.href,
                hasDocEl: !!document.documentElement,
                menuBtn: !!document.querySelector('[data-jfp-menu-btn]'),
                navBtns: document.querySelectorAll('[data-jfp-nav]').length,
                uiStyle: !!document.querySelector('[data-jfp-ui]'),
                cursor: !!document.querySelector('[data-jfp-cursor]'),
            }))()`);
            throw new Error('找不到菜单按钮: ' + JSON.stringify(REPORT.domProbe));
        }

        win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(800);

        const menuDump = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            if (!p) return { open: false };
            return { open: true, items: Array.from(p.querySelectorAll('button')).map(b => b.textContent.trim()) };
        })()`);
        REPORT.menuDump = menuDump;
        check('菜单已打开', menuDump.open === true, JSON.stringify(menuDump.items || []));

        const item = await js(`(() => { const p=document.querySelector('[data-jfp-menu]'); if(!p) return null;
            const b=Array.from(p.querySelectorAll('button')).find(x=>/实时字幕/.test(x.textContent));
            if(!b) return null; const r=b.getBoundingClientRect();
            return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        check('菜单含实时字幕项', !!item, item ? `(${item.x},${item.y})` : 'null');
        if (!item) throw new Error('菜单没有实时字幕项');
        win.webContents.sendInputEvent({ type: 'mouseDown', x: item.x, y: item.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: item.x, y: item.y, button: 'left', clickCount: 1 });

        // 持续观察 60 秒,看是否稳定
        let firstCue = null;
        let maxCues = 0;
        let serviceDied = false;
        const samples = [];
        for (let i = 0; i < 60; i++) {
            await sleep(1000);
            // 服务还活着吗
            const alive = sttProc !== null;
            if (!alive) { serviceDied = true; }
            let st = null;
            try {
                const r = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(2000) });
                st = await r.json();
            } catch (_) {}
            if (st && st.cues > 0) {
                if (firstCue === null) firstCue = i;
                maxCues = Math.max(maxCues, st.cues);
            }
            if (i % 10 === 0) {
                samples.push({ t: i, alive, cues: st ? st.cues : -1,
                               done: st ? st.doneUntil : -1, lead: st ? st.leadSeconds : null });
            }
            // 模拟播放推进
            if (st && st.position !== undefined) {
                try {
                    const v = await js(`document.querySelector('video') ? document.querySelector('video').currentTime : 0`);
                    await fetch(`http://127.0.0.1:${PORT}/position`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ time: v, playing: true, mediaKey: ITEM_ID })
                    });
                } catch (_) {}
            }
            if (maxCues > 30) break;
        }
        REPORT.samples = samples;

        check('字幕服务全程未退出', serviceDied === false, serviceDied ? '服务中途退出' : 'ok');
        check('产出了字幕', maxCues > 0, `最多 ${maxCues} 条, 首次出现于第 ${firstCue}s`);
        check('字幕持续增长', maxCues >= 5, `${maxCues} 条`);

        // 服务日志里不应有 EXIT
        const exits = REPORT.sttLog.filter(l => l.startsWith('EXIT'));
        check('服务日志无异常退出', exits.length === 0, exits.join(',') || 'ok');

        // 识别耗时应正常(不应有 20s+)
        const slow = REPORT.sttLog.filter(l => {
            const m = /识别([\d.]+)/.exec(l);
            return m && parseFloat(m[1]) > 8;
        });
        REPORT.slowWindows = slow;
        check('无异常慢窗口(<8s)', slow.length === 0,
              slow.length ? slow.slice(0,2).join(' | ') : 'ok');

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
        setTimeout(() => app.quit(), 700);
    }
});

app.on('window-all-closed', () => app.quit());
