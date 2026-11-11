# -*- coding: utf-8 -*-
"""最小化验证:直接检验服务端的跳转处理,排除测试脚本的时序干扰。"""
import sys, os, time, json, urllib.request
sys.path.insert(0, r'C:\AI\jellyfinplayer\tools\stt')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = 'http://127.0.0.1:8772'
TOKEN = os.environ.get('JELLYFIN_TOKEN', '')  # 从环境变量读,不要硬编码
ITEM = '7ebffe65dfc5de3e80dbf83b4df8b282'

def post(p, o):
    r = urllib.request.Request(BASE + p, data=json.dumps(o).encode(),
                               headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(r, timeout=120) as x:
        return json.loads(x.read().decode())

def get(p):
    with urllib.request.urlopen(BASE + p, timeout=30) as x:
        return json.loads(x.read().decode())

stream = f'http://127.0.0.1:8096/Videos/{ITEM}/stream?static=true&mediaSourceId={ITEM}'

for _ in range(60):
    try:
        if get('/health').get('ok'): break
    except Exception: pass
    time.sleep(1)

post('/start', {'media': stream, 'token': TOKEN, 'itemId': ITEM, 'from': 60,
                'language': 'ja', 'llm': 'qwen3.5:9b', 'window': 10,
                'lookahead': 40, 'translator': 'ollama'})

print('阶段1: 正常播放 60s 附近')
for i in range(6):
    post('/position', {'time': 60 + i * 1.5, 'playing': True, 'mediaKey': ITEM})
    time.sleep(1.0)
s = get('/status')
print(f"  done={s['doneUntil']} pos={s['position']} cues={s['cues']}")

print('阶段2: 猛跳到 400s')
post('/position', {'time': 400, 'playing': True, 'mediaKey': ITEM})
for _ in range(20):
    time.sleep(1.0)
    st = get('/status')
    if st['doneUntil'] >= 390:
        break
print(f"  done={st['doneUntil']} pos={st['position']} cues={st['cues']}")
print(f"  -> 对齐正确: {390 <= st['doneUntil'] <= 440}")

print('阶段3: 猛退到 120s(持续上报)')
for i in range(25):
    post('/position', {'time': 120 + i * 0.5, 'playing': True, 'mediaKey': ITEM})
    time.sleep(0.6)
    st = get('/status')
    if st['doneUntil'] <= 180:
        print(f"  第{i+1}轮回到低位: done={st['doneUntil']} pos={st['position']}")
        break
else:
    print(f"  未回到低位: done={st['doneUntil']} pos={st['position']}")

ok = 100 <= st['doneUntil'] <= 200
print(f"  -> 回退对齐正确: {ok} (done={st['doneUntil']})")

cues = get('/cues?from=0&to=1000')['cues']
near = [c for c in cues if 110 <= c['start'] <= 200]
print(f"  -> 120s 附近有字幕: {len(near) > 0} ({len(near)} 条)")

sys.exit(0 if ok else 1)
