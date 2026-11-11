const a = require('C:\\AI\\jellyfinplayer\\node_modules\\@electron\\asar');
const file = 'C:\\Program Files\\JellyfinPlayer\\resources\\app.asar';
const c = a.extractFile(file, 'src/preload.js').toString();
const m = a.extractFile(file, 'src/main.js').toString();
const cfgD = JSON.parse(require('fs').readFileSync('C:\\Program Files\\JellyfinPlayer\\config.json', 'utf8'));

const r = {
    navButtons: c.includes('ensureNavButtons'),
    navActions: c.includes('function navAction'),
    uiScale: c.includes('uiScale'),
    backKey: c.includes('↩'),
    prevKey: c.includes('◀'),
    nextKey: c.includes('▶'),
    navConfig: m.includes('navButtonSizePx'),
    idleGrace: c.includes('sttIdleGraceMs'),
    persist: c.includes('jfp-stt-on'),
    seekDebounce: c.includes('seekPending'),
};
console.log(JSON.stringify(r, null, 2));
console.log('config: uiScale=' + cfgD.uiScale + ' osd=' + cfgD.osdButtonMinPx +
            ' slider=' + cfgD.sliderHeightPx + ' nav=' + cfgD.navButtonSizePx +
            ' subtitle=' + cfgD.subtitleFontPx);
const bad = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
console.log(bad.length ? 'FAIL: ' + bad.join(', ') : 'ASAR OK: 全部功能都在');
process.exit(bad.length ? 1 : 0);
