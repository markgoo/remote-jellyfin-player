'use strict';

/**
 * 验证:只放大控件热区,界面版式/字号/控制栏高度不应变化。
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

const REPORT = { checks: [], before: {}, after: {} };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
    serverUrl: 'http://127.0.0.1:8096', seekMode: 'scaled', seekStepSeconds: 10,
    pixelsPerStep: 250, seekMinSeconds: 5, seekMaxSeconds: 60, volumeStep: 0.1,
    swipeThresholdPx: 80, swipeMaxMs: 800, axisLockPx: 10, doubleTapMs: 300, toastMs: 900,
    enableBackGesture: true, backEdgeWidthPx: 48, backSwipeThresholdPx: 100,
    enableBigControls: true, osdButtonMinPx: 60, sliderHeightPx: 46, sliderThumbPx: 28,
    menuButtonSizePx: 48, debug: true,
};

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs = (REPORT.gestureLogs || []).concat(String(m)); });
ipcMain.on('app-quit', () => app.quit());
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const check = (name, ok, detail) => {
    REPORT.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    save();
};

const SHOW_OSD = `(() => {
    const b = document.querySelector('.videoOsdBottom');
    if (b) { b.classList.remove('hide'); b.style.opacity='1'; }
    document.body.classList.remove('mouseIdle');
    return true;
})()`;

// 同时测量"控件尺寸"和"界面尺度"(字号、控制栏高度、卡片尺寸)
const MEASURE = `(() => {
    const info = (el) => el ? (r=>({w:Math.round(r.width),h:Math.round(r.height)}))(el.getBoundingClientRect()) : null;
    const btns = Array.from(document.querySelectorAll('.osdControls button, .videoOsdBottom button')).map(info).filter(x=>x&&x.w>0);
    const sl = document.querySelector('.osdControls input[type=range], .sliderContainer input[type=range]');
    const bar = document.querySelector('.videoOsdBottom');
    const title = document.querySelector('.osdTitle');
    return {
        htmlFont: getComputedStyle(document.documentElement).fontSize,
        bodyFont: getComputedStyle(document.body).fontSize,
        btns: btns.slice(0,6),
        slider: info(sl),
        bar: info(bar),
        barFits: bar ? bar.getBoundingClientRect().bottom <= innerHeight + 1 : null,
        titleFont: title ? getComputedStyle(title).fontSize : null,
    };
})()`;

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
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(16000);

        // 先移除放大样式,测出"原始"基准
        await js(`(() => { const s=document.querySelector('[data-jfp-ui]'); if(s) s.remove(); return true; })()`);
        await js(SHOW_OSD);
        await sleep(500);
        REPORT.before = await js(MEASURE);

        // 再把样式加回来(模拟自愈定时器重挂)
        await js(`(() => {
            const st = document.createElement('style');
            st.setAttribute('data-jfp-ui','');
            st.textContent = ${JSON.stringify(REQUIRE_CSS())};
            document.documentElement.appendChild(st);
            return true;
        })()`);
        await js(SHOW_OSD);
        await sleep(600);
        REPORT.after = await js(MEASURE);

        const b = REPORT.before, a = REPORT.after;

        check('界面字号未变(html 根字号)',
              b.htmlFont === a.htmlFont, `${b.htmlFont} vs ${a.htmlFont}`);
        check('界面字号未变(body 字号)',
              b.bodyFont === a.bodyFont, `${b.bodyFont} vs ${a.bodyFont}`);
        check('播放器标题字号未变',
              b.titleFont === a.titleFont, `${b.titleFont} vs ${a.titleFont}`);
        check('OSD 按钮确实放大',
              !!(a.btns.length && b.btns.length && a.btns[0].w > b.btns[0].w + 10),
              `${b.btns[0] ? b.btns[0].w+'x'+b.btns[0].h : '?'} → ${a.btns[0] ? a.btns[0].w+'x'+a.btns[0].h : '?'}`);
        check('进度条确实加厚',
              !!(a.slider && b.slider && a.slider.h > b.slider.h + 8),
              `${b.slider ? b.slider.h : '?'} → ${a.slider ? a.slider.h : '?'}`);
        check('控制栏高度基本不变(<15% 增长)',
              !!(a.bar && b.bar && a.bar.h <= b.bar.h * 1.15),
              `${b.bar ? b.bar.h : '?'}px → ${a.bar ? a.bar.h : '?'}px`);
        check('控制栏仍不超出屏幕', a.barFits === true);

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0,600) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        save();
        setTimeout(() => app.quit(), 600);
    }
});

// 复刻 preload 里的 CSS,便于对比测量
function REQUIRE_CSS() {
    const btnMin = cfg.osdButtonMinPx, sliderH = cfg.sliderHeightPx, thumb = cfg.sliderThumbPx;
    const iconSize = Math.round(btnMin / 2);
    return [
        `.osdControls button, .videoOsdBottom button { min-width:${btnMin}px !important; min-height:${btnMin}px !important; padding:8px !important; }`,
        `.osdControls button .material-icons, .videoOsdBottom button .material-icons { font-size:${iconSize}px !important; }`,
        `.osdControls input[type="range"], .sliderContainer input[type="range"] { height:${sliderH}px !important; }`,
        `.osdControls input[type="range"]::-webkit-slider-thumb, .sliderContainer input[type="range"]::-webkit-slider-thumb { width:${thumb}px !important; height:${thumb}px !important; }`,
        `.detailButton, .btnPlay, .itemAction, .cardOverlayButton { min-width:${Math.round(btnMin*0.9)}px !important; min-height:${Math.round(btnMin*0.9)}px !important; }`,
        `.mainDrawerButton, .headerButton, .btnBack, .btnHome { min-width:${Math.round(btnMin*0.9)}px !important; min-height:${Math.round(btnMin*0.9)}px !important; }`,
    ].join('\n');
}

app.on('window-all-closed', () => app.quit());
