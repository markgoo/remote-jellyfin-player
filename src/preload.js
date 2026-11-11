'use strict';

/**
 * Jellyfin 手势引擎(preload,隔离世界运行,DOM 与页面共享)
 *
 * Moonlight Direct Touch 模式把触摸转为 mousedown/mousemove/mouseup,
 * 本脚本在 document 捕获阶段识别:
 *   - 水平滑动 ≥ swipeThresholdPx → 快进/快退
 *   - 垂直滑动 ≥ swipeThresholdPx → 音量 ±
 *   - 双击视频画面 → 播放/暂停(拦截 Jellyfin 原生双击全屏)
 *   - 单击视频画面 → 原生放行(延迟 300ms 重放,等双击判定窗过去)
 *   - 拖动结束后抑制 click,防止误触发控制栏
 *   - 右上角 ✕ 悬浮按钮:点按退出应用,按住可拖动换位置
 *
 * 手势面判定:坐标落在 <video> 画面内 且 目标不是明确的小部件(button/slider 等)。
 * 不按 class 排除整层容器——实测 Jellyfin 12.x 播放时整屏点击都落在
 * .videoOsd 覆盖层上,那层正是手势面,不能当控件排除。
 */

const { ipcRenderer } = require('electron');

const cfg = ipcRenderer.sendSync('gesture-config');
const log = (msg) => { try { ipcRenderer.send('gesture-log', msg); } catch (_) {} };

// 明确的"控件小部件":命中则原生放行,不进手势管线
// 注意:不要再用 [class*="scroll"]/[class*="menu"] 这类泛化关键词做 closest() 匹配——
// closest() 会一路检查到 <body>,而 Jellyfin 播放时 <body> 就是 class="... hide-scroll",
// 于是一次点击就被判成"点在控件上",手势面永远为 false(实测:播放页左右滑动全失效)。
const WIDGET_SELECTOR = [
    'button', 'input', 'select', 'textarea', 'a[href]',
    '[role="button"]', '[role="slider"]', '[role="progressbar"]', '[role="menuitem"]',
    // 只保留真正表示可拖动控件/浮层容器的语义化 class,且限定为元素自身命中
    '[class*="slider" i]',
    '[data-jfp-menu-btn]', '[data-jfp-menu]'
].join(',');

// 这些元素即使自身命中上述选择器,也不代表"点在控件上"(整层容器/页面根)
const SURFACE_ROOTS = 'body, html, #reactRoot, .skinBody, .mainAnimatedPages, .page, [class*="pageContent" i]';

// ---------- 工具 ----------

/** 找当前可见、已就绪的视频元素(Jellyfin 播放器可能重建 <video>) */
function findVideo() {
    const vids = Array.from(document.querySelectorAll('video'));
    if (!vids.length) return null;
    const attached = vids.filter((v) => v.getClientRects().length > 0);
    const ready = attached.filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= 50 && r.height >= 50 && v.readyState >= 2;
    });
    const pool = ready.length ? ready : attached;
    if (!pool.length) return null;
    const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
    const audible = (v) => !v.muted && v.volume > 0;
    // 详情页背景视频(backdrop)通常静音:靠后排,优先真实播放的那个
    return pool.sort((a, b) => (audible(b) - audible(a)) || (area(b) - area(a)))[0];
}

/** 按下点是否"视频手势面":画面内 + 非控件小部件(覆盖层/OSD 根都算手势面) */
function isVideoSurface(target, video, x, y) {
    if (!target || !video) return false;
    if (target === video || video.contains(target)) return true;
    if (typeof target.closest !== 'function') return false;

    // 逐级向上检查,遇到 video / body / 页面根就停:
    //   - 命中真正的小部件(button/slider 等) → 不是手势面
    //   - 走到 body/页面容器还没命中 → 是手势面(点在了覆盖层或空白页面上)
    // 这样既能排除进度条、按钮,又不会被 <body class="hide-scroll"> 这类
    // 泛化 class 误伤(历史 bug:closest() 一路查到 body,导致手势全失效)。
    let node = target;
    while (node && node !== video && node !== document.body && node !== document.documentElement) {
        if (node.matches && node.matches(SURFACE_ROOTS)) break;
        if (node.matches && node.matches(WIDGET_SELECTOR)) return false;
        node = node.parentElement;
    }

    // 兜底:坐标必须落在画面内
    const vr = video.getBoundingClientRect();
    if (!vr.width || !vr.height) return false;
    return x >= vr.left && x <= vr.right && y >= vr.top && y <= vr.bottom;
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function fmtSec(s) {
    s = Math.round(s);
    return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
}

// ---------- 反馈浮层(Moonlight 下无其他反馈手段) ----------
// 刻意做得低调:左下角小字、半透明、不挡画面。✕ 按钮在右上角,这里错开。

let toastEl = null;
let toastTimer = 0;

function toast(text) {
    if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.setAttribute('data-jfp-toast', '');
        toastEl.style.cssText = [
            'position:fixed', 'left:18px', 'bottom:18px',
            'padding:6px 14px', 'border-radius:8px',
            'font:600 15px/1.35 "Segoe UI",sans-serif', 'color:rgba(255,255,255,0.82)',
            'background:rgba(0,0,0,0.42)', 'z-index:2147483647',
            'pointer-events:none', 'white-space:nowrap',
            'transition:opacity .3s', 'opacity:1'
        ].join(';');
        document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, cfg.toastMs);
}

// ---------- 播放器操作 ----------

// 连续滑动去抖:每次设置 video.currentTime 都会让解码器重新定位并重新缓冲,
// 连滑 4 次就是 4 次重缓冲 → 观感就是"滑动几次之后开始卡"。
// 做法:滑动只累加"待跳目标",250ms 内的连续滑动合并成一次真正 seek。
let seekPending = null;      // 累加的秒数
let seekTimer = 0;

function seekBy(video, dx) {
    const dur = video.duration;
    if (!isFinite(dur)) { toast('⏺ 直播流不支持快进'); return; }
    let delta = cfg.seekStepSeconds;
    if (cfg.seekMode === 'scaled') {
        // 按滑动距离连续折算:滑得越远快进越多,但夹在 [seekMinSeconds, seekMaxSeconds] 内,
        // 避免长距离滑动一下跳过头。
        // 锚点:pixelsPerStep 像素 = seekStepSeconds 秒,从该点起线性增长,
        // 短距离也按同样斜率缩小(低于 swipeThresholdPx 的手势早已被判定为不是滑动)。
        const px = Math.abs(dx);
        const base = Math.max(1, cfg.pixelsPerStep);
        const minS = cfg.seekMinSeconds != null ? cfg.seekMinSeconds : 5;
        const maxS = cfg.seekMaxSeconds != null ? cfg.seekMaxSeconds : 60;
        delta = (px / base) * cfg.seekStepSeconds;
        delta = clamp(delta, minS, maxS);
        // 不超过片长的一半,防止小片段一滑到头
        if (isFinite(dur) && dur > 1) delta = Math.min(delta, dur / 2);
    }
    if (delta < 1) return;
    delta = Math.sign(dx) * delta;

    // 累加待跳量(同向相加,反向先抵消),先只给提示
    seekPending = (seekPending || 0) + delta;
    if (Math.abs(seekPending) < 1) { seekPending = null; return; }
    toast(`${seekPending > 0 ? '⏩ +' : '⏪ −'}${fmtSec(Math.abs(seekPending))}`);

    // 去抖:250ms 内没有新的滑动才真正执行
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
        const total = seekPending;
        seekPending = null;
        seekTimer = 0;
        if (!total || Math.abs(total) < 1) return;

        const v = document.querySelector('video');
        if (!v) return;
        const d = v.duration;
        if (!isFinite(d)) return;
        const from = v.currentTime;
        const target = clamp(from + total, 0, Math.max(0, d - 0.3));
        if (Math.abs(target - from) < 0.5) return;   // 已在边界,不必 seek
        try {
            v.currentTime = target;
            log(`seek ${total > 0 ? '+' : ''}${total.toFixed(1)}s → ${target.toFixed(1)}s (合并执行)`);
            // 立刻把新位置告诉字幕服务,别等下一轮对账(否则它会按旧位置继续生成,导致字幕错位)
            if (stt.on) {
                ipcRenderer.invoke('stt:position', {
                    time: target,
                    playing: !v.paused,
                    mediaKey: stt.mediaKey,
                }).catch(() => {});
            }
        } catch (err) {
            log(`seek failed: ${err && err.message}`);
        }
    }, cfg.seekDebounceMs != null ? cfg.seekDebounceMs : 250);
}

function volumeBy(video, dir) {
    if (dir > 0) video.muted = false;
    const v = clamp(video.volume + dir * cfg.volumeStep, 0, 1);
    video.volume = v;
    toast(`${v <= 0 ? '🔇' : '🔊'} 音量 ${Math.round(v * 100)}%`);
    log(`volume → ${(v * 100).toFixed(0)}%`);
}

function togglePlayPause(video) {
    if (video.paused) {
        video.play().catch(() => {});
        toast('▶ 播放');
    } else {
        video.pause();
        toast('⏸ 暂停');
    }
}

// ---------- 手势状态机 ----------

let track = null;              // { x, y, t, edge } 按下起点(已确认在手势面)
let suppressClickUntil = 0;    // 拖动手势结束后一段时间内吞掉 click

/** 按下点是否在左边缘"返回热区"内(用于右滑返回上一层) */
function isLeftEdge(x) {
    const w = cfg.backEdgeWidthPx != null ? cfg.backEdgeWidthPx : 48;
    return cfg.enableBackGesture !== false && x >= 0 && x <= w;
}

