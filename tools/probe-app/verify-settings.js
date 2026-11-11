'use strict';

/**
 * 设置面板验证:打开、改值、保存到 config.json。
 * 用法: jellyfin-player.exe <runtime> --probe-verify
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = process.env.JFP_REPO || 'C:\\AI\\jellyfinplayer';
const OUT = path.join(REPO, '.verify-out.json');
const CFG_FILE = path.join(REPO, '.settings-test-config.json');

const REPORT = { checks: [] };
const save = () => { try { fs.writeFileSync(OUT, JSON.stringify(REPORT, null, 2)); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用一份临时 config 测保存,不动真配置
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'config.json'), 'utf8'));
fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));

ipcMain.on('gesture-config', (e) => { e.returnValue = cfg; });
ipcMain.on('gesture-log', (_e, m) => { REPORT.gestureLogs = (REPORT.gestureLogs || []).concat(String(m)); console.log('[gesture] ' + m); });
ipcMain.on('app-quit', () => app.quit());

// 模拟主进程的设置保存,写到临时 config
ipcMain.handle('settings:save', async (_e, patch) => {
    try {
        const onDisk = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
        const merged = Object.assign({}, onDisk, patch);
        fs.writeFileSync(CFG_FILE, JSON.stringify(merged, null, 2), 'utf8');
        Object.assign(cfg, patch);
        REPORT.savedPatch = patch;
        return { ok: true, path: CFG_FILE, restartHint: '' };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});
ipcMain.handle('settings:get', () => ({ ok: true, cfg }));
ipcMain.handle('stt:stop', async () => ({ ok: true }));
ipcMain.handle('stt:start', async () => ({ ok: false, error: '测试不启动服务' }));
ipcMain.handle('stt:position', async () => ({ ok: false }));
ipcMain.handle('stt:cues', async () => ({ cues: [], status: null }));

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
        await win.loadURL('http://127.0.0.1:8096/web/#/home');
        await sleep(7000);

        // 打开菜单 → 点设置
        const btn = await js(`(() => { const b=document.querySelector('[data-jfp-menu-btn]'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; })()`);
        check('选项按钮存在', !!btn);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
        await sleep(600);

        const hasSettingsItem = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            return p ? Array.from(p.querySelectorAll('button')).some(b => /设置/.test(b.textContent)) : false;
        })()`);
        check('菜单含「设置」', hasSettingsItem);

        // 点设置
        const sbtn = await js(`(() => {
            const p = document.querySelector('[data-jfp-menu]');
            if (!p) return null;
            const b = Array.from(p.querySelectorAll('button')).find(x => /设置/.test(x.textContent));
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) };
        })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: sbtn.x, y: sbtn.y, button: 'left', clickCount: 1 });
        await sleep(60);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: sbtn.x, y: sbtn.y, button: 'left', clickCount: 1 });
        await sleep(1200);

        const panel = await js(`(() => {
            const p = document.querySelector('[data-jfp-settings]');
            if (!p) return null;
            const groups = Array.from(p.querySelectorAll('div')).map(d => d.textContent.trim()).filter(t => ['实时字幕','字幕样式','手势','界面','调试'].includes(t));
            const inputs = p.querySelectorAll('input, select, button').length;
            const r = p.getBoundingClientRect();
            return { groups: [...new Set(groups)], inputs, w: Math.round(r.width), h: Math.round(r.height) };
        })()`);
        REPORT.panel = panel;
        check('设置面板已打开', !!panel, panel ? `${panel.w}x${panel.h}, ${panel.inputs} 个控件` : 'null');
        check('含实时字幕分组', !!(panel && panel.groups.includes('实时字幕')), panel && panel.groups.join(' / '));
        check('含字幕样式分组', !!(panel && panel.groups.includes('字幕样式')));
        check('含手势分组', !!(panel && panel.groups.includes('手势')));
        check('含界面分组', !!(panel && panel.groups.includes('界面')));

        // 改一个值:译文字号 30 → 44
        // 注意:行结构是 div[标签 div + input],必须精确定位到「标签文本完全等于译文字号」的行
        const changed = await js(`(() => {
            const p = document.querySelector('[data-jfp-settings]');
            // 找所有含 input 的行
            const rows = Array.from(p.querySelectorAll('div')).filter(d => {
                const kids = d.children;
                if (kids.length !== 2) return false;
                if (!d.querySelector(':scope > input[type=number]')) return false;
                const label = kids[0].textContent.trim();
                return label === '译文字号';
            });
            if (!rows.length) {
                // 退化:列出所有行标签帮助诊断
                const labels = Array.from(p.querySelectorAll('div'))
                    .filter(d => d.querySelector(':scope > input[type=number]'))
                    .map(d => d.children[0] ? d.children[0].textContent.trim() : '?');
                return { ok: false, labels };
            }
            const row = rows[0];
            const inp = row.querySelector('input');
            const before = inp.value;
            inp.value = '44';
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            return { ok: true, before, after: inp.value };
        })()`);
        REPORT.changed = changed;
        check('能修改译文字号', changed.ok === true, JSON.stringify(changed));

        // 点保存
        const saved = await js(`(() => {
            const p = document.querySelector('[data-jfp-settings]');
            const b = Array.from(p.querySelectorAll('button')).find(x => x.textContent.trim() === '保存');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        check('点了保存按钮', saved === true);
        await sleep(2000);

        // 验证写盘
        const onDisk = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
        REPORT.onDisk = { subtitleFontPx: onDisk.subtitleFontPx, seekMaxSeconds: onDisk.seekMaxSeconds };
        check('config.json 已写入修改', onDisk.subtitleFontPx === 44, `subtitleFontPx=${onDisk.subtitleFontPx}`);
        check('未修改的键被保留', onDisk.seekMaxSeconds === 60, `seekMaxSeconds=${onDisk.seekMaxSeconds}`);

        // 关闭面板
        const closed = await js(`(() => {
            const p = document.querySelector('[data-jfp-settings]');
            if (!p) return 'no-panel';
            const b = Array.from(p.querySelectorAll('button')).find(x => x.textContent.trim() === '✕');
            if (b) { b.click(); return 'clicked'; }
            return 'no-close-btn';
        })()`);
        await sleep(500);
        const gone = await js(`!document.querySelector('[data-jfp-settings]')`);
        check('能关闭设置面板', gone === true, closed);

        REPORT.summary = { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
    } catch (err) {
        REPORT.errors = [{ message: err.message, stack: String(err.stack).slice(0, 700) }];
        save();
        console.log('ERROR: ' + err.message);
    } finally {
        try { fs.unlinkSync(CFG_FILE); } catch (_) {}
        REPORT.summary = REPORT.summary || { pass: REPORT.checks.filter(c=>c.ok).length, fail: REPORT.checks.filter(c=>!c.ok).length };
        save();
        setTimeout(() => app.quit(), 600);
    }
});

app.on('window-all-closed', () => app.quit());
