'use strict';

/**
 * 验证:长条形浮动工具栏(内含 ▭ 控制栏开关 + ☰ 选项)。
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

    const tbInfo = () => js(`(() => {
        const tb = document.querySelector('[data-jfp-toolbar]');
        if (!tb) return null;
        const r = tb.getBoundingClientRect();
        const btn = (sel) => {
            const b = tb.querySelector(sel);
            if (!b) return null;
            const br = b.getBoundingClientRect();
            return { text: b.textContent, w: Math.round(br.width), h: Math.round(br.height),
                     left: Math.round(br.left), top: Math.round(br.top),
                     cx: Math.round(br.left+br.width/2), cy: Math.round(br.top+br.height/2),
                     on: b.dataset.on };
        };
        return { rect: { left: Math.round(r.left), top: Math.round(r.top),
                         w: Math.round(r.width), h: Math.round(r.height),
                         right: Math.round(r.right) },
                 landscape: r.width > r.height,
                 osd: btn('[data-jfp-osd-btn]'),
                 menu: btn('[data-jfp-menu-btn]'),
                 btnCount: tb.querySelectorAll('button').length };
    })()`);

    const clickAt = async (x, y, wait = 900) => {
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        await sleep(wait);
    };

    const osdH = () => js(`(() => { const b=document.querySelector('.videoOsdBottom'); return b ? Math.round(b.getBoundingClientRect().height) : -1; })()`);

    try {
        await win.loadURL(`http://127.0.0.1:8096/web/?p=${Date.now()}#/details?id=${ITEM_ID}`);
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(18000);
        await sleep(2000);

        let tb = await tbInfo();
        REPORT.toolbar = tb;
        check('工具栏存在', !!tb);
        if (!tb) throw new Error('工具栏没挂上');

        check('工具栏是长条形(宽 > 高)', tb.landscape === true, `${tb.rect.w}x${tb.rect.h}`);
        check('工具栏含 2 个按钮', tb.btnCount === 2, `${tb.btnCount} 个`);
        check('含 ▭ 控制栏按钮', !!tb.osd && tb.osd.text === '▭', tb.osd ? `${tb.osd.text} ${tb.osd.w}px` : 'null');
        check('含 ☰ 选项按钮', !!tb.menu && tb.menu.text === '☰', tb.menu ? `${tb.menu.text} ${tb.menu.w}px` : 'null');

        // 关键:两按钮不重叠
        const noOverlap = tb.osd && tb.menu && (tb.menu.left >= tb.osd.left + tb.osd.w - 2);
        check('两个按钮不重叠', noOverlap,
              tb.osd && tb.menu ? `osd.right=${tb.osd.left+tb.osd.w} menu.left=${tb.menu.left}` : '');
        check('按钮大小一致', tb.osd && tb.menu && tb.osd.w === tb.menu.w,
              tb.osd && tb.menu ? `${tb.osd.w} vs ${tb.menu.w}` : '');

        // 等 OSD 自动隐藏
        await sleep(6000);
        let h = await osdH();
        check('控制栏已自动隐藏', h === 0, `h=${h}`);

        // 点 ▭ → 控制栏出现
        await clickAt(tb.osd.cx, tb.osd.cy);
        h = await osdH();
        check('点 ▭ 控制栏出现', h > 100, `h=${h}`);

        // 按钮高亮
        tb = await tbInfo();
        check('▭ 按钮显示为已开启状态', tb.osd.on === '1', `on=${tb.osd.on}`);

        // 3 秒后仍显示
        await sleep(3000);
        h = await osdH();
        check('3 秒后仍保持显示', h > 100, `h=${h}`);

        // 再点 → 收起
        tb = await tbInfo();
        await clickAt(tb.osd.cx, tb.osd.cy);
        h = await osdH();
        check('再点 ▭ 控制栏收起', h === 0, `h=${h}`);

        // 点 ☰ → 菜单打开
        tb = await tbInfo();
        await clickAt(tb.menu.cx, tb.menu.cy);
        const menuOpen = await js(`!!document.querySelector('[data-jfp-menu]')`);
        check('点 ☰ 菜单打开', menuOpen === true);
        await js(`(() => { const p=document.querySelector('[data-jfp-menu]'); if(p) p.remove(); return true; })()`);

        // 工具栏可拖动
        tb = await tbInfo();
        const before = { x: tb.rect.left, y: tb.rect.top };
        win.webContents.sendInputEvent({ type: 'mouseDown', x: tb.osd.cx, y: tb.osd.cy, button: 'left', clickCount: 1 });
        await sleep(40);
        for (let i = 1; i <= 8; i++) {
            win.webContents.sendInputEvent({ type: 'mouseMove',
                x: Math.round(tb.osd.cx + (-400) * i / 8), y: Math.round(tb.osd.cy + 200 * i / 8),
                button: 'left', modifiers: ['leftButtonDown'] });
            await sleep(20);
        }
        win.webContents.sendInputEvent({ type: 'mouseUp', x: tb.osd.cx - 400, y: tb.osd.cy + 200, button: 'left', clickCount: 1 });
        await sleep(700);
        tb = await tbInfo();
        const movedOk = tb && (Math.abs(tb.rect.left - before.x) > 100 || Math.abs(tb.rect.top - before.y) > 100);
        check('工具栏整体可拖动', movedOk === true,
              `(${before.x},${before.y}) → (${tb ? tb.rect.left : '?'},${tb ? tb.rect.top : '?'})`);

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