/** 返回上一层:优先用历史返回(Jellyfin 是 SPA),没有可回退的页面时提示 */
function goBack() {
    const before = location.hash;
    try { history.back(); } catch (_) {}

    setTimeout(() => {
        // history.back() 没让 hash 变化 → 说明已在最外层页面,没有上一层
        if (location.hash === before) {
            toast('← 已在首页');
            log(`back ignored: 无上一页 (${before})`);
        } else {
            toast('← 返回');
            log(`back → ${location.hash}`);
        }
    }, 260);

    log(`back requested (from ${before})`);
}

// Jellyfin 12.1 的播放器把"单击暂停"绑在 pointerdown 上,并按 300ms 定时器延时执行:
//   addEventListener(view, "pointerdown", e => { ... setTimeout(() => playPause(), 300) })
// 它不看 click。所以拖动手势必须**在 pointerdown 阶段就拦掉**,否则手指抬起、滑动完成之后
// 那个定时器照样会把视频暂停 —— 表现就是"滑动后暂停,再滑动又恢复"。
document.addEventListener('pointerdown', (e) => {
    if (redispatching) return;          // 自己重放的单击事件,放行给 Jellyfin
    if (e.button !== undefined && e.button !== 0) return;
    if (isLeftEdge(e.clientX)) return;  // 边缘返回手势交给下面的状态机,不在这里拦
    const video = findVideo();
    const surface = video ? isVideoSurface(e.target, video, e.clientX, e.clientY) : false;
    if (!surface) return;
    // 在捕获阶段截住,阻止 Jellyfin 的 pointerdown 监听器起那个 300ms 暂停定时器
    e.stopPropagation();
}, true);

document.addEventListener('mousedown', (e) => {
    track = null;
    if (e.button !== 0) return;

    // 1) 左边缘按下:登记为潜在的返回手势。这条不受"视频手势面"限制,
    //    因为返回在详情页/列表页也要能用(那些页面没有 video)。
    if (isLeftEdge(e.clientX)) {
        track = { x: e.clientX, y: e.clientY, t: Date.now(), edge: true };
        if (cfg.debug) log(`down-edge(${e.clientX},${e.clientY}) 返回手势候选`);
        return;
    }

    // 2) 普通手势:必须在视频画面内
    const video = findVideo();
    const surface = video ? isVideoSurface(e.target, video, e.clientX, e.clientY) : false;
    if (cfg.debug) {
        log(`down(${e.clientX},${e.clientY}) <${e.target.tagName} class="${String(e.target.className).slice(0, 50)}"> video=${!!video} surface=${surface}`);
    }
    if (!surface) return;
    track = { x: e.clientX, y: e.clientY, t: Date.now(), edge: false };
}, true);

document.addEventListener('mouseup', (e) => {
    if (!track) return;
    const s = track;
    track = null;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.hypot(dx, dy) < cfg.axisLockPx) return; // 位移极小 → 交给 click 管线(单击/双击)
    suppressClickUntil = Date.now() + 150;           // 这是一次拖动,吞掉结尾的 click
    const dt = Date.now() - s.t;
    if (dt > cfg.swipeMaxMs) return;                 // 太慢不算手势

    // 边缘返回:从左边缘向右滑,位移够大且基本水平
    if (s.edge) {
        const needPx = cfg.backSwipeThresholdPx != null ? cfg.backSwipeThresholdPx : 100;
        if (dx >= needPx && Math.abs(dx) > Math.abs(dy) * 1.2) {
            goBack();
        } else if (cfg.debug) {
            log(`edge swipe 未达阈值 dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} need=${needPx}`);
        }
        return;
    }

    const video = findVideo();
    if (!video) return;
    if (Math.abs(dx) > Math.abs(dy)) {
        if (Math.abs(dx) >= cfg.swipeThresholdPx) seekBy(video, dx);
    } else {
        if (Math.abs(dy) >= cfg.swipeThresholdPx) volumeBy(video, dy < 0 ? 1 : -1);
    }
}, true);

// ---------- 单击/双击管线 ----------
// 单击:先扣住 300ms;无第二击则重放原生事件序列(交给 Jellyfin 原生行为);
// 有第二击则播放/暂停,并拦截原生 dblclick(避免退出全屏)。

let tapTimer = 0;
let redispatching = false;

function redispatchNativeTap(target, x, y) {
    redispatching = true;
    try {
        const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
        // Jellyfin 12.x 的单击暂停监听的是 pointerdown(不是 click),所以这里必须补发
        // PointerEvent,否则"单击 = Jellyfin 原生行为"会失效。
        try {
            target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, {
                buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
            })));
        } catch (_) { /* 老环境无 PointerEvent 时退化为 click */ }
        target.dispatchEvent(new MouseEvent('mousedown', Object.assign({}, base, { buttons: 1 })));
        target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
        target.dispatchEvent(new MouseEvent('click', base));
    } finally {
        redispatching = false;
    }
}

document.addEventListener('click', (e) => {
    if (redispatching) return;                                   // 自己重放的事件,放行给 Jellyfin
    if (Date.now() < suppressClickUntil) {                       // 拖动残余 click,吞掉
        e.stopPropagation();
        e.preventDefault();
        return;
    }
    const video = findVideo();
    if (!video || !isVideoSurface(e.target, video, e.clientX, e.clientY)) return; // 非手势面 → 原生
    e.stopPropagation();
    e.preventDefault();
    const { target, clientX, clientY } = e;
    if (tapTimer) {                                              // 第二击 → 双击
        clearTimeout(tapTimer);
        tapTimer = 0;
        togglePlayPause(video);
    } else {                                                     // 第一击 → 等 doubleTapMs
        tapTimer = setTimeout(() => {
            tapTimer = 0;
            redispatchNativeTap(target, clientX, clientY);
        }, cfg.doubleTapMs);
    }
}, true);

document.addEventListener('dblclick', (e) => {
    const video = findVideo();
    if (video && isVideoSurface(e.target, video, e.clientX, e.clientY)) {
        // 双击已由 click 管线处理为播放/暂停;屏蔽 Jellyfin 原生"双击全屏"
        e.stopPropagation();
        e.preventDefault();
    }
}, true);

// 失焦取消进行中的跟踪(如 Moonlight 断流)
window.addEventListener('blur', () => {
    track = null;
    suppressClickUntil = 0;
});

// ---------- 退出按钮(可拖动 ✕) ----------

// ---------- 虚拟按键层(手机直接点,不依赖滑动) ----------
//
// 两套场景,按键集合不同:
//   播放页(有 <video>):↩ 返回 + ◀ 快退 + ▶ 快进
//   浏览页(没有 <video>):↩ 返回 + ▲ 上滚 + ▼ 下滚
// 共性:半透明不挡画面、每个都可拖动、位置记 localStorage、1s 自愈重挂。

const NAV_KEYS = {
    back: { key: 'jfp-pos-back', label: '↩', tip: '返回上一层',
            scenes: ['browse', 'play'], def: { left: 16, top: 72 } },
    prev: { key: 'jfp-pos-prev', label: '◀', tip: '快退',
            scenes: ['play'], def: { left: 16, top: 'center' } },
    next: { key: 'jfp-pos-next', label: '▶', tip: '快进',
            scenes: ['play'], def: { left: 'right', top: 'center' } },
    up:   { key: 'jfp-pos-up', label: '▲', tip: '向上滚动',
            scenes: ['browse'], def: { left: 16, top: 'center-up' } },
    down: { key: 'jfp-pos-down', label: '▼', tip: '向下滚动',
            scenes: ['browse'], def: { left: 16, top: 'center-down' } },
};

const navEls = {};        // name -> element
let navDrag = null;

/**
 * 按键尺寸。可按类型单独放大:
 *   navScrollButtonSizePx  ▲▼ 滚动键(浏览页用,手指要频繁点,默认更大)
 *   navButtonSizePx        其余按键(↩ ◀ ▶)
 */
function navBtnSize(name) {
    const base = cfg.navButtonSizePx != null ? Number(cfg.navButtonSizePx) : 84;
    if (name === 'up' || name === 'down') {
        const s = Number(cfg.navScrollButtonSizePx);
        if (Number.isFinite(s) && s > 0) return s;
    }
    return base;
}

/** 当前场景:有 video 就是播放页,否则浏览页 */
function navScene() {
    return document.querySelector('video') ? 'play' : 'browse';
}

function navCss(name) {
    const size = navBtnSize(name);
    const opacity = cfg.navButtonOpacity != null ? cfg.navButtonOpacity : 0.32;
    return [
        'position:fixed', `width:${size}px`, `height:${size}px`,
        'border-radius:50%', 'padding:0',
        'border:1px solid rgba(255,255,255,.18)',
        `background:rgba(0,0,0,${cfg.navButtonBgAlpha != null ? cfg.navButtonBgAlpha : 0.35})`,
        `color:rgba(255,255,255,${Math.min(1, opacity + 0.45)})`,
        `font:${Math.round(size * 0.42)}px/1 "Segoe UI",sans-serif`,
        'z-index:2147483644',
        'display:flex', 'align-items:center', 'justify-content:center',
        'user-select:none', 'touch-action:none', 'cursor:pointer',
        `opacity:${opacity}`,
        'transition:opacity .2s, background .2s',
    ].join(';');
}

