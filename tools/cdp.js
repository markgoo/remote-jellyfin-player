'use strict';
// 极简 CDP 客户端:用来驱动运行中的 Electron/Jellyfin 页面做 DOM 取证与手势实测。
// 用法: node tools/cdp.js <cmd> [args...]
//   list                       列出 target
//   eval "<js>"                在页面上下文求值(返回 JSON)
//   shot <png路径>              截图
//   mouse <down|move|up> x y    派发鼠标事件(Input.dispatchMouseEvent,真实事件管线)
//   swipe dx dy [steps]        按住 - 拖 - 松,模拟 Direct Touch 滑动

const http = require('http');

const PORT = process.env.CDP_PORT || 9222;

function httpGet(path) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    });
}

async function targets() {
    const raw = await httpGet('/json/list');
    return JSON.parse(raw);
}

// 最小 WebSocket 客户端(避免额外依赖)
const crypto = require('crypto');
const net = require('net');

function wsConnect(url) {
    return new Promise((resolve, reject) => {
        const m = /^ws:\/\/([^:/]+)(?::(\d+))?(\/.*)$/.exec(url);
        if (!m) return reject(new Error('bad ws url: ' + url));
        const host = m[1];
        const port = Number(m[2] || 80);
        const path = m[3];
        const key = crypto.randomBytes(16).toString('base64');
        const sock = net.connect(port, host, () => {
            sock.write(
                `GET ${path} HTTP/1.1\r\n` +
                `Host: ${host}:${port}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
            );
        });
        sock.once('error', reject);
        let buf = Buffer.alloc(0);
        let handshook = false;
        const handlers = [];
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (!handshook) {
                const idx = buf.indexOf('\r\n\r\n');
                if (idx === -1) return;
                const head = buf.slice(0, idx).toString();
                if (!/101/.test(head.split('\r\n')[0])) return reject(new Error('ws handshake failed: ' + head.split('\r\n')[0]));
                buf = buf.slice(idx + 4);
                handshook = true;
                resolve({
                    send: (obj) => {
                        const payload = Buffer.from(JSON.stringify(obj));
                        const mask = crypto.randomBytes(4);
                        let header;
                        if (payload.length < 126) {
                            header = Buffer.alloc(6);
                            header[1] = 0x80 | payload.length;
                            mask.copy(header, 2);
                        } else if (payload.length < 65536) {
                            header = Buffer.alloc(8);
                            header[1] = 0x80 | 126;
                            header.writeUInt16BE(payload.length, 2);
                            mask.copy(header, 4);
                        } else {
                            header = Buffer.alloc(14);
                            header[1] = 0x80 | 127;
                            header.writeBigUInt64BE(BigInt(payload.length), 2);
                            mask.copy(header, 10);
                        }
                        const masked = Buffer.from(payload);
                        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
                        sock.write(Buffer.concat([header, masked]));
                    },
                    onMessage: (fn) => handlers.push(fn),
                    close: () => sock.destroy(),
                });
            }
            // 解析帧
            while (buf.length >= 2) {
                const b1 = buf[1];
                const masked = (b1 & 0x80) !== 0;
                let len = b1 & 0x7f;
                let off = 2;
                if (len === 126) {
                    if (buf.length < 4) return;
                    len = buf.readUInt16BE(2);
                    off = 4;
                } else if (len === 127) {
                    if (buf.length < 10) return;
                    len = Number(buf.readBigUInt64BE(2));
                    off = 10;
                }
                let maskKey = null;
                if (masked) {
                    if (buf.length < off + 4) return;
                    maskKey = buf.slice(off, off + 4);
                    off += 4;
                }
                if (buf.length < off + len) return;
                let payload = Buffer.from(buf.slice(off, off + len));
                if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
                buf = buf.slice(off + len);
                try {
                    const msg = JSON.parse(payload.toString());
                    handlers.forEach((fn) => fn(msg));
                } catch (_) { /* ping/pong 等 */ }
            }
        });
    });
}

async function openPageTarget() {
    const list = await targets();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('没有 page target:\n' + JSON.stringify(list, null, 2));
    const ws = await wsConnect(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.onMessage((msg) => {
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
    });
    const call = (method, params) => new Promise((resolve, reject) => {
        const myId = ++id;
        pending.set(myId, { resolve, reject });
        ws.send({ id: myId, method, params: params || {} });
        setTimeout(() => {
            if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP timeout: ' + method)); }
        }, 30000);
    });
    return { page, call, close: ws.close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd === 'list') {
        const list = await targets();
        console.log(JSON.stringify(list.map((t) => ({ type: t.type, title: t.title, url: t.url })), null, 2));
        return;
    }
    if (!cmd) {
        console.log('用法: node tools/cdp.js <list|eval|shot|mouse|swipe|key> ...');
        return;
    }
    const { call, close } = await openPageTarget();
    try {
        if (cmd === 'eval') {
            const expr = rest.join(' ');
            const r = await call('Runtime.evaluate', {
                expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
            });
            if (r.exceptionDetails) {
                console.error('EXCEPTION:', JSON.stringify(r.exceptionDetails, null, 2));
                process.exitCode = 2;
            } else {
                console.log(JSON.stringify(r.result.value, null, 2));
            }
        } else if (cmd === 'shot') {
            const out = rest[0] || 'shot.png';
            const r = await call('Page.captureScreenshot', { format: 'png' });
            require('fs').writeFileSync(out, Buffer.from(r.data, 'base64'));
            console.log('saved ' + out);
        } else if (cmd === 'mouse') {
            const [type, x, y] = rest;
            const buttons = type === 'down' ? 1 : type === 'up' ? 0 : 1;
            await call('Input.dispatchMouseEvent', {
                type, x: Number(x), y: Number(y), button: 'left', buttons,
                clickCount: type === 'move' ? 0 : 1,
            });
            console.log(`mouse ${type} (${x},${y})`);
        } else if (cmd === 'swipe') {
            const dx = Number(rest[0] || 150);
            const dy = Number(rest[1] || 0);
            const steps = Number(rest[2] || 10);
            const geo = await call('Runtime.evaluate', {
                expression: 'JSON.stringify({w:innerWidth,h:innerHeight})', returnByValue: true,
            });
            const { w, h } = JSON.parse(geo.result.value);
            const sx = Math.round(w / 2), sy = Math.round(h / 2);
            await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: sx, y: sy, button: 'left', buttons: 1, clickCount: 1 });
            for (let i = 1; i <= steps; i++) {
                await call('Input.dispatchMouseEvent', {
                    type: 'mouseMoved', x: Math.round(sx + (dx * i) / steps), y: Math.round(sy + (dy * i) / steps),
                    button: 'left', buttons: 1,
                });
                await sleep(12);
            }
            await call('Input.dispatchMouseEvent', {
                type: 'mouseReleased', x: sx + dx, y: sy + dy, button: 'left', buttons: 0, clickCount: 1,
            });
            console.log(`swipe dx=${dx} dy=${dy} from (${sx},${sy})`);
        } else if (cmd === 'key') {
            const key = rest[0];
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: Number(rest[1] || 0) });
            await call('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: Number(rest[1] || 0) });
            console.log('key ' + key);
        } else {
            console.error('未知命令: ' + cmd);
            process.exitCode = 1;
        }
    } finally {
        close();
    }
})().catch((e) => {
    console.error('ERR:', e.message);
    process.exitCode = 1;
});
