'use strict';

/**
 * 验证:播放页的 ☰ 悬浮按钮能否手工打开/关闭 Jellyfin 控制栏。
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

const REPORT = { checks: [], gestureLogs: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
cfg.debug = true;
cfg.enableLiveSubtitle = false;

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); console.log('[g] ' + m); });
ipcMain.on('app-quit', () => app.quit());
for (const h of ['stt:ensure','stt:start','stt:position','stt:cues','stt:stop','settings:save','settings:get'])
    ipcMain.handle(h, () => ({ ok: false, cues: [], status: null }));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const check = (name, ok, detail) => {
    REPORT.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    save();
};

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        fullscreen: true, frame: false, show: true, backgroundColor: '#000',
        webPreferences: {
            preload: path.join(REPO, 'src', 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
    });
    const js = (c) => win.webContents.executeJavaScript(c, true);

    const osdState = () => js(`(() => {
        const b = document.querySelector('.videoOsdBottom');
        const h = document.querySelector('.skinHeader');
        const info = (el) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { h: Math.round(r.height), opacity: getComputedStyle(el).opacity,
                     cls: String(el.className).slice(0, 90) };
        };
        return { bottom: info(b), header: info(h) };
    })()`);

    const clickBtn = async (name) => {
        const b = await js(`(() => {
            const el = document.querySelector('[data-jfp-nav="${name}"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2),
                     w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top) };
        })()`);
        if (!b) return null;
        win.webContents.sendInputEvent({ type: 'mouseDown', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
        await sleep(800);
        return b;
    };

    try {
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(18000);

        const hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        check('进入播放页', hasVideo === true);
        if (!hasVideo) throw new Error('未进入播放页');

        await sleep(7000);   // 等 OSD 自动隐藏

        // 1. ☰ 按钮存在
        const osdBtn = await js(`(() => {
            const el = document.querySelector('[data-jfp-nav="osd"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width),
                     cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2),
                     text: el.textContent };
        })()`);
        check('播放页有 ☰ 控制栏按钮', !!osdBtn, osdBtn ? `${osdBtn.text} (${osdBtn.left},${osdBtn.top}) ${osdBtn.w}px` : 'null');
        if (!osdBtn) throw new Error('找不到 osd 按钮');

        // 2. 先确认自动隐藏了
        let st = await osdState();
        check('控制栏当前已自动隐藏', st.bottom.h === 0, `h=${st.bottom.h} opacity=${st.bottom.opacity}`);

        // 3. 点 ☰ → 应显示
        await clickBtn('osd');
        st = await osdState();
        check('点 ☰ 控制栏出现', st.bottom.h > 100, `h=${st.bottom.h} opacity=${st.bottom.opacity}`);

        // 4. 等 3 秒,应保持显示(固定)
        await sleep(3000);
        st = await osdState();
        check('3 秒后仍保持显示(不会被自动收回)', st.bottom.h > 100, `h=${st.bottom.h}`);

        // 5. 按钮高亮表示已固定
        const pinned = await js(`(() => { const el=document.querySelector('[data-jfp-nav="osd"]'); return el ? el.dataset.pinned : null; })()`);
        check('按钮显示为已固定状态', pinned === '1', `pinned=${pinned}`);

        // 6. 再点 → 收起
        await clickBtn('osd');
        st = await osdState();
        check('再点 ☰ 控制栏收起', st.bottom.h === 0, `h=${st.bottom.h}`);

        // 7. 再点 → 又出现
        await clickBtn('osd');
        await sleep(1000);
        st = await osdState();
        check('第三次点 ☰ 再次出现', st.bottom.h > 100, `h=${st.bottom.h}`);

        // 8. 日志有记录
        const hasLog = REPORT.gestureLogs.some(l => /osd: 显示并固定|osd: 收起/.test(l));
        check('操作有日志', hasLog,
              REPORT.gestureLogs.filter(l=>/osd:/.test(l)).join(' | ').slice(0,120));

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 700) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        REPORT.summary = REPORT.summary || { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
        setTimeout(() => app.quit(), 700);
    }
});

app.on('window-all-closed', () => app.quit());