/** 把按键摆到固定位置(不做位置记忆,每次都用默认位置) */
function navPlace(name, el) {
    const size = navBtnSize(name);
    const W = window.innerWidth, H = window.innerHeight;
    const meta = NAV_KEYS[name];

    const d = meta.def;
    let left = d.left;
    let top = d.top;
    if (left === 'right') left = Math.round(W - size - 16);
    if (top === 'center') top = Math.round((H - size) / 2);
    // ▲▼ 以上下相邻的一对来摆:两个键加中间间隙整体居中,
    // 这样按键放大后不会挤在一起或偏到一边。
    if (top === 'center-up' || top === 'center-down') {
        const gap = cfg.navScrollGapPx != null ? Number(cfg.navScrollGapPx) : 20;
        const pairH = size * 2 + gap;
        const pairTop = Math.round((H - pairH) / 2);
        top = name === 'up' ? pairTop : pairTop + size + gap;
    }
    el.style.left = (typeof left === 'number' ? left : 16) + 'px';
    el.style.top = (typeof top === 'number' ? top : 72) + 'px';
    if (cfg.debug) {
        log(`navPlace ${name}: W=${W} H=${H} size=${size} -> ${el.style.left},${el.style.top}`);
    }
}

/** 所有按键回到默认位置。
 *  现在不再记忆拖动位置(用户要求),这个函数主要用来清理历史遗留的旧位置数据。
 */
function navResetPositions() {
    // 清掉可能残留的旧记忆
    for (const meta of Object.values(NAV_KEYS)) {
        try { localStorage.removeItem(meta.key); } catch (_) {}
    }
    try { localStorage.removeItem('jfp-menu-pos'); } catch (_) {}
    for (const [name, el] of Object.entries(navEls)) {
        if (el && el.isConnected) navPlace(name, el);
    }
    // 菜单按钮复位
    const mb = document.querySelector('[data-jfp-menu-btn]');
    if (mb) {
        mb.style.left = 'auto';
        mb.style.right = '10px';
        mb.style.top = '10px';
    }
    log('nav: 已恢复所有按键默认位置');
    toast('↺ 按键位置已复位');
}

/** 把所有虚拟按键位置恢复默认(清掉拖过的记忆) */
function navResetPositions() {
    for (const meta of Object.values(NAV_KEYS)) {
        try { localStorage.removeItem(meta.key); } catch (_) {}
    }
    for (const [name, el] of Object.entries(navEls)) {
        if (el && el.isConnected) navPlace(name, el);
    }
    // 菜单按钮复位:用 DOM 查询而不是直接引用(menuBtn 声明在文件更后面,避免 TDZ)
    try { localStorage.removeItem('jfp-menu-pos'); } catch (_) {}
    const mb = document.querySelector('[data-jfp-menu-btn]');
    if (mb) {
        mb.style.left = 'auto';
        mb.style.right = '10px';
        mb.style.top = '10px';
    }
    log('nav: 已恢复所有按键默认位置');
    toast('↺ 按键位置已复位');
}

// 窗口尺寸变化时,没有存过位置的按键要重新摆放(否则还是按旧视口算的坐标)
window.addEventListener('resize', () => {
    for (const [name, el] of Object.entries(navEls)) {
        if (!el || !el.isConnected) continue;
        let saved = null;
        try { saved = localStorage.getItem(NAV_KEYS[name].key); } catch (_) {}
        if (!saved) navPlace(name, el);      // 只有没存过位置的才重算
    }
});

function makeNavButton(name) {
    const meta = NAV_KEYS[name];
    const el = document.createElement('button');
    el.setAttribute('data-jfp-nav', name);
    el.title = meta.tip;
    el.textContent = meta.label;
    el.style.cssText = navCss(name);
    navPlace(name, el);

    // 按下:记起点,准备可能的拖动
    el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = el.getBoundingClientRect();
        navDrag = { name, el, x: e.clientX, y: e.clientY, left: r.left, top: r.top, moved: false };
    });
    el.addEventListener('mouseenter', () => {
        el.style.opacity = '0.85';
        el.style.background = 'rgba(0,0,0,0.55)';
    });
    el.addEventListener('mouseleave', () => {
        el.style.opacity = String(cfg.navButtonOpacity != null ? cfg.navButtonOpacity : 0.32);
        el.style.background = `rgba(0,0,0,${cfg.navButtonBgAlpha != null ? cfg.navButtonBgAlpha : 0.35})`;
    });
    return el;
}

function navAction(name) {
    if (name === 'back') {
        log('nav: back');
        goBack();
        return;
    }

    const v = document.querySelector('video');
    if (v) {
        if (name === 'prev') { navSeek(v, -1); return; }
        if (name === 'next') { navSeek(v, +1); return; }
    }
    if (name === 'up') { navScroll(-1); return; }
    if (name === 'down') { navScroll(+1); return; }
}

// ---------- 控制栏(OSD)手工开关 ----------
// Jellyfin 12.1 的播放器用 class 控制 OSD 显隐(实测有效的组合):
//   显示: 移除 "hide" 和 "videoOsdBottom-hidden",opacity 置 1
//   隐藏: 加回 "hide",opacity 置 0
// 控制栏是 .videoOsdBottom / .videoOsdBottom-maincontrols,
// 顶部栏是 .skinHeader(osdHeader / osdHeader-hidden)。
// 实测:手工显示后 1.5 秒内不会被自动收回,所以可以常显。

let osdPinned = false;      // 用户是否手工固定了控制栏

function osdShow() {
    const targets = [
        ...document.querySelectorAll('.videoOsdBottom, .videoOsdBottom-maincontrols'),
    ];
    for (const el of targets) {
        el.classList.remove('hide');
        el.classList.remove('videoOsdBottom-hidden');
        el.style.opacity = '1';
        el.style.visibility = 'visible';
    }
    const header = document.querySelector('.skinHeader');
    if (header) {
        header.classList.remove('osdHeader-hidden');
        header.style.opacity = '1';
    }
    return targets.length > 0;
}

function osdHide() {
    const targets = [
        ...document.querySelectorAll('.videoOsdBottom, .videoOsdBottom-maincontrols'),
    ];
    for (const el of targets) {
        el.classList.add('hide');
        el.style.opacity = '0';
    }
    const header = document.querySelector('.skinHeader');
    if (header) header.classList.add('osdHeader-hidden');
    return targets.length > 0;
}

/** 控制栏当前是否可见 */
function osdIsVisible() {
    const el = document.querySelector('.videoOsdBottom');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 10 && getComputedStyle(el).opacity !== '0';
}

/** 点按钮切换:显示 → 固定;再点 → 收起 */
function navToggleOsd() {
    if (!document.querySelector('video')) {
        toast('仅播放页可用');
        return;
    }
    if (osdIsVisible() && osdPinned) {
        osdHide();
        osdPinned = false;
        toast('控制栏已收起');
        log('osd: 收起');
    } else {
        osdShow();
        osdPinned = true;
        toast('控制栏已固定');
        log('osd: 显示并固定');
    }
    syncOsdBtnVisual();
}

/** 让工具栏里的 ▭ 按钮反映当前状态(固定时蓝色高亮) */
function syncOsdBtnVisual() {
    if (typeof osdBtn === 'undefined' || !osdBtn) return;
    const pinnedNow = osdPinned && osdIsVisible();
    osdBtn.dataset.on = pinnedNow ? '1' : '0';
    osdBtn.style.background = pinnedNow ? 'rgba(45,108,223,.75)' : 'rgba(255,255,255,.1)';
    osdBtn.style.color = pinnedNow ? '#fff' : 'rgba(255,255,255,.9)';
}

// 兼容旧名
function navSyncOsdButton() { syncOsdBtnVisual(); }

/** 固定状态下持续维持可见(Jellyfin 自身仍可能在某些时机收回) */
function keepOsdPinned() {
    if (!osdPinned) return;
    if (!document.querySelector('video')) { osdPinned = false; syncOsdBtnVisual(); return; }
    if (!osdIsVisible()) {
        osdShow();
        log('osd: 被自动收回,重新固定');
    }
    syncOsdBtnVisual();
}

/** 虚拟按键的快退/快进:直接复用 seekBy,参数与滑动手势同一套 */
function navSeek(video, direction) {
    const dur = video.duration;
    if (!isFinite(dur)) { toast('⏺ 直播流不支持快进'); return; }
    // 用固定的"一次按键距离"换算成秒,与 swipeThresholdPx 对齐
    const px = cfg.swipeThresholdPx || 80;
    seekBy(video, direction * px);
}

/** 找到页面里真正负责滚动的容器(Jellyfin 是 SPA,滚动容器不固定) */
function findScrollContainer() {
    // 实测结论(2026-11-11):
    //   电影/列表页真正的滚动容器是 <body>(overflow-y:auto),不是 .page;
    //   html 的 scrollHeight 与 body 相同但 overflow 是 visible,不能滚;
    //   首页在内容加载完之前根本不可滚(sh == ch)。
    // 所以按"实际可滚量"找,不要写死选择器。

    const candidates = [];
    const push = (el) => { if (el && !candidates.includes(el)) candidates.push(el); };

    // 1) 明确的滚动容器类
    document.querySelectorAll('.page, .scrollY, .smoothScrollY, [class*="pageContent"], .tabContent, main')
        .forEach(push);
    // 2) Jellyfin 实际的滚动体:body / reactRoot / html
    push(document.body);
    push(document.querySelector('#reactRoot'));
    push(document.documentElement);
    push(document.scrollingElement);

    let best = null;
    let bestOver = 0;

    for (const el of candidates) {
        if (!el || !el.getClientRects || el.getClientRects().length === 0) continue;
        const over = el.scrollHeight - el.clientHeight;
        if (over <= 20) continue;
        const oy = getComputedStyle(el).overflowY;
        // 只有能真正滚动的才考虑(html 的 scrollHeight 大但 overflow:visible)
        const canScroll = /auto|scroll|overlay/.test(oy);
        if (!canScroll) continue;
        if (over > bestOver) { best = el; bestOver = over; }
    }
    // 3) 退一步:任何可滚量最大的元素(哪怕 overflow 判定不明确)
    if (!best) {
        for (const el of candidates) {
            if (!el || !el.getClientRects || el.getClientRects().length === 0) continue;
            const over = el.scrollHeight - el.clientHeight;
            if (over > bestOver) { best = el; bestOver = over; }
        }
    }
    return best;
}

