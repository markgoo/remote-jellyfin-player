'use strict';

/**
 * 验证:浏览页显示 ▲▼↩,播放页显示 ◀▶↩,且滚动真的生效。
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

const cfgPath = path.join(REPO, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.debug = true;
cfg.enableLiveSubtitle = false;

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs.push(String(m)); console.log('[gesture] ' + m); });
ipcMain.on('app-quit', () => app.quit());
for (const h of ['stt:ensure', 'stt:start', 'stt:position', 'stt:cues', 'stt:stop', 'settings:save', 'settings:get']) {
    ipcMain.handle(h, () => ({ ok: false, cues: [], status: null, path: cfgPath }));
}

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

    const getNav = () => js(`(() => Array.from(document.querySelectorAll('[data-jfp-nav]')).map(el => {
        const r = el.getBoundingClientRect();
        return { name: el.getAttribute('data-jfp-nav'), text: el.textContent,
                 w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top),
                 cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2),
                 onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth+1 && r.bottom <= innerHeight+1 };
    }))()`);

    const click = async (x, y, wait = 900) => {
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(wait);
    };

    // 复刻 findScrollContainer 的判定,用于测试里读滚动量
    const SCROLL_JS = `(() => {
        const cands = [];
        const push = (el) => { if (el && !cands.includes(el)) cands.push(el); };
        document.querySelectorAll('.page, .scrollY, .smoothScrollY, [class*="pageContent"], .tabContent, main').forEach(push);
        push(document.body);
        push(document.querySelector('#reactRoot'));
        push(document.documentElement);
        push(document.scrollingElement);
        let best = null, bestOver = 0;
        for (const el of cands) {
            if (!el || !el.getClientRects || el.getClientRects().length === 0) continue;
            const over = el.scrollHeight - el.clientHeight;
            if (over <= 20) continue;
            const oy = getComputedStyle(el).overflowY;
            if (!/auto|scroll|overlay/.test(oy)) continue;
            if (over > bestOver) { best = el; bestOver = over; }
        }
        // 真实滚动位置:body 设 overflow 时实际量可能记在 documentElement
        const realTop = Math.max(
            best ? (best.scrollTop || 0) : 0,
            document.documentElement.scrollTop || 0,
            document.scrollingElement ? (document.scrollingElement.scrollTop || 0) : 0);
        const winY = window.scrollY || 0;
        return { tag: best ? best.tagName : null, top: Math.round(realTop),
                 winY: Math.round(winY), over: bestOver };
    })()`;

    try {
        // ---------- 电影列表页(内容多,一定可滚) ----------
        await win.loadURL('http://127.0.0.1:8096/web/#/movies');
        await sleep(9000);

        let nav = await getNav();
        REPORT.moviesNav = nav.map(n => n.name);
        check('浏览页有 ▲▼↩',
              nav.some(n=>n.name==='up') && nav.some(n=>n.name==='down') && nav.some(n=>n.name==='back'),
              nav.map(n => n.name).join(','));
        check('浏览页不显示 ◀▶',
              !nav.some(n=>n.name==='prev') && !nav.some(n=>n.name==='next'));
        check('浏览页按键都在屏幕内', nav.every(n => n.onScreen));
        check('▲ 在 ▼ 上方',
              (() => { const u=nav.find(n=>n.name==='up'), d=nav.find(n=>n.name==='down');
                       return u && d && u.top < d.top; })(),
              `up.top=${nav.find(n=>n.name==='up')?.top} down.top=${nav.find(n=>n.name==='down')?.top}`);

        const info = await js(SCROLL_JS);
        REPORT.scrollInfo = info;
        check('找到可滚动容器', !!info.tag && info.over > 20,
              `${info.tag} over=${info.over}`);

        const downBtn = nav.find(n => n.name === 'down');
        if (downBtn && info.tag) {
            const before = (await js(SCROLL_JS)).top;
            await click(downBtn.cx, downBtn.cy, 1500);
            const after = (await js(SCROLL_JS)).top;
            REPORT.scrollDown = { before, after };
            check('点 ▼ 页面向下滚动', after > before + 20, `${before} → ${after}`);
            check('滚动有日志', REPORT.gestureLogs.some(l => /navScroll ↓/.test(l)),
                  REPORT.gestureLogs.filter(l=>/navScroll/.test(l)).join(' | ').slice(0,100));

            const upBtn = nav.find(n => n.name === 'up');
            await click(upBtn.cx, upBtn.cy, 1500);
            const a2 = (await js(SCROLL_JS)).top;
            REPORT.scrollUp = { before: after, after: a2 };
            check('点 ▲ 页面向上滚动', a2 < after - 20, `${after} → ${a2}`);
        }

        // ---------- 播放页 ----------
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(17000);

        const hasVideo = await js(`document.querySelectorAll('video').length > 0`);
        check('进入播放页', hasVideo === true);
        if (!hasVideo) throw new Error('未进入播放页');

        await sleep(2500);
        nav = await getNav();
        REPORT.playNav = nav.map(n => n.name);
        check('播放页有 ◀▶↩',
              nav.some(n=>n.name==='prev') && nav.some(n=>n.name==='next') && nav.some(n=>n.name==='back'),
              nav.map(n => n.name).join(','));
        check('播放页不显示 ▲▼',
              !nav.some(n=>n.name==='up') && !nav.some(n=>n.name==='down'));

        // 播放页返回键仍可用
        const backBtn = nav.find(n => n.name === 'back');
        const hashBefore = await js('location.hash');
        await click(backBtn.cx, backBtn.cy, 2000);
        const hashAfter = await js('location.hash');
        check('播放页点 ↩ 能返回', hashBefore !== hashAfter, `${hashBefore} → ${hashAfter}`);

        // 返回后应变回浏览页按键
        await sleep(2500);
        nav = await getNav();
        check('返回后变回 ▲▼ 按键',
              nav.some(n=>n.name==='up') && nav.some(n=>n.name==='down'),
              nav.map(n => n.name).join(','));

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 800) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        REPORT.summary = REPORT.summary || { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
        setTimeout(() => app.quit(), 700);
    }
});

app.on('window-all-closed', () => app.quit());
