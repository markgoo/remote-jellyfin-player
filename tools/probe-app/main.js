'use strict';

/**
 * 全量验证:手势(返回/快进/音量/不暂停/单击) + 选项菜单 + 控件放大。
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

const cfg = {
    serverUrl: 'http://127.0.0.1:8096', seekMode: 'scaled', seekStepSeconds: 10,
    pixelsPerStep: 250, seekMinSeconds: 5, seekMaxSeconds: 60, volumeStep: 0.1,
    swipeThresholdPx: 80, swipeMaxMs: 800, axisLockPx: 10, doubleTapMs: 300, toastMs: 900,
    enableBackGesture: true, backEdgeWidthPx: 48, backSwipeThresholdPx: 100,
    enableBigControls: true, uiScale: 1.18, osdButtonMinPx: 60, sliderHeightPx: 46,
    menuButtonSizePx: 48, debug: true,
};

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); console.log('[gesture] ' + m); });
ipcMain.on('app-quit', () => { REPORT.gestureLogs.push('app-quit received'); save(); });
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

    async function swipe(fromX, fromY, dx, dy, settle = 1200) {
        win.webContents.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1 });
        await sleep(30);
        for (let i = 1; i <= 8; i++) {
            win.webContents.sendInputEvent({
                type: 'mouseMove', x: Math.round(fromX + dx * i / 8), y: Math.round(fromY + dy * i / 8),
                button: 'left', modifiers: ['leftButtonDown'],
            });
            await sleep(16);
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', x: fromX + dx, y: fromY + dy, button: 'left', clickCount: 1 });
        await sleep(settle);
    }

    try {
        // ---------- 首页 ----------
        await win.loadURL('http://127.0.0.1:8096/web/#/home');
        await sleep(6500);

        check('选项按钮存在(☰)',
              (await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); return b ? b.textContent === '☰' : false; })()`)) === true);
        check('旧 ✕ 按钮已移除', (await js(`!document.querySelector('[data-jfp-exit]')`)) === true);
        check('控件放大样式已注入', (await js(`!!document.querySelector('[data-jfp-ui]')`)) === true);

        // 提示浮层位置
        await swipe(10, 300, 200, 0, 500);
        const toast = await js(`(() => {
            const t = document.querySelector('[data-jfp-toast]');
            if (!t) return null;
            const r = t.getBoundingClientRect();
            return { left: Math.round(r.left), bottom: Math.round(innerHeight - r.bottom), font: getComputedStyle(t).fontSize };
        })()`);
        check('提示在左下角且不显眼',
              !!(toast && toast.left < 60 && toast.bottom < 60 && parseFloat(toast.font) <= 16),
              toast ? `left=${toast.left} bottom=${toast.bottom} font=${toast.font}` : 'null');

        // 边缘返回(首页提示已在首页)
        const c1 = REPORT.gestureLogs.filter(l => /^back requested/.test(l)).length;
        await swipe(10, 300, 220, 0, 900);
        const c2 = REPORT.gestureLogs.filter(l => /^back requested/.test(l)).length;
        check('左边缘右滑触发返回', c2 === c1 + 1, `${c1} → ${c2}`);

        const c3 = REPORT.gestureLogs.filter(l => /^back requested/.test(l)).length;
        await swipe(10, 300, 60, 0, 600);
        check('边缘短滑不触发返回',
              REPORT.gestureLogs.filter(l => /^back requested/.test(l)).length === c3);

        // ---------- 播放页 ----------
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);

        // 详情页真实返回
        const detailHash = await js('location.hash');
        await swipe(10, 300, 220, 0, 1500);
        const afterBack = await js('location.hash');
        check('详情页边缘右滑可返回',
              detailHash !== afterBack && !/details/.test(afterBack),
              `${detailHash} → ${afterBack}`);

        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(8000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(16000);

        const hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        check('进入播放页', hasVideo === true);
        if (!hasVideo) throw new Error('未进入播放页');

        await js(`(() => { const v=document.querySelector('video'); if(v&&v.paused) v.play(); return true; })()`);
        await sleep(800);

        const geo = await js('JSON.stringify({w:innerWidth,h:innerHeight})').then(JSON.parse);
        const cx = Math.round(geo.w / 2), cy = Math.round(geo.h / 2);
        const state = () => js(`(() => { const v=document.querySelector('video'); return v ? {
            ct:v.currentTime, paused:v.paused, vol:v.volume, dur:v.duration } : null; })()`);

        async function vswipe(dx, dy) {
            const before = await state();
            await swipe(cx, cy, dx, dy, 1200);
            const after = await state();
            return { before, after, moved: (after && before) ? after.ct - before.ct : 0 };
        }

        const a1 = await vswipe(300, 0);
        check('右滑后仍在播放(不暂停)', !!(a1.after && a1.after.paused === false), `paused=${a1.after && a1.after.paused}`);
        const a2 = await vswipe(-300, 0);
        check('左滑后仍在播放(不暂停)', !!(a2.after && a2.after.paused === false), `paused=${a2.after && a2.after.paused}`);

        const reset = async () => { await js(`(()=>{const v=document.querySelector('video'); if(v) v.currentTime=60; return true;})()`); await sleep(400); };
        await reset(); const s150 = await vswipe(150, 0);
        await reset(); const s400 = await vswipe(400, 0);
        await reset(); const s1200 = await vswipe(1200, 0);
        check('短滑快进少(≈6s)', s150.moved > 3 && s150.moved < 10, `${s150.moved.toFixed(1)}s`);
        check('中滑快进中(≈16s)', s400.moved > 10 && s400.moved < 25, `${s400.moved.toFixed(1)}s`);
        check('长滑不超上限(≤60s)', s1200.moved > 30 && s1200.moved <= 61, `${s1200.moved.toFixed(1)}s`);
        check('越远快进越多', s1200.moved > s400.moved && s400.moved > s150.moved);

        // 音量
        await js(`(() => { const v=document.querySelector('video'); if(v) v.volume=0.5; return true; })()`);
        await sleep(200);
        const up = await vswipe(0, -120);
        check('上滑音量+', !!(up.after && up.after.vol > up.before.vol + 0.02),
              `${up.before.vol.toFixed(2)} → ${up.after.vol.toFixed(2)}`);
        const dn = await vswipe(0, 120);
        check('下滑音量-', !!(dn.after && dn.after.vol < dn.before.vol - 0.02),
              `${dn.before.vol.toFixed(2)} → ${dn.after.vol.toFixed(2)}`);

        // 单选仍为原生暂停
        await js(`(() => { const v=document.querySelector('video'); if(v&&v.paused) v.play(); return true; })()`);
        await sleep(600);
        const tb = await state();
        win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
        await sleep(40);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
        await sleep(1100);
        const ta = await state();
        check('单击仍触发原生暂停',
              !!(tb && ta && tb.paused === false && ta.paused === true),
              `${tb && tb.paused} → ${ta && ta.paused}`);

        // 播放页控件放大
        await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            if (b) { b.classList.remove('hide'); b.style.opacity='1'; }
            document.body.classList.remove('mouseIdle');
            return true;
        })()`);
        await sleep(400);
        const ui = await js(`(() => {
            const info = (el) => el ? (r=>({w:Math.round(r.width),h:Math.round(r.height)}))(el.getBoundingClientRect()) : null;
            const btns = Array.from(document.querySelectorAll('.osdControls button, .videoOsdBottom button')).map(info).filter(x=>x&&x.w>0);
            const sl = document.querySelector('.osdControls input[type=range], .sliderContainer input[type=range]');
            const bar = document.querySelector('.videoOsdBottom');
            return { btns: btns.slice(0,6), slider: info(sl),
                     fits: bar ? bar.getBoundingClientRect().bottom <= innerHeight + 1 : null };
        })()`);
        check('播放页 OSD 按钮 >=60px',
              !!(ui.btns.length && ui.btns.every(b => b.w >= 58 && b.h >= 58)),
              ui.btns.map(b=>`${b.w}x${b.h}`).join(', '));
        check('进度条 >=44px 高', !!(ui.slider && ui.slider.h >= 44),
              ui.slider ? `${ui.slider.w}x${ui.slider.h}` : 'null');
        check('控制栏不超出屏幕', ui.fits === true);

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 700) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        REPORT.summary = REPORT.summary || { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
        setTimeout(() => app.quit(), 600);
    }
});

app.on('window-all-closed', () => app.quit());