/** 上下滚动一屏的 70%(留一点上下文,不然容易看丢) */function navScroll(direction, retried) {
    const box = findScrollContainer();
    if (!box) {
        // 内容可能还在加载(首页刚进来时 sh==ch),稍后再试一次
        if (!retried) {
            log('navScroll: 暂时不可滚,300ms 后重试');
            setTimeout(() => navScroll(direction, true), 300);
            return;
        }
        log('navScroll: 找不到可滚动容器');
        toast(direction > 0 ? '页面不可滚动' : '页面不可滚动');
        return;
    }

    const pageH = box.clientHeight || window.innerHeight;
    const step = Math.round(pageH * (cfg.navScrollRatio != null ? cfg.navScrollRatio : 0.7));

    // 读"真实滚动位置":在 Chromium 里 body 设了 overflow:auto 时,
    // 实际滚动量可能记在 documentElement 上,body.scrollTop 常恒为 0。
    const realTop = () => Math.max(
        box.scrollTop || 0,
        document.documentElement.scrollTop || 0,
        document.scrollingElement ? document.scrollingElement.scrollTop || 0 : 0);

    const before = realTop();

    try {
        if (typeof box.scrollBy === 'function') {
            box.scrollBy({ top: direction * step, behavior: 'smooth' });
        } else {
            box.scrollTop = before + direction * step;
        }
    } catch (_) {
        box.scrollTop = before + direction * step;
    }
    // 兜底:同时推一下 window / documentElement,覆盖 body 滚动被忽略的情况
    try {
        window.scrollBy({ top: direction * step, behavior: 'smooth' });
    } catch (_) {
        try { window.scrollBy(0, direction * step); } catch (_) {}
    }

    log(`navScroll ${direction > 0 ? '↓' : '↑'} ${step}px on <${box.tagName}`
        + ` class="${String(box.className).slice(0, 30)}"> before=${before}`);

    // 到顶/到底给个提示(手机上看不到滚动条)
    setTimeout(() => {
        if (Math.abs(realTop() - before) < 2) {
            toast(direction > 0 ? '已到底' : '已到顶');
        }
    }, 600);
}

/** 按当前场景挂/卸虚拟按键 */
function ensureNavButtons() {
    if (cfg.enableNavButtons === false) {
        Object.values(navEls).forEach((el) => { if (el && el.isConnected) el.remove(); });
        return;
    }
    if (!document.documentElement) return;

    const scene = navScene();
    for (const [name, meta] of Object.entries(NAV_KEYS)) {
        const wanted = meta.scenes.includes(scene);
        let el = navEls[name];

        if (!wanted) {
            if (el && el.isConnected) el.remove();
            continue;
        }
        if (!el) {
            el = makeNavButton(name);
            navEls[name] = el;
        }
        if (!el.isConnected) {
            document.documentElement.appendChild(el);
            navPlace(name, el);      // 重挂后回到原位
        }
    }
}

// 拖动处理(全局一次,避免每个按钮重复注册)
document.addEventListener('mousemove', (e) => {
    if (!navDrag) return;
    const dx = e.clientX - navDrag.x, dy = e.clientY - navDrag.y;
    if (!navDrag.moved && Math.hypot(dx, dy) < 8) return;
    navDrag.moved = true;
    const size = navBtnSize(navDrag.name);   // ▲▼ 和其余按键尺寸可能不同
    navDrag.el.style.left = clamp(navDrag.left + dx, 0, window.innerWidth - size) + 'px';
    navDrag.el.style.top = clamp(navDrag.top + dy, 0, window.innerHeight - size) + 'px';
}, true);

document.addEventListener('mouseup', (e) => {
    if (!navDrag) return;
    const { name, el, moved } = navDrag;
    navDrag = null;
    if (!moved) {
        navAction(name);
        return;
    }
    // 不记忆拖动位置(用户要求):松手后保持当前位置,但下次进入页面回到默认位。
    // 这样不会出现"位置漂移后找不回来"的问题。
    const r = el.getBoundingClientRect();
    log(`nav ${name} 拖动到 (${Math.round(r.left)},${Math.round(r.top)}),不记忆`);
}, true);



// ---------- 长条形浮动工具栏 ----------
// 右上角一个横向长条,里面并排放:
//   [▭ 控制栏]  [☰ 选项]
// 两个按钮同属一个容器,永不重叠;整条可一起拖动,位置记在 localStorage。

const TB_BTN = cfg.menuButtonSizePx != null ? cfg.menuButtonSizePx : 56;   // 单个按钮边长
const TB_GAP = 8;
const TB_PAD = 8;
const POS_KEY = 'jfp-toolbar-pos';

const toolbar = document.createElement('div');
toolbar.setAttribute('data-jfp-toolbar', '');
toolbar.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px',
    'display:flex', 'align-items:center', `gap:${TB_GAP}px`,
    `padding:${TB_PAD}px`, 'border-radius:' + Math.round(TB_BTN / 2 + TB_PAD) + 'px',
    'background:rgba(0,0,0,.5)', 'border:1px solid rgba(255,255,255,.16)',
    'box-shadow:0 4px 16px rgba(0,0,0,.45)',
    'z-index:2147483646', 'user-select:none', 'touch-action:none',
].join(';');

/** 工具栏里的小按钮工厂 */
function makeToolbarBtn(attr, label, title) {
    const b = document.createElement('button');
    b.setAttribute(attr, '');
    b.title = title;
    b.textContent = label;
    b.style.cssText = [
        `width:${TB_BTN}px`, `height:${TB_BTN}px`,
        'border-radius:50%', 'padding:0', 'border:0',
        'background:rgba(255,255,255,.1)', 'color:rgba(255,255,255,.9)',
        `font:${Math.round(TB_BTN * 0.44)}px/1 "Segoe UI",sans-serif`,
        'display:flex', 'align-items:center', 'justify-content:center',
        'cursor:pointer', 'transition:background .18s, color .18s',
    ].join(';');
    b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.22)'; });
    b.addEventListener('mouseleave', () => {
        if (b.dataset.on === '1') {
            b.style.background = 'rgba(45,108,223,.75)';
        } else {
            b.style.background = 'rgba(255,255,255,.1)';
        }
    });
    return b;
}

/** 控制栏开关按钮(▭) */
const osdBtn = makeToolbarBtn('data-jfp-osd-btn', '▭', '显示/隐藏控制栏');
/** 选项按钮(☰) */
const menuBtn = makeToolbarBtn('data-jfp-menu-btn', '☰', '选项菜单');

toolbar.appendChild(osdBtn);
toolbar.appendChild(menuBtn);

/** 恢复工具栏上次拖动位置 */
function restoreMenuPos() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (_) {}
    if (!saved || typeof saved.left !== 'number' || typeof saved.top !== 'number') return;
    const w = toolbar.getBoundingClientRect().width || 160;
    toolbar.style.left = clamp(saved.left, 0, Math.max(0, window.innerWidth - w)) + 'px';
    toolbar.style.top = clamp(saved.top, 0, Math.max(0, window.innerHeight - TB_BTN - TB_PAD * 2)) + 'px';
    toolbar.style.right = 'auto';
}

// ---------- 菜单面板 ----------

let menuPanel = null;

function closeMenu() {
    if (menuPanel) { menuPanel.remove(); menuPanel = null; }
}

function openSettings() {
    closeMenu();
    openSettingsPanel();
}

function quitApp() {
    log('menu → quit');
    try { ipcRenderer.send('app-quit'); } catch (_) {}
}

// ---------- 设置面板 ----------
// 点 ☰ → 设置 打开。改完保存会写回 config.json 并即时生效(能热应用的项)。
// 翻译后端等需要重启服务的,保存后会提示。

let settingsPanel = null;

