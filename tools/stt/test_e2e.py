# -*- coding: utf-8 -*-
"""端到端验证:换片、复用、停止语义(用真实 Jellyfin 流,真实识别翻译)。"""
import sys, os, time, json, urllib.request
sys.path.insert(0, r'C:\AI\jellyfinplayer\tools\stt')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

BASE = 'http://127.0.0.1:8769'
TOKEN = os.environ.get('JELLYFIN_TOKEN', '')  # 从环境变量读,不要硬编码
ID_A = '7ebffe65dfc5de3e80dbf83b4df8b282'
ID_B = '1a68f6948a20155e6eed1891880bddb2'   # 另一条片

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

def stream(item_id):
    return f'http://127.0.0.1:8096/Videos/{item_id}/stream?static=true&mediaSourceId={item_id}'

def start_payload(item_id, frm=60):
    return {'media': stream(item_id), 'token': TOKEN, 'itemId': item_id,
            'from': frm, 'language': 'ja', 'llm': 'qwen3.5:9b',
            'window': 10, 'lookahead': 30,
            'translator': 'ollama', 'ollamaUrl': 'http://127.0.0.1:11434/api/generate'}

print('=' * 72)
print('端到端:换片 / 复用 / 停止')
print('=' * 72)

# 等服务就绪
for _ in range(60):
    try:
        h = get('/health')
        if h.get('ok'): break
    except Exception: pass
    time.sleep(1)
print(f"服务就绪: modelLoaded={h.get('ok')} load={h.get('loadSeconds')}s")

# --- 1. 启动片 A ---
r = post('/start', start_payload(ID_A))
check('片 A 会话建立', r.get('ok') is True and not r.get('reused'), 
      f"id={r.get('status',{}).get('id')} itemId={r.get('status',{}).get('itemId')}")
a_id = r['status']['id']

# 上报位置,让它跑一会。注意:位置推进速度要慢于预取速度,
# 否则会出现"预取永远追不上"(那是测试节奏问题,不是产品缺陷)。
for i in range(10):
    post('/position', {'time': 60 + i * 1.5, 'playing': True, 'mediaKey': ID_A})
    time.sleep(1.0)
s = get('/status')
check('片 A 产出字幕', s.get('cues', 0) > 0, f"cues={s.get('cues')} lead={s.get('leadSeconds')}s")
check('片 A status.itemId 正确', s.get('itemId') == ID_A, s.get('itemId'))
a_cues = s.get('cues', 0)

# --- 2. 同片再次 /start → 必须复用,不重建 ---
r2 = post('/start', start_payload(ID_A, frm=120))
check('同片重复 start 复用会话', r2.get('reused') is True, f"reused={r2.get('reused')}")
check('复用时会话 id 不变', r2['status']['id'] == a_id, f"{a_id} -> {r2['status']['id']}")
check('复用时字幕未丢失', r2['status']['cues'] > 0, f"cues={r2['status']['cues']} (原 {a_cues})")

# --- 3. 上报别的 mediaKey → 服务端应回 needRestart ---
pos = post('/position', {'time': 60, 'playing': True, 'mediaKey': ID_B})
check('mediaKey 不一致时回 needRestart', pos.get('needRestart') is True,
      json.dumps(pos)[:100])

# --- 4. 换片 B:旧会话必须退休 ---
r3 = post('/start', start_payload(ID_B))
check('片 B 会话建立', r3.get('ok') is True and not r3.get('reused'))
check('片 B 是新会话', r3['status']['id'] != a_id, f"{a_id} -> {r3['status']['id']}")
check('片 B itemId 正确', r3['status']['itemId'] == ID_B)
check('换片后字幕清零', r3['status']['cues'] == 0, f"cues={r3['status']['cues']}")

for i in range(10):
    post('/position', {'time': 60 + i * 1.5, 'playing': True, 'mediaKey': ID_B})
    time.sleep(1.0)
s3 = get('/status')
check('片 B 产出字幕', s3.get('cues', 0) > 0, f"cues={s3.get('cues')}")

# --- 5. 停止后不再推进 ---
post('/stop', {})
s4 = get('/status')
check('停止后无活动会话', s4.get('active') is False or 'id' not in s4, json.dumps(s4)[:80])
done1 = s4.get('doneUntil', 0)
time.sleep(2.0)
s5 = get('/status')
done2 = s5.get('doneUntil', 0)
check('停止后不再推进', done2 == done1, f'{done1} -> {done2}')

# --- 6. 停止后 position 应回 needRestart ---
pos2 = post('/position', {'time': 60, 'playing': True, 'mediaKey': ID_A})
check('无会话时 position 回 needRestart', pos2.get('needRestart') is True,
      json.dumps(pos2)[:80])

print()
print(f'结果: {passed} PASS / {failed} FAIL')
sys.exit(0 if failed == 0 else 1)
