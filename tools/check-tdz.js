// 找出 preload 里可能触发 TDZ(暂时性死区)的声明顺序问题。
const fs = require('fs');
const file = process.argv[2] || 'C:\\AI\\jellyfinplayer\\src\\preload.js';
const c = fs.readFileSync(file, 'utf8');
const lines = c.split('\n');

// 收集顶层声明(第 0 列开始的 const/let/function)
const decls = {};
lines.forEach((l, i) => {
    const m = /^(const|let|function)\s+([A-Za-z_$][\w$]*)/.exec(l);
    if (m) {
        const name = m[2];
        if (!decls[name]) decls[name] = { line: i + 1, kind: m[1] };
    }
});

const bad = [];
for (const [name, d] of Object.entries(decls)) {
    // 跳过 function:函数声明会提升
    if (d.kind === 'function') continue;
    const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b');
    for (let i = 0; i < d.line - 1; i++) {
        const ln = lines[i];
        if (!ln.trim() || ln.trim().startsWith('//')) continue;
        if (re.test(ln)) {
            bad.push({ name, usedAt: i + 1, declaredAt: d.line, text: ln.trim().slice(0, 80) });
            break;
        }
    }
}

console.log(`文件: ${file}  共 ${lines.length} 行`);
if (!bad.length) {
    console.log('TDZ 风险: 无');
} else {
    console.log(`TDZ 风险 ${bad.length} 处:`);
    for (const b of bad) {
        console.log(`  ${b.name}  使用@${b.usedAt}  声明@${b.declaredAt}`);
        console.log(`      ${b.text}`);
    }
}
