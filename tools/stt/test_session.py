# -*- coding: utf-8 -*-
"""会话生命周期单元测试:不启动 GPU 推理,只验证身份判定与退休语义。

关键点:Session 启动的瞬间会检查"我是不是 STATE['session']",
所以测试里必须先登记再使用,否则线程会立刻退休(这正是设计意图)。
"""
import sys, os, time
sys.path.insert(0, r'C:\AI\jellyfinplayer\tools\stt')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import server

passed = failed = 0

def check(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f'PASS {name}' + (f' :: {detail}' if detail else ''))
    else:
        failed += 1
        print(f'FAIL {name}' + (f' :: {detail}' if detail else ''))


class FakeRec:
    """假识别器:不碰 GPU,直接返回固定结果。"""
    device = 'fake'
    load_s = 0.0
    warmed = True
    def transcribe(self, wav, language, offset=0.0):
        time.sleep(0.05)
        # 返回值必须是 (cues, seconds, dropped) 三元组,与正式 Recognizer 一致
        return [{'start': offset, 'end': offset + 2, 'text': 'テスト'}], 0.05, 0
    def warmup(self, media=None, language='ja', token=''): pass


class FakeTrans:
    name = 'fake'
    def batch(self, texts):
        return [f'译:{t}' for t in texts], 0.01


def new_session(media_key, item_id='', start=0, window=10, lookahead=60,
                register=True):
    """建会话。register=True 时先登记再启动线程(与生产代码顺序一致)。"""
    s = server.Session(FakeRec(), 'http://127.0.0.1:8096/x', start, 'ja',
                       'm', window, lookahead, token='',
                       translator=FakeTrans(), media_key=media_key,
                       item_id=item_id or media_key)
    if register:
        with server.STATE['lock']:
            server.STATE['session'] = s
        s.start()
    return s


def cleanup(*sessions):
    with server.STATE['lock']:
        server.STATE['session'] = None
    for s in sessions:
        try: s.retire('清理')
        except Exception: pass
    time.sleep(0.4)


print('=' * 70)
print('会话生命周期测试')
print('=' * 70)

# --- 1. 唯一 id 与身份 ---
s1 = new_session('item-A', register=False)
s2 = new_session('item-B', register=False)
cleanup(s1, s2)
check('会话 id 唯一', s1.id != s2.id, f'{s1.id} vs {s2.id}')
check('会话绑定 mediaKey', s1.media_key == 'item-A')

# --- 2. 未登记 → _alive() 应为 False(防止野会话烧 GPU) ---
s = new_session('item-X', register=False)
time.sleep(0.15)
check('未登记时 _alive()=False', s._alive() is False,
      f'retired={s.retired}')
cleanup(s)

# --- 3. 登记后 _alive()=True ---
s = new_session('item-Y')
time.sleep(0.1)
check('登记后 _alive()=True', s._alive() is True)

# --- 4. 被顶替 → 立刻失效并自动 retired ---
s_new = new_session('item-Z')
with server.STATE['lock']:
    server.STATE['session'] = s_new       # 顶替 s
alive = s._alive()
check('被顶替后 _alive()=False', alive is False)
check('被顶替后自动 retired', s.retired is True)
cleanup(s, s_new)

# --- 5. retire() 语义 ---
s = new_session('item-R')
s.retire('测试退休')
check('retire 后 _alive()=False', s._alive() is False)
check('retire 后 status.active=False', s.status()['active'] is False)
cleanup(s)

# --- 6. status 字段完整 ---
s = new_session('item-C')
st = s.status()
check('status 带 id', st.get('id') == s.id)
check('status 带 mediaKey', st.get('mediaKey') == 'item-C')
check('status 带 itemId', st.get('itemId') == 'item-C')

# --- 7. 位置与字幕过滤 ---
s.set_position(100.0, True)
check('set_position 生效', s.status()['position'] == 100.0)
with s.lock:
    s.cues = [{'start': 100, 'end': 102, 'text': 'a', 'zh': 'b'},
              {'start': 200, 'end': 202, 'text': 'c', 'zh': 'd'}]
got = s.cues_between(95, 110)
check('cues_between 过滤正确', len(got) == 1 and got[0]['text'] == 'a')
cleanup(s)

# --- 8. 真跑一个会话能产出字幕 ---
# FakeRec 不用真 ffmpeg,但 cut() 仍是真调用 → 用真实本地音频文件代替 URL
import wave, tempfile
tmpwav = os.path.join(server.TMPDIR, '_test_in.wav')
if not os.path.exists(tmpwav):
    with wave.open(tmpwav, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        w.writeframes(b'\x00\x00' * 16000 * 5)   # 5 秒静音

s = server.Session(FakeRec(), tmpwav, 0, 'ja', 'm', 10, 30, token='',
                   translator=FakeTrans(), media_key='item-D', item_id='item-D')
with server.STATE['lock']:
    server.STATE['session'] = s
s.start()
s.set_position(0, True)
time.sleep(1.5)
st = s.status()
check('会话能产出字幕', st['cues'] > 0, f"cues={st['cues']}")
check('会话能推进 doneUntil', st['doneUntil'] > 0, f"done={st['doneUntil']}")

# --- 9. retire 后线程应立刻停止推进 ---
s.retire('停止测试')
done_at = s.status()['doneUntil']
time.sleep(1.5)
done_after = s.status()['doneUntil']
check('retire 后不再推进', done_after == done_at, f'{done_at} → {done_after}')
check('线程已结束', not s.thread.is_alive(), f'alive={s.thread.is_alive()}')
cleanup(s)

# --- 10. 被顶替的会话线程必须自己退出 ---
a = new_session('item-E')
a.set_position(0, True)
time.sleep(0.6)
b = new_session('item-F')
with server.STATE['lock']:
    server.STATE['session'] = b
time.sleep(1.2)
check('被顶替会话线程退出', not a.thread.is_alive(), f'alive={a.thread.is_alive()}')
cleanup(a, b)

try: os.remove(tmpwav)
except OSError: pass

print()
print(f'结果: {passed} PASS / {failed} FAIL')
sys.exit(0 if failed == 0 else 1)