/** 设置项定义:key / 标签 / 类型 / 范围 / 说明 */
const SETTINGS_SCHEMA = [
    {
        group: '实时字幕',
        items: [
            { key: 'enableLiveSubtitle', label: '菜单里显示实时字幕开关', type: 'bool' },
            { key: 'sttLanguage', label: '识别语言', type: 'select',
              options: [['ja', '日语'], ['en', '英语'], ['ko', '韩语'], ['zh', '中文']] },
            { key: 'sttLlm', label: '翻译模型(Ollama)', type: 'select',
              options: [['qwen3.5:9b', 'qwen3.5:9b(推荐)'],
                        ['qwen3:30b-a3b-instruct-2507-q4_K_M', 'qwen3 30B(慢)'],
                        ['deepseek-r1:14b', 'deepseek-r1 14B(慢)']] },
            { key: 'sttTranslator', label: '翻译后端', type: 'select',
              options: [['ollama', 'Ollama(本地)'], ['openai', 'OpenAI 兼容'],
                        ['deepl', 'DeepL'], ['none', '不翻译(只显示原文)']] },
            { key: 'openaiBaseUrl', label: 'OpenAI 兼容地址', type: 'text',
              placeholder: 'http://127.0.0.1:11434/v1' },
            { key: 'openaiApiKey', label: 'OpenAI / 兼容 Key', type: 'password',
              placeholder: 'ollama 本地填空或随便填' },
            { key: 'openaiModel', label: 'OpenAI 模型名', type: 'text',
              placeholder: 'qwen3.5:9b' },
            { key: 'ollamaUrl', label: 'Ollama 接口地址', type: 'text',
              placeholder: 'http://127.0.0.1:11434/api/generate' },
            { key: 'deeplApiKey', label: 'DeepL Key', type: 'password' },
            { key: 'deeplFree', label: 'DeepL 免费版端点', type: 'bool' },
            { key: 'sttWindowSeconds', label: '预取窗口(秒)', type: 'number', min: 3, max: 30 },
            { key: 'sttLookaheadSeconds', label: '提前算多少秒', type: 'number', min: 10, max: 600 },
            { key: 'sttPreload', label: '启动即加载模型', type: 'bool' },
        ]
    },
    {
        group: '字幕过滤(消除幻觉)',
        items: [
            { key: 'sttFilterEnabled', label: '启用幻觉过滤', type: 'bool' },
            { key: 'sttFilterPhraseLogprob', label: '词表命中阈值', type: 'number',
              min: -2, max: 0, step: 0.05 },
            { key: 'sttFilterMinLogprob', label: '置信度下限', type: 'number',
              min: -3, max: 0, step: 0.05 },
            { key: 'sttFilterMaxNoSpeech', label: '静音概率上限', type: 'number',
              min: 0, max: 1, step: 0.05 },
            { key: 'sttFilterSpeechNoSpeechLogprob', label: '静音时置信度门限', type: 'number',
              min: -2, max: 0, step: 0.05 },
            { key: 'sttFilterMaxRepeat', label: '同句重复上限', type: 'number',
              min: 1, max: 10, step: 1 },
            { key: 'sttCacheEnabled', label: '字幕缓存(同片重看秒出)', type: 'bool' },
            { key: 'sttBackfillRangeSeconds', label: '空闲回补往前秒数(0=关)', type: 'number', min: 0, max: 600, step: 10 },
        ]
    },
    {
        group: '字幕样式',
        items: [
            { key: 'subtitleShowSource', label: '显示原文(双语)', type: 'bool' },
            { key: 'subtitleFontPx', label: '译文字号', type: 'number', min: 14, max: 60 },
            { key: 'subtitleBottomPx', label: '距底部高度', type: 'number', min: 20, max: 400 },
        ]
    },
    {
        group: '手势',
        items: [
            { key: 'seekMode', label: '快进方式', type: 'select',
              options: [['scaled', '按滑动距离'], ['fixed', '固定秒数']] },
            { key: 'seekStepSeconds', label: '快进基准秒数', type: 'number', min: 1, max: 60 },
            { key: 'seekMaxSeconds', label: '单次快进上限', type: 'number', min: 5, max: 300 },
            { key: 'swipeThresholdPx', label: '手势最小距离', type: 'number', min: 20, max: 300 },
            { key: 'enableBackGesture', label: '左边缘右滑返回', type: 'bool' },
            { key: 'backEdgeWidthPx', label: '返回热区宽度', type: 'number', min: 10, max: 200 },
        ]
    },
    {
        group: '界面',
        items: [
            { key: 'enableBigControls', label: '放大 Jellyfin 控件', type: 'bool' },
            { key: 'osdButtonMinPx', label: 'OSD 按钮尺寸', type: 'number', min: 32, max: 100 },
            { key: 'sliderHeightPx', label: '进度条厚度', type: 'number', min: 16, max: 80 },
            { key: 'menuButtonSizePx', label: '选项按钮尺寸', type: 'number', min: 32, max: 80 },
        ]
    },
    {
        group: '调试',
        items: [
            { key: 'debug', label: '记录手势判定日志', type: 'bool' },
        ]
    },
];

function openSettingsPanel() {
    if (settingsPanel) { closeSettingsPanel(); return; }

    const wrap = document.createElement('div');
    wrap.setAttribute('data-jfp-settings', '');
    wrap.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'background:rgba(0,0,0,.72)', 'display:flex',
        'align-items:center', 'justify-content:center',
        'font:15px/1.5 "Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
        'width:min(760px,92vw)', 'max-height:88vh', 'display:flex',
        'flex-direction:column', 'border-radius:14px',
        'background:#161616', 'border:1px solid rgba(255,255,255,.16)',
        'box-shadow:0 24px 64px rgba(0,0,0,.7)', 'color:rgba(255,255,255,.92)',
    ].join(';');

    // 头部
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.12)';
    head.innerHTML = '<div style="font-size:18px;font-weight:600">设置</div>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'width:36px;height:36px;border:0;border-radius:8px;background:rgba(255,255,255,.1);color:#fff;font-size:16px;cursor:pointer';
    closeBtn.addEventListener('click', closeSettingsPanel);
    head.appendChild(closeBtn);

    // 主体(可滚动)
    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:8px 20px 20px';

    const draft = Object.assign({}, cfg);
    const inputs = [];

    for (const g of SETTINGS_SCHEMA) {
        const gt = document.createElement('div');
        gt.textContent = g.group;
        gt.style.cssText = 'margin:18px 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.45)';
        body.appendChild(gt);

        for (const it of g.items) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:7px 0;min-height:34px';
            const lab = document.createElement('div');
            lab.textContent = it.label;
            lab.style.cssText = 'flex:0 0 220px;color:rgba(255,255,255,.8)';
            row.appendChild(lab);

            let ctrl;
            const cur = draft[it.key];

            if (it.type === 'bool') {
                ctrl = document.createElement('button');
                const on = cur !== false;
                ctrl.textContent = on ? '开' : '关';
                ctrl.style.cssText = `min-width:64px;padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.2);cursor:pointer;font:inherit;background:${on ? '#2d6cdf' : 'rgba(255,255,255,.08)'};color:#fff`;
                ctrl.dataset.on = String(on);
                ctrl.addEventListener('click', () => {
                    const now = ctrl.dataset.on !== 'true';
                    ctrl.dataset.on = String(now);
                    ctrl.textContent = now ? '开' : '关';
                    ctrl.style.background = now ? '#2d6cdf' : 'rgba(255,255,255,.08)';
                    draft[it.key] = now;
                });
            } else if (it.type === 'select') {
                ctrl = document.createElement('select');
                ctrl.style.cssText = 'flex:1;max-width:360px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#222;color:#fff;font:inherit';
                const opts = it.options || [];
                let matched = false;
                for (const [v, t] of opts) {
                    const o = document.createElement('option');
                    o.value = v; o.textContent = t;
                    if (String(cur) === String(v)) { o.selected = true; matched = true; }
                    ctrl.appendChild(o);
                }
                if (!matched && cur != null && String(cur) !== '') {
                    const o = document.createElement('option');
                    o.value = String(cur);
                    o.textContent = `${cur}(当前)`;
                    o.selected = true;
                    ctrl.insertBefore(o, ctrl.firstChild);
                }
                ctrl.addEventListener('change', () => { draft[it.key] = ctrl.value; });
            } else {
                ctrl = document.createElement('input');
                ctrl.type = it.type === 'password' ? 'password' : (it.type === 'number' ? 'number' : 'text');
                if (it.min != null) ctrl.min = it.min;
                if (it.max != null) ctrl.max = it.max;
                if (it.step != null) ctrl.step = it.step;
                if (it.placeholder) ctrl.placeholder = it.placeholder;
                ctrl.value = cur == null ? '' : String(cur);
                ctrl.style.cssText = 'flex:1;max-width:360px;padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:#222;color:#fff;font:inherit';
                ctrl.addEventListener('input', () => {
                    if (it.type === 'number') {
                        const n = Number(ctrl.value);
                        if (Number.isFinite(n)) draft[it.key] = n;   // 空串不覆盖原值
                    } else {
                        draft[it.key] = ctrl.value;
                    }
                });
            }
            row.appendChild(ctrl);
            inputs.push({ it, ctrl });
            body.appendChild(row);
        }
    }

    // 底部
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;gap:12px;padding:14px 20px;border-top:1px solid rgba(255,255,255,.12)';
    const hint = document.createElement('div');
    hint.style.cssText = 'flex:1;font-size:13px;color:rgba(255,255,255,.45)';
    hint.textContent = '改完点保存会写回 config.json';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = 'padding:9px 22px;border:0;border-radius:9px;background:#2d6cdf;color:#fff;font:inherit;font-weight:600;cursor:pointer';

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '恢复当前值';
    resetBtn.style.cssText = 'padding:9px 16px;border:1px solid rgba(255,255,255,.2);border-radius:9px;background:transparent;color:#fff;font:inherit;cursor:pointer';
    resetBtn.addEventListener('click', () => { closeSettingsPanel(); openSettingsPanel(); });

    foot.appendChild(hint);
    foot.appendChild(resetBtn);
    foot.appendChild(saveBtn);

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中…';
        // 只提交 schema 里有的键,避免把无关字段带回去
        const patch = {};
        for (const g of SETTINGS_SCHEMA) {
            for (const it of g.items) patch[it.key] = draft[it.key];
        }
        try {
            const r = await ipcRenderer.invoke('settings:save', patch);
            if (r && r.ok) {
                hint.textContent = '已保存' + (r.restartHint ? ' — ' + r.restartHint : '');
                hint.style.color = '#6cc06c';
                // 热应用:样式类改动立即生效
                cfg.enableBigControls = patch.enableBigControls;
                cfg.osdButtonMinPx = patch.osdButtonMinPx;
                cfg.sliderHeightPx = patch.sliderHeightPx;
                cfg.menuButtonSizePx = patch.menuButtonSizePx;
                cfg.subtitleFontPx = patch.subtitleFontPx;
                cfg.subtitleBottomPx = patch.subtitleBottomPx;
                cfg.subtitleShowSource = patch.subtitleShowSource;
                if (uiStyleEl) { uiStyleEl.remove(); uiStyleEl = null; }
                ensureUiStyle();
                if (stt.on) { await sttStop(); await sttStart(); }
            } else {
                hint.textContent = '保存失败: ' + ((r && r.error) || '未知');
                hint.style.color = '#e07070';
            }
        } catch (err) {
            hint.textContent = '保存失败: ' + err.message;
            hint.style.color = '#e07070';
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
    });

    box.appendChild(head);
    box.appendChild(body);
    box.appendChild(foot);
    wrap.appendChild(box);

    // 点背景关闭
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeSettingsPanel(); });
    document.documentElement.appendChild(wrap);
    settingsPanel = wrap;
    log('settings panel opened');
}

