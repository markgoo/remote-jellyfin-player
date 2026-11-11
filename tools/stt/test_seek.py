# -*- coding: utf-8 -*-
"""验证:跳转后的字幕对齐(不残留旧字幕、按窗口边界重排)。"""
import sys, os, time, json, urllib.request
sys.path.insert(0, r'C:\AI\jellyfinplayer\tools\stt')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = 'http://127.0.0.1:8771'
TOKEN = os.environ.get('JELLYFIN_TOKEN', '')  # 从环境变量读,不要硬编码
ITEM = '7ebffe65dfc5de3e80dbf83b4df8b282'

passed = failed = 0
def check(name, cond, detail=''):
    global passed, failed
    if cond: passed += 1; print(f'PASS {name}' + (f' :: {detail}' if detail else ''))
    else:    failed += 1; print(f'FAIL {name}' + (f' :: {detail}' if detail else ''))

def post(path, obj):
    r = urllib.request.Request(BASE + path, data=json.dumps(obj).encode(),
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=120) as resp:
        return json.loads(resp.read().decode())

def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as resp:
        return json.loads(resp.read().decode())

stream = f'http://127.0.0.1:8096/Videos/{ITEM}/stream?static=true&mediaSourceId={ITEM}'

print('=' * 72)
print('跳转对齐测试')
print('=' * 72)

for _ in range(60):
    try:
        if get('/health').get('ok'): break
    except Exception: pass
    time.sleep(1)

# 从 60s 开始
post('/start', {'media': stream, 'token': TOKEN, 'itemId': ITEM, 'from': 60,
                'language': 'ja', 'llm': 'qwen3.5:9b', 'window': 10,
                'lookahead': 40, 'translator': 'ollama'})

for i in range(8):
    post('/position', {'time': 60 + i * 1.5, 'playing': True, 'mediaKey': ITEM})
    time.sleep(1.0)

s = get('/status')
check('初始产出字幕', s['cues'] > 0, f"cues={s['cues']} done={s['doneUntil']}")
cues_before = get('/cues?from=0&to=300')['cues']
check('初始字幕集中在 60s 之后',
      all(c['start'] >= 59 for c in cues_before),
      f"最早 {min((c['start'] for c in cues_before), default=0)}s")

# --- 跳到很后面:300s ---
# 注意:后台线程是异步的,需要等它真的处理完对齐 + 至少跑一个窗口
post('/position', {'time': 300, 'playing': True, 'mediaKey': ITEM})
# 等到 doneUntil 进入 300 附近(或超时)
aligned = None
for _ in range(30):
    time.sleep(1.0)
    st = get('/status')
    if st['doneUntil'] >= 290:
        aligned = st
        break
check('跳转后 doneUntil 重排到窗口边界',
      aligned is not None and aligned['doneUntil'] % 10 == 0,
      f"done={aligned['doneUntil'] if aligned else '?'}")
check('跳转后 doneUntil 覆盖到跳转点',
      aligned is not None and 290 <= aligned['doneUntil'] <= 340,
      f"done={aligned['doneUntil'] if aligned else '?'} pos=300")

# 让它在 300s 附近生成
for i in range(6):
    post('/position', {'time': 300 + i * 1.5, 'playing': True, 'mediaKey': ITEM})
    time.sleep(1.0)
s3 = get('/status')
check('跳转后继续产出字幕', s3['cues'] > 0, f"cues={s3['cues']} done={s3['doneUntil']}")

cues_after = get('/cues?from=0&to=1000')['cues']
min_start = min((c['start'] for c in cues_after), default=-1)
check('跳转后旧位置字幕未污染新位置',
      any(295 <= c['start'] <= 360 for c in cues_after),
      f"共 {len(cues_after)} 条, 最早 {min_start:.0f}s")

# --- 再往回跳:回到 100s ---
post('/position', {'time': 100, 'playing': True, 'mediaKey': ITEM})
# 往回跳后 doneUntil 会立刻退到 100 附近,然后再往上长。
# 所以要持续上报 100 附近的位置(模拟播放),同时观察是否回到 100 区间。
back_ok = False
for _ in range(40):
    post('/position', {'time': 100, 'playing': True, 'mediaKey': ITEM})
    time.sleep(1.0)
    st = get('/status')
    if st['doneUntil'] <= 140:
        back_ok = True
        break
check('往回跳后 doneUntil 重排', back_ok,
      f"done={st['doneUntil']}")

for i in range(10):
    post('/position', {'time': 100 + i * 1.5, 'playing': True, 'mediaKey': ITEM})
    time.sleep(1.0)
cues_back = get('/cues?from=0&to=1000')['cues']
check('往回跳后能在 100s 附近生成',
      any(99 <= c['start'] <= 160 for c in cues_back),
      f"共 {len(cues_back)} 条, 范围 "
      f"{min((c['start'] for c in cues_back), default=0):.0f}~"
      f"{max((c['start'] for c in cues_back), default=0):.0f}s")

print()
print(f'结果: {passed} PASS / {failed} FAIL')
sys.exit(0 if failed == 0 else 1)
