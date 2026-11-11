'use strict';
/** 诊断:Jellyfin 播放器 OSD 的显隐机制,验证能否手工控制。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = process.env.JFP_REPO || 'C:\\AI\\jellyfinplayer';
const OUT = path.join(REPO, '.osd-diag.json');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
cfg.debug = true; cfg.enableLiveSubtitle = false;

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', () => {});
ipcMain.on('app-quit', () => app.quit());
for (const h of ['stt:ensure','stt:start','stt:position','stt:cues','stt:stop','settings:save','settings:get'])
    ipcMain.handle(h, () => ({ ok: false, cues: [], status: null }));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ fullscreen: true, frame: false, show: true, backgroundColor: '#000',
        webPreferences: { preload: path.join(REPO, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    const js = (c) => win.webContents.executeJavaScript(c, true);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const R = {};

    try {
        await win.loadURL('http://127.0.0.1:8096/web/?p=' + Date.now() + '#/details?id=7ebffe65dfc5de3e80dbf83b4df8b282');
        await sleep(9000);
        await js(`(() => { const b=document.querySelector('.btnPlay'); if(b) b.click(); return !!b; })()`);
        await sleep(18000);
        await sleep(3000);

        // 1. 找出所有 OSD 相关元素及当前状态
        R.elements = await js(`(() => {
            const sels = ['.videoOsdBottom', '.videoOsdBottom-maincontrols', '.skinHeader',
                          '.osdHeader', '.videoOsdTop', '.osdControls', '.upNextContainer'];
            const out = {};
            for (const s of sels) {
                const el = document.querySelector(s);
                if (!el) { out[s] = null; continue; }
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                out[s] = {
                    cls: String(el.className),
                    display: cs.display, opacity: cs.opacity, visibility: cs.visibility,
                    rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) },
                    visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.opacity !== '0',
                };
            }
            return out;
        })()`);

        // 2. 等鼠标空闲后看它是否自动隐藏
        await sleep(6000);
        R.afterIdle = await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            const h = document.querySelector('.skinHeader');
            const info = (el) => el ? { cls: String(el.className),
                display: getComputedStyle(el).display,
                opacity: getComputedStyle(el).opacity,
                h: Math.round(el.getBoundingClientRect().height) } : null;
            return { bottom: info(b), header: info(h),
                     bodyCls: String(document.body.className) };
        })()`);

        // 3. 尝试手工显示(移除 hide 类 + 强制 opacity)
        R.manualShow = await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            const m = document.querySelector('.videoOsdBottom-maincontrols');
            const h = document.querySelector('.skinHeader');
            const act = [];
            for (const [n, el] of [['bottom', b], ['main', m], ['header', h]]) {
                if (!el) continue;
                el.classList.remove('hide');
                el.classList.remove('videoOsdBottom-hidden');
                el.classList.remove('osdHeader-hidden');
                el.style.opacity = '1';
                el.style.visibility = 'visible';
                el.style.display = '';
                act.push(n);
            }
            const vis = (el) => el ? { h: Math.round(el.getBoundingClientRect().height),
                                       opacity: getComputedStyle(el).opacity } : null;
            return { acted: act, bottom: vis(b), main: vis(m), header: vis(h) };
        })()`);
        await sleep(1500);

        // 4. 检查 1.5 秒后是否又被自动隐藏
        R.manualShowAfter = await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            return b ? { h: Math.round(b.getBoundingClientRect().height),
                         opacity: getComputedStyle(b).opacity,
                         cls: String(b.className) } : null;
        })()`);

        // 5. 尝试完全隐藏
        R.manualHide = await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            const h = document.querySelector('.skinHeader');
            if (b) { b.classList.add('hide'); b.style.opacity = '0'; }
            if (h) { h.classList.add('osdHeader-hidden'); }
            const vis = (el) => el ? { h: Math.round(el.getBoundingClientRect().height),
                                       opacity: getComputedStyle(el).opacity } : null;
            return { bottom: vis(b), header: vis(h) };
        })()`);
        await sleep(1500);
        R.manualHideAfter = await js(`(() => {
            const b = document.querySelector('.videoOsdBottom');
            return b ? { h: Math.round(b.getBoundingClientRect().height),
                         opacity: getComputedStyle(b).opacity } : null;
        })()`);

        fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
        console.log('DONE');
        console.log(JSON.stringify(R, null, 2).slice(0, 3500));
    } catch (e) {
        R.error = e.message;
        fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
        console.log('ERROR: ' + e.message);
    } finally {
        setTimeout(() => app.quit(), 500);
    }
});
app.on('window-all-closed', () => app.quit());