function closeSettingsPanel() {
    if (settingsPanel) { settingsPanel.remove(); settingsPanel = null; }
}

function openMenu() {
    if (menuPanel) { closeMenu(); return; }   // 再点一次收起

    menuPanel = document.createElement('div');
    menuPanel.setAttribute('data-jfp-menu', '');
    menuPanel.style.cssText = [
        'position:fixed', 'min-width:180px', 'padding:8px',
        'border-radius:12px', 'border:1px solid rgba(255,255,255,.18)',
        'background:rgba(18,18,18,.96)', 'box-shadow:0 8px 28px rgba(0,0,0,.55)',
        'z-index:2147483647', 'display:flex', 'flex-direction:column', 'gap:4px',
        'font:16px/1.2 "Segoe UI",sans-serif'
    ].join(';');

    const item = (label, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = [
            'display:block', 'width:100%', 'padding:12px 16px', 'text-align:left',
            'background:transparent', 'border:0', 'border-radius:8px',
            'color:rgba(255,255,255,.92)', 'font:inherit', 'cursor:pointer'
        ].join(';');
        b.addEventListener('mouseenter', () => { b.style.background = 'rgba(255,255,255,.12)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
        // 用 pointerdown + stopPropagation,避免被手势引擎/页面逻辑吞掉
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
    };

    menuPanel.appendChild(item('⚙  设置', openSettings));
    // 按键被拖乱后一键复位(用户反馈过"按键位置不对",给个出口)
    menuPanel.appendChild(item('↺  按键位置复位', () => {
        closeMenu();
        navResetPositions();
    }));
    if (cfg.enableLiveSubtitle !== false) {
        const liveItem = item(stt.on ? '🌐  实时字幕：开' : '🌐  实时字幕：关', async () => {
            closeMenu();
            await sttToggle();
        });
        liveItem.setAttribute('data-jfp-live', stt.on ? 'on' : 'off');
        menuPanel.appendChild(liveItem);
    }
    menuPanel.appendChild(item('⏻  退出', quitApp));

    document.documentElement.appendChild(menuPanel);

    // 贴着按钮摆:优先放按钮左侧,空间不够就翻到右边;纵向与按钮顶对齐
    const r = menuBtn.getBoundingClientRect();
    const pr = menuPanel.getBoundingClientRect();
    let left = r.left - pr.width - 8;
    if (left < 8) left = Math.min(r.right + 8, window.innerWidth - pr.width - 8);
    let top = r.top;
    if (top + pr.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - pr.height - 8);
    menuPanel.style.left = Math.max(0, left) + 'px';
    menuPanel.style.top = top + 'px';

    log('menu opened');
}

// 注意:必须是函数声明,不能写成 (function installMenuButton(){})(),
// 具名函数表达式的名字只在其函数体内可见,外层调用会抛 ReferenceError。
function installMenuButton() {
    if (!document.documentElement) return;    // 过早调用时交给下方定时器重试
    if (!toolbar.isConnected) {
        document.documentElement.appendChild(toolbar);
        restoreMenuPos();                     // 重挂后回到用户放的位置
        syncOsdBtnVisual();
    }
}
installMenuButton();

// ---- 工具栏整体拖动 ----
let menuDrag = null;
toolbar.addEventListener('mousedown', (e) => {
    // 只从按钮上按下才算(避免点到空白也拖)
    const r = toolbar.getBoundingClientRect();
    menuDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top,
                 w: r.width, moved: false,
                 target: e.target };
});

document.addEventListener('mousemove', (e) => {
    if (!menuDrag) return;
    const dx = e.clientX - menuDrag.x, dy = e.clientY - menuDrag.y;
    if (!menuDrag.moved && Math.hypot(dx, dy) < 8) return;
    menuDrag.moved = true;
    closeMenu();                              // 拖动时收起菜单,避免菜单跟着乱跑
    const h = toolbar.getBoundingClientRect().height;
    toolbar.style.left = clamp(menuDrag.left + dx, 0, window.innerWidth - menuDrag.w) + 'px';
    toolbar.style.top = clamp(menuDrag.top + dy, 0, window.innerHeight - h) + 'px';
    toolbar.style.right = 'auto';
}, true);

document.addEventListener('mouseup', () => {
    if (!menuDrag) return;
    const moved = menuDrag.moved;
    const target = menuDrag.target;
    menuDrag = null;

    if (!moved) {
        // 判断点的是哪个按钮
        if (target && target.closest) {
            if (target.closest('[data-jfp-osd-btn]')) { navToggleOsd(); return; }
            if (target.closest('[data-jfp-menu-btn]')) { openMenu(); return; }
        }
        return;
    }
    // 拖动结束:记住工具栏位置
    const r = toolbar.getBoundingClientRect();
    try {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    } catch (_) {}
    log(`toolbar moved to (${Math.round(r.left)},${Math.round(r.top)})`);
}, true);

// 点空白处收起菜单
document.addEventListener('mousedown', (e) => {
    if (!menuPanel) return;
    if (menuPanel.contains(e.target) || (e.target && e.target.closest && e.target.closest('[data-jfp-menu-btn]'))) return;
    closeMenu();
}, true);

// ---------- 控件放大 + 界面缩放 ----------
// 两级:
//   1) 定向放大:OSD 按钮/进度条/详情页图标 —— 只加热区
//   2) 整体缩放(uiScale>1):抬 html 根字号,让卡片/文字/控件一起变大
// 注意:整体缩放必须"成套"放大 —— 只抬字号而图标用固定 px 会让图标相对变小,
// 所以图标尺寸也按 scale 一起乘。
// 实测(2196x1270 桌面 → 手机串流):60px 按钮只占 2.7%,手机上是真的小。

let uiStyleEl = null;

function uiCss() {
    const scale = Number(cfg.uiScale) > 0 ? Number(cfg.uiScale) : 1;
    const btnMin = Math.round((cfg.osdButtonMinPx != null ? cfg.osdButtonMinPx : 60) * scale);
    const sliderH = Math.round((cfg.sliderHeightPx != null ? cfg.sliderHeightPx : 46) * scale);
    const thumb = Math.round((cfg.sliderThumbPx != null ? cfg.sliderThumbPx : 28) * scale);
    const iconSize = Math.round(btnMin / 2);

    const parts = [];

    if (scale !== 1) {
        // Jellyfin 基线 html{font-size:93%}
        parts.push(`html { font-size: ${Math.round(93 * scale)}% !important; }`);
        parts.push(`.material-icons { font-size: ${Math.round(24 * scale)}px !important; }`);
    }

    parts.push(
        /* 1) 播放器 OSD 按钮 */
        `.osdControls button, .videoOsdBottom button {
            min-width: ${btnMin}px !important; min-height: ${btnMin}px !important;
            padding: 8px !important;
        }`,
        /* OSD 图标用更高优先级覆盖上面的通用图标字号 */
        `.osdControls button .material-icons, .videoOsdBottom button .material-icons {
            font-size: ${iconSize}px !important;
        }`,
        /* 2) 进度条/音量条 + 滑块 */
        `.osdControls input[type="range"], .sliderContainer input[type="range"] {
            height: ${sliderH}px !important;
        }`,
        `.osdControls input[type="range"]::-webkit-slider-thumb,
         .sliderContainer input[type="range"]::-webkit-slider-thumb {
            width: ${thumb}px !important; height: ${thumb}px !important;
        }`,
        /* 3) 详情页/列表页圆形按钮 */
        `.detailButton, .btnPlay, .itemAction, .cardOverlayButton {
            min-width: ${Math.round(btnMin * 0.9)}px !important;
            min-height: ${Math.round(btnMin * 0.9)}px !important;
        }`,
        /* 4) 顶部/侧边按钮 */
        `.mainDrawerButton, .headerButton, .btnBack, .btnHome {
            min-width: ${Math.round(btnMin * 0.9)}px !important;
            min-height: ${Math.round(btnMin * 0.9)}px !important;
        }`
    );

    return parts.join('\n');
}

function ensureUiStyle() {
    if (cfg.enableBigControls === false) return;
    if (!document.documentElement) return;
    if (!uiStyleEl || !uiStyleEl.isConnected) {
        uiStyleEl = document.createElement('style');
        uiStyleEl.setAttribute('data-jfp-ui', '');
        document.documentElement.appendChild(uiStyleEl);
        // Jellyfin 可能重挂 DOM,每次重挂都补回
        uiStyleEl.textContent = uiCss();
    }
}

// ---------- 实时语音字幕 ----------
// 对视频里的语音做识别+翻译,不依赖任何字幕文件。
// 主进程负责起 Python 服务;这里只做三件事:
//   1) 找到当前播放的媒体在 Jellyfin 里的地址
//   2) 定时把播放位置报给服务(服务据此预取未来窗口)
//   3) 把服务返回的字幕画到画面上(双语:原文上、译文下)

// 整体设计(状态机):
//
//   状态机只有一个真相来源:stt.mediaKey = 当前正在做字幕的媒体身份。
//   主循环每 500ms 做一次「对账」:
//     1. 没在播放页(video 没了)      → 停
//     2. 用户关了开关                 → 停
//     3. 播放页有 video,但 itemId 变了 → 切(停旧 + 起新)
//     4. itemId 没变                  → 只上报位置
//   服务端也用同一个 mediaKey 做二次校验:一旦发现不一致就回 needRestart,
//   客户端据此重建会话。两边的判断依据完全相同,不会互相打架。

const stt = {
    on: false,              // 用户意图:是否开启实时字幕(换片/切页都保持)
    mediaKey: '',           // 当前会话绑定的媒体身份(itemId 优先)
    cues: [],
    el: null,
    posTimer: 0,
    cueTimer: 0,
    busy: false,            // 正在切换会话,避免并发重建
    starting: false,        // 正在启动(互斥,防自动恢复与手动开启撞车)
    idleSince: 0,           // 进入"没有 video"状态的时刻(用于宽限期)
    lastPos: 0,             // 最后一次上报的播放位置(离开播放页时沿用)
    lastStatus: null,
    lastError: '',
};

function sttLog(msg) { log(`[live] ${msg}`); }

/** 记住"用户开着字幕"这个意图,页面重载后自动恢复 */
const STT_ON_KEY = 'jfp-stt-on';
function sttSaveIntent(on) {
    try { localStorage.setItem(STT_ON_KEY, on ? '1' : '0'); } catch (_) {}
}
function sttLoadIntent() {
    try { return localStorage.getItem(STT_ON_KEY) === '1'; } catch (_) { return false; }
}

/** 记住最近访问的详情页 id:播放页地址往往不带 id,靠这个兜底 */
function sttRememberItemId() {
    const m = /[?&]id=([0-9a-fA-F]{16,})/.exec(location.hash || '')
           || /[?&]id=([0-9a-fA-F]{16,})/.exec(location.search || '');
    if (m) {
        try { sessionStorage.setItem('jfp-last-item-id', m[1]); } catch (_) {}
    }
}
sttRememberItemId();
window.addEventListener('hashchange', sttRememberItemId);

/** 从 Jellyfin 页面上下文里取出当前播放项的 Id 和媒体流地址 */
async function sttResolveMedia(video) {
    let itemId = '';

    // 途径 1:地址栏(详情页是 #/details?id=xxx,但播放页往往是 #/video 不带 id)
    const fromHash = /[?&]id=([0-9a-fA-F]{16,})/.exec(location.hash || '')
                  || /[?&]id=([0-9a-fA-F]{16,})/.exec(location.search || '');
    if (fromHash) itemId = fromHash[1];

    // 途径 2:视频元素所在播放器容器上的 data-id
    if (!itemId && video) {
        const host = video.closest('[data-id]');
        if (host) itemId = host.getAttribute('data-id') || '';
    }

    // 途径 3:通过 Jellyfin API 查当前正在播放的条目
    // (播放页地址不带 id,页面上的 data-id 也常是别的卡片,只有会话接口最准)
    if (!itemId) {
        try {
            const cred = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
            const s = (cred.Servers || [])[0] || {};
            const token = s.AccessToken || '';
            const server = s.ManualAddress || s.LocalAddress || location.origin;
            if (token) {
                const r = await fetch(`${server}/Sessions?ControllableByUserId=`, {
                    headers: { Authorization: `MediaBrowser Token="${token}"` },
                });
                if (r.ok) {
                    const sessions = await r.json();
                    // 找本机这个播放器自己的会话里 NowPlayingItem
                    const now = sessions
                        .map((x) => x.NowPlayingItem)
                        .find((x) => x && x.Id);
                    if (now && now.Id) itemId = now.Id;
                }
            }
        } catch (_) { /* ignore */ }
    }

    // 途径 4:从 <video> 的当前 src 反查(blob: 无法反查,但直链时可以)
    if (!itemId && video) {
        const m = /\/Videos\/([0-9a-fA-F]{16,})\//.exec(video.currentSrc || video.src || '');
        if (m) itemId = m[1];
    }

    // 途径 5:从最近一次详情页访问记录里拿
    if (!itemId) {
        try {
            const last = sessionStorage.getItem('jfp-last-item-id');
            if (last && /^[0-9a-fA-F]{16,}$/.test(last)) itemId = last;
        } catch (_) {}
    }

    if (!itemId) return { ok: false, error: '无法识别当前媒体(请在详情页或播放中重试)' };

    let token = '';
    let server = location.origin;
    try {
        const raw = localStorage.getItem('jellyfin_credentials');
        if (raw) {
            const cred = JSON.parse(raw);
            const s = (cred.Servers || [])[0] || {};
            token = s.AccessToken || '';
            server = s.ManualAddress || s.LocalAddress || server;
        }
    } catch (_) { /* 忽略 */ }

    if (!token) return { ok: false, error: '拿不到 Jellyfin AccessToken' };

    // 注意:Jellyfin 12.1 不接受 URL 里的 api_key 查询参数(实测返回 400),
    // 必须用 Authorization Header。所以这里只传干净的流地址,
    // token 单独交给字幕服务,由它在请求头里带上。
    const url = `${server}/Videos/${itemId}/stream?static=true&mediaSourceId=${itemId}`;
    return { ok: true, itemId, url, token };
}

function sttEnsureLayer() {
    if (stt.el && stt.el.isConnected) return stt.el;
    const el = document.createElement('div');
    el.setAttribute('data-jfp-subtitle', '');
    el.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        `bottom:${cfg.subtitleBottomPx != null ? cfg.subtitleBottomPx : 90}px`,
        'max-width:86vw', 'text-align:center', 'pointer-events:none',
        'z-index:2147483645', 'display:none',
        'font-family:"Noto Sans SC","Microsoft YaHei",sans-serif',
        // 颜色必须显式指定:不指定会继承页面正文色(深色),
        // 深色画面上等于看不见。用白色 + 黑色描边/阴影保证任何底色都可读。
        `color:${cfg.subtitleColor || '#fff'}`,
        'text-shadow:0 2px 6px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.95),0 1px 2px rgba(0,0,0,.98)',
        'line-height:1.35', 'white-space:pre-wrap'
    ].join(';');
    document.documentElement.appendChild(el);
    stt.el = el;
    return el;
}

