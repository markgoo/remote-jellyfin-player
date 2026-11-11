'use strict';

/**
 * 在真实分辨率下测量虚拟按键位置。
 * 关键:不使用固定 1280x720 测试窗口,直接在全屏 2196x1270 下量。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = process.env.JFP_REPO || 'C:\\AI\\jellyfinplayer';
const OUT = path.join(REPO, '.verify-out.json');
const argv = process.argv;
const argVal = (n) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : ''; };
const ITEM_ID = argVal('--item');

const REPORT = { checks: [], gestureLogs: [], measures: {} };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfgPath = path.join(REPO, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.debug = true;
cfg.enableLiveSubtitle = false;

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); });
ipcMain.on('app-quit', () => app.quit());
for (const h of ['stt:ensure','stt:start','stt:position','stt:cues','stt:stop','settings:save','settings:get'])
    ipcMain.handle(h, () => ({ ok: false, cues: [], status: null, path: cfgPath }));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const check = (name, ok, detail) => {
    REPORT.checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
    save();
};

app.whenReady().then(async () => {
    // 关键:不指定 width/height,用 fullscreen:true 匹配真实分辨率
    const win = new BrowserWindow({
        fullscreen: true,
        frame: false,
        show: true,
        backgroundColor: '#000',
        webPreferences: {
            preload: path.join(REPO, 'src', 'preload.js'),
            contextIsolation: true, nodeIntegration: false,
        },
    });
    const js = (c) => win.webContents.executeJavaScript(c, true);

    const getNav = () => js(`(() => {
        return Array.from(document.querySelectorAll('[data-jfp-nav]')).map(el => {
            const r = el.getBoundingClientRect();
            return { name: el.getAttribute('data-jfp-nav'), text: el.textContent,
                     w: Math.round(r.width), h: Math.round(r.height),
                     left: Math.round(r.left), top: Math.round(r.top),
                     right: Math.round(r.right), bottom: Math.round(r.bottom),
                     cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) };
        });
    })()`);

    try {
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(17000);

        const viewport = await js(`JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height})`).then(JSON.parse);
        REPORT.measures.viewport = viewport;
        check('视口尺寸', viewport.w > 0, JSON.stringify(viewport));

        await sleep(2500);
        const nav = await getNav();
        REPORT.measures.nav = nav;

        const prev = nav.find(n => n.name === 'prev');
        const next = nav.find(n => n.name === 'next');
        const back = nav.find(n => n.name === 'back');

        // 播放页布局期望:◀ 贴左、▶ 贴右、↩ 左上
        check('◀ 在左侧(左边缘 < 200px)',
              prev && prev.left < 200, prev ? `left=${prev.left}` : 'null');
        check('◀ 垂直居中(中心偏差 < 15% 屏高)',
              prev && Math.abs(prev.cy - viewport.h / 2) < viewport.h * 0.15,
              prev ? `cy=${prev.cy} 期望≈${Math.round(viewport.h/2)}` : 'null');

        check('▶ 在右侧(距右边缘 < 200px)',
              next && (viewport.w - next.right) < 200,
              next ? `right=${next.right} 屏宽=${viewport.w} 距右=${viewport.w - next.right}` : 'null');
        check('▶ 垂直居中(中心偏差 < 15% 屏高)',
              next && Math.abs(next.cy - viewport.h / 2) < viewport.h * 0.15,
              next ? `cy=${next.cy} 期望≈${Math.round(viewport.h/2)}` : 'null');

        check('↩ 在左上区域',
              back && back.left < 200 && back.top < 200,
              back ? `(${back.left},${back.top})` : 'null');

        check('按键不重叠',
              prev && next && (next.left - prev.right) > 100,
              prev && next ? `间距=${next.left - prev.right}px` : 'null');

        // 点一下真实验证
        if (next) {
            const v0 = await js(`document.querySelector('video').currentTime`);
            win.webContents.sendInputEvent({ type: 'mouseDown', x: next.cx, y: next.cy, button: 'left', clickCount: 1 });
            await sleep(60);
            win.webContents.sendInputEvent({ type: 'mouseUp', x: next.cx, y: next.cy, button: 'left', clickCount: 1 });
            await sleep(1200);
            const v1 = await js(`document.querySelector('video').currentTime`);
            check('点 ▶ 快进生效', v1 > v0 + 2, `${v0.toFixed(1)} → ${v1.toFixed(1)}`);
        }

        // 浏览页位置
        await js(`location.hash = '#/home'`);
        await sleep(3500);
        const navB = await getNav();
        REPORT.measures.navBrowse = navB;
        const up = navB.find(n => n.name === 'up');
        const down = navB.find(n => n.name === 'down');
        check('浏览页 ▲ 在左边缘', up && up.left < 200, up ? `left=${up.left}` : 'null');
        check('浏览页 ▲▼ 一上一下且不重叠',
              up && down && up.bottom < down.top,
              up && down ? `up.bottom=${up.bottom} down.top=${down.top}` : 'null');
        check('浏览页 ▲▼ 都在垂直中间区域',
              up && down && up.top > viewport.h * 0.2 && down.bottom < viewport.h * 0.8,
              up && down ? `up.top=${up.top} down.bottom=${down.bottom} 屏高=${viewport.h}` : 'null');

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