function sttRender() {
    const el = sttEnsureLayer();
    const v = document.querySelector('video');
    if (!stt.on || !v) { el.style.display = 'none'; return; }

    const t = v.currentTime;
    const cue = stt.cues.find((c) => t >= c.start && t <= c.end + 0.25);
    if (!cue) { el.style.display = 'none'; return; }

    const zhSize = cfg.subtitleFontPx != null ? cfg.subtitleFontPx : 30;
    const srcSize = Math.round(zhSize * 0.62);
    const col = cfg.subtitleColor || '#fff';
    const parts = [];
    if (cfg.subtitleShowSource !== false && cue.text) {
        // 原文用稍弱的不透明度,但仍显式给颜色,避免继承深色正文
        parts.push(`<div style="font-size:${srcSize}px;color:${sttEscape(col)};`
            + `opacity:.76;margin-bottom:4px">${sttEscape(cue.text)}</div>`);
    }
    parts.push(`<div style="font-size:${zhSize}px;font-weight:600;`
        + `color:${sttEscape(col)}">${sttEscape(cue.zh || '')}</div>`);
    el.innerHTML = parts.join('');
    el.style.display = 'block';
}

function sttEscape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 拉取播放位置附近的字幕;服务端是预取好的,这里只是取缓存 */
async function sttPoll() {
    if (!stt.on) return;
    const v = document.querySelector('video');
    if (!v) return;
    try {
        const r = await ipcRenderer.invoke('stt:cues', {
            from: Math.max(0, v.currentTime - 5),
            to: v.currentTime + 120,
        });
        if (r && Array.isArray(r.cues)) {
            stt.cues = r.cues;
            stt.lastStatus = r.status || null;
        }
    } catch (_) { /* 服务未就绪,下一轮再试 */ }
}

/** 组装一次 /start 请求体(集中在一处,避免参数散落) */
function numOr(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function sttStartPayload(media, video) {
    return {
        media: media.url,
        token: media.token || '',
        itemId: media.itemId || '',     // 身份标识,服务端据此判重 + 做字幕缓存
        cache: cfg.sttCacheEnabled !== false,   // 是否读写磁盘缓存
        from: Math.floor(video.currentTime || 0),
        language: cfg.sttLanguage || 'ja',
        llm: cfg.sttLlm || 'qwen3.5:9b',
        window: cfg.sttWindowSeconds || 10,
        lookahead: cfg.sttLookaheadSeconds || 60,
        backfillRange: cfg.sttBackfillRangeSeconds != null
            ? Number(cfg.sttBackfillRangeSeconds) : 60,
        translator: cfg.sttTranslator || 'ollama',
        ollamaUrl: cfg.ollamaUrl || '',
        openaiBaseUrl: cfg.openaiBaseUrl || '',
        openaiApiKey: cfg.openaiApiKey || '',
        openaiModel: cfg.openaiModel || '',
        deeplApiKey: cfg.deeplApiKey || '',
        deeplFree: cfg.deeplFree !== false,
        // ---------- 幻觉过滤(全部可配置,见 config.json) ----------
        // Whisper 在弱语音段会编片尾字幕(如「ご視聴ありがとうございました」),
        // 和实际内容无关,必须过滤,否则字幕会和画面对不上。
        filter: {
            enabled: cfg.sttFilterEnabled !== false,
            phraseLogprob: numOr(cfg.sttFilterPhraseLogprob, -0.35),
            minLogprob: numOr(cfg.sttFilterMinLogprob, -1.05),
            maxNoSpeech: numOr(cfg.sttFilterMaxNoSpeech, 0.60),
            speechNoSpeechLogprob: numOr(cfg.sttFilterSpeechNoSpeechLogprob, -0.35),
            maxRepeat: numOr(cfg.sttFilterMaxRepeat, 2),
            phrases: Array.isArray(cfg.sttFilterPhrases) ? cfg.sttFilterPhrases : undefined,
            markers: Array.isArray(cfg.sttFilterMarkers) ? cfg.sttFilterMarkers : undefined,
        },
    };
}

/**
 * 对账:让「服务端会话」和「页面当前播放项」保持一致。
 * 这是唯一的调度入口,不做别的事。
 *
 * 重要概念:
 *   stt.on       = 用户意图(开着就一直开着,换片也不变)
 *   stt.sessionId= 当前服务端会话(换片会换)
 *   stt.mediaKey = 会话绑定的媒体
 * 只有用户主动关,或者彻底离开播放场景超过宽限期,才会把 stt.on 置 false。
 *
 * @returns {Promise<'idle'|'stopped'|'switched'|'kept'|'waiting'|'error'>}
 */
async function sttReconcile() {
    if (!stt.on) return 'stopped';
    if (stt.busy) return 'kept';        // 正在切换,本轮跳过

    const v = document.querySelector('video');

    // 情况 1:暂时没有 video。
    // 不能立刻停 —— 换片时要经过"列表/详情页"这一瞬间没有 video,
    // 立刻停会导致"换片后还得手动再开"。给一个宽限期,超过才真正停。
    if (!v) {
        // 关键:宽限期内要保持会话存活,但必须让服务端**暂停计算**,
        // 否则退回列表页后它还在后台烧 GPU(实测退页后仍算了 9 秒)。
        // 位置沿用上次的,不传 0(传 0 会被误判成"跳回开头")。
        const markPaused = () => ipcRenderer.invoke('stt:position', {
            time: stt.lastPos || 0,
            playing: false,
            mediaKey: stt.mediaKey,
        }).catch(() => {});

        if (!stt.idleSince) {
            stt.idleSince = Date.now();
            sttLog('暂时没有视频,进入宽限期(已通知服务端暂停)');
            markPaused();
            return 'waiting';
        }
        const grace = cfg.sttIdleGraceMs != null ? cfg.sttIdleGraceMs : 45000;
        if (Date.now() - stt.idleSince > grace) {
            sttLog(`已离开播放超过 ${Math.round(grace / 1000)}s,自动停止`);
            await sttStop({ silent: true });
            return 'stopped';
        }
        markPaused();                   // 宽限期内持续提醒,防止服务端忘记
        return 'waiting';
    }
    stt.idleSince = 0;                  // 有视频了,清掉宽限计时

    // 情况 2:识别当前媒体身份
    let media;
    try {
        media = await sttResolveMedia(v);
    } catch (err) {
        return 'kept';
    }
    if (!media.ok || !media.itemId) {
        // 暂时识别不到(页面切换中),不轻举妄动
        return 'kept';
    }

    // 情况 3:身份变了 → 切换(用户开着字幕,换片就自动跟)
    if (stt.mediaKey && media.itemId !== stt.mediaKey) {
        sttLog(`换片 ${stt.mediaKey} → ${media.itemId},自动切换`);
        await sttSwitchSession(media, v);
        return 'switched';
    }

    // 情况 4:还没有会话(刚开启/刚换片失败重试) → 补建
    if (!stt.mediaKey) {
        sttLog('尚未建立会话,补建');
        await sttSwitchSession(media, v);
        return 'switched';
    }

    // 情况 5:身份一致 → 只上报位置
    try {
        stt.lastPos = v.currentTime;      // 记住位置,离开播放页时沿用
        const r = await ipcRenderer.invoke('stt:position', {
            time: v.currentTime,
            playing: !v.paused,
            mediaKey: media.itemId,
        });
        if (r && r.needRestart) {
            // 服务端说媒体变了(或会话丢了)→ 重建
            sttLog('服务端要求重建会话');
            await sttSwitchSession(media, v);
            return 'switched';
        }
        if (r && r.status) stt.lastStatus = r.status;
    } catch (_) { /* 下轮再试 */ }
    return 'kept';
}

/** 为指定媒体重建会话(停旧 → 起新) */
async function sttSwitchSession(media, video) {
    stt.busy = true;
    try {
        try { await ipcRenderer.invoke('stt:stop'); } catch (_) { /* ignore */ }

        stt.mediaKey = media.itemId;
        stt.cues = [];
        if (stt.el) stt.el.style.display = 'none';

        const r = await ipcRenderer.invoke('stt:start', sttStartPayload(media, video));
        if (r && r.ok) {
            stt.lastStatus = r.status || null;
            if (r.reused) {
                sttLog(`会话已复用(媒体一致)`);
            } else {
                sttLog(`会话已建立 ${r.status && r.status.id || ''}`);
                toast('🌐 已跟随新片');
            }
        } else {
            const err = (r && r.error) || '未知';
            stt.lastError = err;
            sttLog(`切换失败: ${err}`);
            toast(`🌐 切换失败: ${err}`);
        }
    } finally {
        stt.busy = false;
    }
}

async function sttStart() {
    // 互斥:自动恢复和用户点菜单可能同时进来,重复启动会导致
    // 两个会话互相顶替、日志里出现"已开启"两次、甚至把服务搞挂。
    if (stt.starting) {
        sttLog('已在启动中,忽略重复请求');
        return stt.on;
    }
    stt.starting = true;

    try {
        const v = document.querySelector('video');
        if (!v) { toast('🌐 请先播放视频'); return false; }

        const media = await sttResolveMedia(v);
        if (!media.ok) {
            toast(`🌐 ${media.error}`);
            sttLog(`启动失败: ${media.error}`);
            return false;
        }

        stt.on = true;
        sttSaveIntent(true);        // 记住意图,页面重载后自动恢复
        stt.mediaKey = '';
        stt.idleSince = 0;
        toast('🌐 正在准备实时字幕…');

        // 先起定时器,让后续的对账/渲染接管
        sttEnsureLayer();
        if (!stt.posTimer) stt.posTimer = setInterval(sttReconcile, 500);
        if (!stt.cueTimer) stt.cueTimer = setInterval(() => { sttPoll(); sttRender(); }, 200);

        await sttSwitchSession(media, v);
        if (stt.lastError) {
            stt.on = false;
            sttSaveIntent(false);
            await sttStop({ silent: true });
            return false;
        }

        sttPoll();
        toast('🌐 实时字幕已开启');
        sttLog('已开启');
        return true;
    } finally {
        stt.starting = false;
    }
}

async function sttStop(opts) {
    const silent = opts && opts.silent;
    stt.on = false;
    stt.mediaKey = '';
    stt.idleSince = 0;
    if (!silent) sttSaveIntent(false);   // 用户主动关才清意图;自动停(超时)保留意图
    clearInterval(stt.posTimer);
    clearInterval(stt.cueTimer);
    stt.posTimer = 0;
    stt.cueTimer = 0;
    stt.cues = [];
    if (stt.el) stt.el.style.display = 'none';
    try { await ipcRenderer.invoke('stt:stop'); } catch (_) { /* ignore */ }
    if (!silent) toast('🌐 实时字幕已关闭');
    sttLog(silent ? '已自动停止' : '已关闭');
}

async function sttToggle() {
    if (stt.on) { await sttStop(); return false; }
    return await sttStart();
}

/**
 * 页面加载后自动恢复上一次的字幕开启状态。
 * 场景:用户在看着字幕,刷新/重载/换片导致页面重新挂载,preload 重新执行。
 * 只要意图还在、且当前有视频,就自动重新开启,不需要用户再点一次。
 *
 * 注意:只在**播放页**(有 video)恢复。在首页/列表页时不要抢着启动,
 * 否则会和用户手动开启撞车,也会白白拉起字幕服务。
 */
async function sttRestoreIfNeeded() {
    if (stt.on || stt.starting) return;
    if (!sttLoadIntent()) return;

    const started = Date.now();
    while (Date.now() - started < 60000) {
        if (stt.on || stt.starting) return;      // 用户已手动开了,让位
        const v = document.querySelector('video');
        if (v && v.readyState >= 1) {
            // 再确认当前确实在播放页(地址带 video 或有可播放媒体)
            sttLog('检测到上次开着字幕,自动恢复');
            await sttStart();
            return;
        }
        await new Promise((r) => setTimeout(r, 800));
    }
    sttLog('未等到可播放的视频,放弃自动恢复');
}

// ---------- 隐藏光标 + 元素自愈(preload 侧保险,主进程 insertCSS 为主) ----------
// 注意:preload 契约只保证 document 存在,documentElement 可能尚未创建(打包环境实测更早执行)

const cursorStyle = document.createElement('style');
cursorStyle.setAttribute('data-jfp-cursor', '');
cursorStyle.textContent = '*, *::before, *::after { cursor: none !important; }';

function ensureCursorStyle() {
    if (document.documentElement && !cursorStyle.isConnected) {
        document.documentElement.appendChild(cursorStyle);
    }
}
ensureCursorStyle();
ensureUiStyle();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        ensureCursorStyle();
        ensureUiStyle();
        installMenuButton();
    });
}
setInterval(() => {
    ensureCursorStyle();
    ensureUiStyle();              // 放大样式掉了就补
    installMenuButton();          // Jellyfin 可能整页重挂 DOM,按钮掉了就补
    ensureNavButtons();           // 虚拟按键:按场景挂
    keepOsdPinned();              // 控制栏被固定时维持可见
    if (document.body) document.body.style.cursor = 'none';
}, 1000);

// 恢复上次的字幕意图(页面重载/换片后不用手动再开)
if (cfg.enableLiveSubtitle !== false) {
    setTimeout(() => { sttRestoreIfNeeded().catch(() => {}); }, 1500);
}

log(`gesture engine ready (seekMode=${cfg.seekMode}, threshold=${cfg.swipeThresholdPx}px/${cfg.swipeMaxMs}ms, debug=${!!cfg.debug})`);
