#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
实时语音字幕服务(常驻 HTTP)。

播放器调用流程:
    POST /start   {media, from, language, llm}   开始为这个媒体做字幕
    POST /position {time, playing}                播放器每 500ms 报一次播放位置
    GET  /cues?from=<t>&to=<t>                    取某个时间段的字幕
    POST /stop                                    停止并释放
    GET  /health                                  健康检查

核心策略「预取」:
    Jellyfin 的流是可寻址的,任意时间点的音频都能立刻用 ffmpeg 切出来。
    因此不等播到那里,提前把 currentTime + lookahead 之前的窗口全部算好。
    实测 10 秒窗口只需 ~3.5 秒(识别 1.5 + 翻译 2.0),远快于播放,所以永远领先。

为什么模型常驻:
    每次重新初始化 faster-whisper 要 5 秒,是最大的性能陷阱。
    模型只加载一次,之后每个窗口只要 1.5 秒。
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# ---------------------------------------------------------------- 环境准备

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(BASE, '..', '..'))
VENV = os.path.join(REPO, '.stt', 'venv')
TMPDIR = os.path.join(REPO, '.stt', 'tmp')
os.makedirs(TMPDIR, exist_ok=True)

# CUDA 运行时(ctranslate2 需要 cublas/cudnn 的 bin 在 PATH 里)
for lib in ('cublas', 'cudnn', 'cudart'):
    p = os.path.join(VENV, 'Lib', 'site-packages', 'nvidia', lib, 'bin')
    if os.path.isdir(p) and p not in os.environ.get('PATH', ''):
        os.environ['PATH'] = p + os.pathsep + os.environ.get('PATH', '')

FFMPEG = r'C:\Program Files\Jellyfin\Server\ffmpeg.exe'
DEFAULT_MODEL = (
    r'C:\AI\VideoCaptioner-0.0.0.dev535+g95842ecb5.d20260625-windows-x64'
    r'\VideoCaptioner\AppData\models\faster-whisper-large-v2'
)
OLLAMA = 'http://127.0.0.1:11434/api/generate'

SYS_PROMPT = (
    '你是专业的影视字幕翻译。把日语翻译成简体中文口语，要求：\n'
    '- 保持口语自然，符合对话语气\n'
    '- 如果原文是语气词或很短，就译成对应的中文语气词\n'
)


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)


# ============ 字幕磁盘缓存 ============
#
# 目的:同一部片重新播放时,已经算过的字幕不用再花 GPU 算一遍,
# 直接秒出。换片/重开 app 都不丢。
#
# 设计:
#   * 按 itemId 分文件(.stt/cache/<itemId>.json),同一片的所有时间点都在一个文件里
#   * 结构:{ itemId, cues: [{start,end,text,zh,logprob}], updated }
#   * 写入是"全量重写 + 原子替换"(先写 .tmp 再 os.replace),避免崩溃时留半截文件
#   * 只持久化 cues;done_until 之类的运行态不存,重开后按已缓存的 cue 覆盖范围重算
#   * 大小上限:单文件超过 CACHE_MAX_BYTES 就不再追加,避免长时间播放把盘撑爆

CACHEDIR = os.path.join(REPO, '.stt', 'cache')
CACHE_MAX_BYTES = 8 * 1024 * 1024      # 单文件 8MB 上限(约几万条字幕)


def _cache_path(item_id):
    """缓存文件路径。itemId 只允许安全字符,防止路径穿越。"""
    if not item_id:
        return None
    safe = ''.join(c for c in str(item_id) if c.isalnum() or c in '-_')
    if not safe or safe != str(item_id):
        return None                    # 有异常字符就不缓存,安全优先
    return os.path.join(CACHEDIR, f'{safe}.json')


def cache_load(item_id):
    """读缓存。返回 cues 列表(可能为空)。坏文件当没有,不抛异常。"""
    p = _cache_path(item_id)
    if not p or not os.path.isfile(p):
        return []
    try:
        with open(p, 'r', encoding='utf-8') as f:
            data = json.load(f)
        cues = data.get('cues') or []
        # 基本校验:必须是 list,每项要有 start/end/text
        out = []
        for c in cues:
            if not isinstance(c, dict):
                continue
            if 'start' not in c or 'end' not in c or 'text' not in c:
                continue
            out.append(c)
        out.sort(key=lambda c: c.get('start', 0))
        return out
    except Exception as e:
        log(f'缓存读取失败({p}): {e}')
        return []


def cache_save(item_id, cues):
    """全量写缓存(原子替换)。失败只记日志,不影响播放。"""
    p = _cache_path(item_id)
    if not p or not cues:
        return False
    try:
        os.makedirs(CACHEDIR, exist_ok=True)
        payload = {
            'itemId': item_id,
            'updated': time.strftime('%Y-%m-%d %H:%M:%S'),
            'count': len(cues),
            'cues': cues,
        }
        raw = json.dumps(payload, ensure_ascii=False)
        if len(raw.encode('utf-8')) > CACHE_MAX_BYTES:
            log(f'缓存超过上限({CACHE_MAX_BYTES} bytes),跳过写入')
            return False
        tmp = p + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(raw)
        os.replace(tmp, p)             # 原子替换,避免半截文件
        return True
    except Exception as e:
        log(f'缓存写入失败({p}): {e}')
        return False


def cache_clear(item_id=None):
    """清缓存。item_id 为空则清全部。"""
    try:
        if item_id:
            p = _cache_path(item_id)
            if p and os.path.isfile(p):
                os.remove(p)
                return True
            return False
        if os.path.isdir(CACHEDIR):
            for fn in os.listdir(CACHEDIR):
                if fn.endswith('.json') or fn.endswith('.tmp'):
                    try:
                        os.remove(os.path.join(CACHEDIR, fn))
                    except OSError:
                        pass
        return True
    except Exception as e:
        log(f'缓存清理失败: {e}')
        return False


# ---------------------------------------------------------------- 识别器

class Recognizer:
    """faster-whisper 常驻识别器。"""

    def __init__(self, model_dir, device='cuda', compute_type='float16'):
        from faster_whisper import WhisperModel
        t0 = time.time()
        self.model = WhisperModel(model_dir, device=device, compute_type=compute_type)
        self.load_s = time.time() - t0
        self.device = device
        self.warmed = False     # 预热只需一次(CUDA kernel 初始化)
        log(f'模型加载完成 {self.load_s:.2f}s device={device}')

    def warmup(self, media=None, language='ja', token=''):
        """预热 CUDA kernel,避免第一次窗口特别慢。

        关键改进:
          1. 只做一次(之前每次开启会话都重来,白等 11~18 秒)
          2. 不需要真实媒体 —— 用本地生成的 3 秒静音就够初始化 CUDA kernel,
             所以可以在 --preload 阶段(用户还没开始播)就完成,
             用户点开关时是"立刻就绪"而不是"等预热"。
        """
        if self.warmed:
            log('已预热过,跳过')
            return
        t0 = time.time()
        wav = os.path.join(TMPDIR, '_warmup.wav')
        try:
            # 用 8 秒噪声:覆盖更完整的解码路径,避免首个真实窗口慢到十几秒
            self._make_silence(wav, seconds=8.0)
        except Exception as e:
            log(f'生成测试音频失败({e}),改试传入媒体')
            if not media:
                log('无可用音频,跳过预热')
                return
            cut(media, wav, 0, 5, token=token)
        try:
            # 预热跑两次:第一次编译 kernel,第二次确认稳态
            for i in range(2):
                list(self.model.transcribe(wav, language=language,
                                           beam_size=1, vad_filter=False)[0])
            self.warmed = True
            log(f'预热完成 {time.time()-t0:.2f}s')
        except Exception as e:
            log(f'预热失败: {e}')
        finally:
            try:
                os.remove(wav)
            except OSError:
                pass

    @staticmethod
    def _make_silence(path, seconds=3.0, rate=16000):
        """生成一段 16k 单声道"类语音"测试音频。

        注意:纯静音会让 Whisper 走 VAD/短路径,可能跳过大段解码,
        导致第一次遇到真实语音时还要现编译 kernel(实测出现过 12 秒慢窗口)。
        所以这里喂一点低幅噪声,让它把完整的 encode+decode 路径都走一遍。
        """
        import wave as _wave
        import random
        n = int(seconds * rate)
        frames = bytearray()
        for _ in range(n):
            # 低幅噪声,峰值约满量程的 3%,够触发解码又不刺耳
            v = int(random.gauss(0, 300))
            v = max(-2000, min(2000, v))
            frames += int(v).to_bytes(2, 'little', signed=True)
        with _wave.open(path, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(frames))

    def transcribe(self, wav, language, offset=0.0):
        t0 = time.time()
        segs, _ = self.model.transcribe(
            wav, language=language, beam_size=1, vad_filter=False,
            condition_on_previous_text=False, word_timestamps=False)

        cues = []
        dropped = 0
        seen = {}          # 同一窗口内文本出现次数(循环幻觉检测)

        for s in segs:
            text = s.text.strip()
            if not text:
                continue

            logprob = getattr(s, 'avg_logprob', 0.0)
            no_speech = getattr(s, 'no_speech_prob', 0.0)

            # 重复计数:同一窗口里反复出同一句 = 循环幻觉
            key = text.strip()
            repeat = seen.get(key, 0)
            seen[key] = repeat + 1

            # 过滤判据全部在 is_hallucination 里,阈值来自 FILTER(可配置)
            if is_hallucination(text, logprob, no_speech, repeat):
                dropped += 1
                log(f'  [过滤] lp={logprob:.2f} ns={no_speech:.2f} '
                    f'rep={repeat} "{text[:30]}"')
                continue

            cues.append({'start': round(s.start + offset, 2),
                         'end': round(s.end + offset, 2),
                         'text': text,
                         'logprob': round(logprob, 3)})

        return cues, time.time() - t0, dropped


def cut(media, dst, start, dur, token=''):
    """用 ffmpeg 切一段 16k 单声道 wav。

    支持本地文件和 HTTP 流。-ss 放在 -i 之前是关键:
    对 HTTP 流,ffmpeg 会利用 Range 请求跳到该位置,不必从头下载。
    实测跳转 1 小时处的音频只需 0.04 秒。

    注意:Jellyfin 12.1 不接受 URL 里的 api_key 参数(返回 400),
    token 必须走 Authorization 请求头。
    """
    cmd = [FFMPEG, '-ss', str(start), '-t', str(dur)]
    if token and is_url(media):
        # ffmpeg 的 -headers 选项:把 Authorization 带进 HTTP 请求
        cmd += ['-headers', f'Authorization: MediaBrowser Token="{token}"\r\n']
    cmd += ['-i', media,
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', dst,
            '-loglevel', 'error']
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        err = (r.stderr or '').strip().splitlines()
        raise RuntimeError('ffmpeg 失败: ' + ' | '.join(err[-3:]))


# ============ 幻觉过滤(可配置) ============
#
# Whisper 在弱语音/静音段的典型幻觉:这些短语在训练数据里大量出现于
# 片尾字幕,模型听到模糊音频就会"脑补"出来,和实际内容无关。
# 全部参数都可由 config.json 覆盖,下面只是发布默认值。

# 发布的默认配置。想调就改 config.json,不用改代码。
FILTER_DEFAULTS = {
    # 基础开关
    'enabled': True,

    # 判据 1:命中幻觉词表 + 置信度低于该值 → 丢弃
    #   实测正常对话 avg_logprob ≈ -0.25~-0.55,幻觉 ≈ -0.9~-1.0
    'phraseLogprob': -0.35,

    # 判据 2:置信度低于该值 → 丢弃(极端模糊)
    #   实测真实台词很少低于 -1.0,重复碎片常到 -1.18
    'minLogprob': -1.05,

    # 判据 3:no_speech 高于该值 且 置信度低于 speechNoSpeechLogprob → 丢弃
    'maxNoSpeech': 0.60,
    'speechNoSpeechLogprob': -0.35,

    # 判据 4:同一窗口内同一句重复 >= 该次数 → 视为循环幻觉
    'maxRepeat': 2,
}

# 默认幻觉词表(片尾语/订阅引导/道别)
FILTER_PHRASES_DEFAULT = [
    'ご視聴ありがとうございました',
    'ご視聴ありがとうございます',
    '本日はご覧いただきありがとう',
    '最後までご視聴いただき',
    'チャンネル登録',
    '高評価',
    '次回予告',
    'お疲れ様でした',
    'おつかれさまでした',
    'おやすみなさい',
    '字幕は自動生成',
    '字幕by',
    'Amara.org',
    'Subscribe',
]

# 这些符号出现在真实台词里时,说明有说话人标记/强调,不该当幻觉丢
FILTER_MARKERS_DEFAULT = ['★', '☆', '「', '『', '♪']

# 运行时生效的配置(由 /start 的 filter 参数覆盖)
FILTER = dict(FILTER_DEFAULTS)
FILTER['phrases'] = list(FILTER_PHRASES_DEFAULT)
FILTER['markers'] = list(FILTER_MARKERS_DEFAULT)


def apply_filter_config(cfg):
    """用客户端传来的配置覆盖过滤参数。

    cfg 为 None/空时**重置为默认**(而不是沿用上次的值)。
    这一点很重要:否则用户关掉过滤后再重开会话,过滤仍然是关的,
    而 config.json 里写的是开启 —— 会让人以为配置没生效。

    只认 FILTER_DEFAULTS 里声明的键 + phrases/markers;
    空值/非法值一律保留默认,不会把过滤搞坏。
    """
    global FILTER
    newf = dict(FILTER_DEFAULTS)
    newf['phrases'] = list(FILTER_PHRASES_DEFAULT)
    newf['markers'] = list(FILTER_MARKERS_DEFAULT)

    if not isinstance(cfg, dict):
        FILTER = newf
        log(f'过滤配置(默认): enabled={FILTER["enabled"]} '
            f'phraseLp={FILTER["phraseLogprob"]} minLp={FILTER["minLogprob"]} '
            f'noSpeech={FILTER["maxNoSpeech"]} 词表{len(FILTER["phrases"])}条')
        return

    for k, dv in FILTER_DEFAULTS.items():
        if k not in cfg or cfg[k] is None:
            continue
        v = cfg[k]
        if isinstance(dv, bool):
            newf[k] = bool(v)
        elif isinstance(dv, (int, float)):
            try:
                newf[k] = float(v)
            except (TypeError, ValueError):
                pass
    if isinstance(cfg.get('phrases'), list) and cfg['phrases']:
        newf['phrases'] = [str(x) for x in cfg['phrases'] if str(x).strip()]
    if isinstance(cfg.get('markers'), list):
        newf['markers'] = [str(x) for x in cfg['markers'] if str(x)]
    FILTER = newf
    log(f'过滤配置: enabled={FILTER["enabled"]} '
        f'phraseLp={FILTER["phraseLogprob"]} minLp={FILTER["minLogprob"]} '
        f'noSpeech={FILTER["maxNoSpeech"]} 词表{len(FILTER["phrases"])}条')


def is_hallucination(text, logprob, no_speech=0.0, repeat_count=0):
    """判断一条识别结果是否是幻觉。

    多条判据按顺序短路,任一命中即丢弃:
      1. 空文本
      2. 带说话人标记(★「」『』♪) → 当作真实内容,直接保留
      3. 同一窗口内重复过多 → 循环幻觉
      4. 命中幻觉词表且置信度不高
      5. 置信度极低
      6. 静音概率很高且置信度不高
    """
    if not FILTER['enabled']:
        return False

    t = (text or '').strip()
    if not t:
        return True

    # 有说话人标记/引号/音乐符号 → 真实内容,不丢
    if any(m in t for m in FILTER['markers']):
        return False

    # 同一窗口疯狂重复 → 循环幻觉(实测 "大きな声がする" 连出 3 次)
    if repeat_count >= FILTER['maxRepeat']:
        return True

    # 命中幻觉词表 + 置信度不高
    if any(p in t for p in FILTER['phrases']):
        if logprob < FILTER['phraseLogprob']:
            return True

    # 置信度极低
    if logprob < FILTER['minLogprob']:
        return True

    # 静音概率很高且置信度不高
    if no_speech > FILTER['maxNoSpeech'] and logprob < FILTER['speechNoSpeechLogprob']:
        return True

    return False

    return False
#
# 支持多种后端,用 config 的 sttTranslator 切换,改配置即可、不用改代码:
#   ollama   本地 Ollama(默认,免费/离线/无限速)
#   deepl    DeepL API(质量好,需 key,按量计费)
#   openai   OpenAI 兼容接口(可指向任何兼容服务:通义/智谱/本地 vLLM 等)
#   none     不翻译,只显示原文(调试用)
#
# 每个后端只需实现: batch(texts) -> (list[str], seconds)


def _parse_numbered(raw, texts):
    """把「编号. 译文」格式的模型输出解析回列表;解析失败的条目退回原文。"""
    out = [''] * len(texts)
    for line in str(raw).splitlines():
        m = re.match(r'^\s*(\d+)\s*[.、,:：)]\s*(.+)$', line)
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(out):
                out[idx] = m.group(2).strip().strip('"').strip('「」')
    for i, v in enumerate(out):
        if not v:
            out[i] = texts[i]
    return out


class OllamaTranslator:
    """本地 Ollama。实测 qwen3.5:9b 每窗口约 1.6s。"""

    name = 'ollama'

    def __init__(self, model='qwen3.5:9b', url=OLLAMA, timeout=120):
        self.model = model
        self.url = url
        self.timeout = timeout

    def batch(self, texts):
        if not texts:
            return [], 0.0
        numbered = '\n'.join(f'{i+1}. {t}' for i, t in enumerate(texts))
        prompt = (
            f'{SYS_PROMPT}\n'
            f'下面是按编号排列的{tgt_name()}字幕，逐条翻译成简体中文。\n'
            '严格按相同编号输出，每条一行，格式为「编号. 译文」，不要合并、不要遗漏。\n\n'
            f'{numbered}\n'
        )
        body = json.dumps({
            'model': self.model, 'prompt': prompt, 'stream': False, 'think': False,
            'options': {'num_predict': 500, 'temperature': 0.2},
        }).encode('utf-8')
        req = urllib.request.Request(self.url, data=body,
                                     headers={'Content-Type': 'application/json'})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        el = time.time() - t0
        return _parse_numbered(data.get('response') or '', texts), el


class OpenAICompatTranslator:
    """OpenAI 兼容的 /chat/completions 接口。

    可指向任何兼容服务:OpenAI、通义(DashScope 兼容模式)、智谱、
    本地 vLLM / LM Studio / llama.cpp server 等。
    """

    name = 'openai'

    def __init__(self, base_url='', api_key='', model='gpt-4o-mini', timeout=120):
        self.base_url = (base_url or 'https://api.openai.com/v1').rstrip('/')
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def batch(self, texts):
        if not texts:
            return [], 0.0
        numbered = '\n'.join(f'{i+1}. {t}' for i, t in enumerate(texts))
        prompt = (
            f'{SYS_PROMPT}\n'
            f'下面是按编号排列的{tgt_name()}字幕，逐条翻译成简体中文。\n'
            '严格按相同编号输出，每条一行，格式为「编号. 译文」，不要合并、不要遗漏。\n\n'
            f'{numbered}\n'
        )
        body = json.dumps({
            'model': self.model,
            'messages': [{'role': 'user', 'content': prompt}],
            'temperature': 0.2,
            'max_tokens': 500,
        }).encode('utf-8')
        req = urllib.request.Request(
            f'{self.base_url}/chat/completions', data=body,
            headers={'Content-Type': 'application/json',
                     'Authorization': f'Bearer {self.api_key}'})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        el = time.time() - t0
        raw = ''
        try:
            raw = data['choices'][0]['message']['content']
        except (KeyError, IndexError):
            pass
        return _parse_numbered(raw, texts), el


class DeepLTranslator:
    """DeepL。注意 DeepL 免费版每月 50 万字符,超出要付费。

    批量翻译用数组形式,一次请求翻多条。
    """

    name = 'deepl'

    def __init__(self, api_key='', free=False,
                 target='ZH-HANS', source='JA', timeout=120):
        self.api_key = api_key
        self.target = target
        self.source = source
        self.timeout = timeout
        self.url = ('https://api-free.deepl.com/v2/translate' if free
                    else 'https://api.deepl.com/v2/translate')

    def batch(self, texts):
        if not texts:
            return [], 0.0
        if not self.api_key:
            raise RuntimeError('DeepL 需要 api_key')
        # 用 urlencode 展开数组: text=A&text=B
        import urllib.parse
        params = [('target_lang', self.target), ('source_lang', self.source)]
        params += [('text', t) for t in texts]
        body = urllib.parse.urlencode(params).encode('utf-8')
        req = urllib.request.Request(
            self.url, data=body,
            headers={'Content-Type': 'application/x-www-form-urlencoded',
                     'Authorization': f'DeepL-Auth-Key {self.api_key}'})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            data = json.loads(r.read().decode('utf-8'))
        el = time.time() - t0
        got = [x.get('text', '') for x in (data.get('translations') or [])]
        out = [got[i] if i < len(got) and got[i] else texts[i]
               for i in range(len(texts))]
        return out, el


class NullTranslator:
    """不翻译:译文位置放原文。用于只看识别结果的调试场景。"""

    name = 'none'

    def batch(self, texts):
        return list(texts), 0.0


def tgt_name():
    """目标/源语言的中文名,给 prompt 用。"""
    return '日语'


def make_translator(cfg):
    """按配置造翻译后端。

    注意:设置面板里留空的字段会以空字符串传来,不能当作"已配置"。
    任何一项出问题都回退到本地 ollama,避免整条字幕链路挂掉。
    """
    def pick(key, default=''):
        v = cfg.get(key)
        if v is None:
            return default
        v = str(v).strip()
        return v if v else default

    kind = pick('translator') or pick('sttTranslator') or 'ollama'
    kind = kind.lower()
    # 空字符串/未知值一律当 ollama
    if kind not in ('ollama', 'deepl', 'openai', 'none'):
        log(f'未知翻译后端 "{kind}",回退 ollama')
        kind = 'ollama'

    try:
        if kind == 'none':
            log('翻译后端: none(只显示原文)')
            return NullTranslator()

        if kind == 'deepl':
            key = pick('deeplApiKey')
            if not key:
                log('DeepL 缺少 apiKey,回退 ollama')
                return OllamaTranslator(model=pick('llm', 'qwen3.5:9b'),
                                        url=pick('ollamaUrl', OLLAMA))
            t = DeepLTranslator(
                api_key=key,
                free=bool(cfg.get('deeplFree', True)),
                target=pick('deeplTargetLang', 'ZH-HANS'),
                source=pick('deeplSourceLang', 'JA'))
            log('翻译后端: deepl')
            return t

        if kind == 'openai':
            key = pick('openaiApiKey')
            base = pick('openaiBaseUrl')
            model = pick('openaiModel', 'gpt-4o-mini')
            if not base:
                log('OpenAI 兼容模式缺少 baseUrl,回退 ollama')
                return OllamaTranslator(model=pick('llm', 'qwen3.5:9b'),
                                        url=pick('ollamaUrl', OLLAMA))
            t = OpenAICompatTranslator(base_url=base, api_key=key, model=model)
            log(f'翻译后端: openai 兼容 {t.base_url} / {t.model}')
            return t

        # 默认 ollama
        model = pick('llm', 'qwen3.5:9b')
        url = pick('ollamaUrl', OLLAMA)
        t = OllamaTranslator(model=model, url=url)
        log(f'翻译后端: ollama {model} @ {url}')
        return t
    except Exception as e:
        log(f'翻译后端 {kind} 初始化失败({e}),回退 ollama')
        return OllamaTranslator(model=pick('llm', 'qwen3.5:9b'),
                                url=pick('ollamaUrl', OLLAMA))


def translate_batch(texts, model, timeout=120):
    """兼容旧签名(单次调用即建 Ollama 后端)。新代码请用 translator.batch()。"""
    return OllamaTranslator(model=model, timeout=timeout).batch(texts)


def media_duration(media):
    """取媒体总时长(秒)。支持本地文件和 HTTP 流。"""
    try:
        r = subprocess.run(
            [r'C:\Program Files\Jellyfin\Server\ffprobe.exe',
             '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', media],
            capture_output=True, text=True, timeout=60)
        return float(r.stdout.strip())
    except Exception as e:
        log('取时长失败:', e)
        return 0.0


def is_url(s):
    return s.startswith('http://') or s.startswith('https://')


# ---------------------------------------------------------------- 会话

class Session:
    """一次播放会话:按需预取窗口并缓存字幕。

    设计要点(整体思路):
      * 每个会话有唯一 id 和明确绑定的 media(流地址 + itemId)。
      * 后台线程每一步都调用 _alive() 校验"我还是不是当前会话、我的 media 有没有变"。
        一旦不是,立即退出,绝不在旧片上继续消耗 GPU。
      * 客户端每次上报位置都带 mediaKey,服务端据此判断是否需要换会话。
        —— 身份判断只有一处(mediaKey),不在客户端和服务端各推一次。
      * 同一媒体重复 /start 时,若参数没变则复用现有会话,不重建、不重算。
    """

    _seq = 0

    def __init__(self, rec, media, start_from, language, llm, window, lookahead,
                 token='', translator=None, media_key='', item_id=''):
        Session._seq += 1
        self.id = f's{Session._seq}-{int(time.time() * 1000) % 100000}'
        self.rec = rec
        self.media = media
        self.media_key = media_key or media   # 身份标识:优先用调用方给的 key
        self.item_id = item_id
        self.language = language
        self.llm = llm
        self.window = window
        self.lookahead = lookahead
        self.token = token
        self.translator = translator or OllamaTranslator(model=llm)
        self.duration = media_duration(media)

        self.lock = threading.Lock()
        self.cues = []                 # 已生成的字幕,按 start 排序
        self.done_until = start_from   # 已处理到的时间点
        self.position = start_from     # 播放器当前位置
        self.playing = True
        self.started_at = time.time()
        self.stop_flag = False
        self.retired = False           # 被替换/停止后置真,线程据此立刻退出
        self.errors = 0
        self._last_pos = start_from    # 上一次的位置(用于识别"突然变 0"的噪声)
        self._reset_seen = False       # 是否已见过一次"贴近 0"的疑似噪声
        # 空闲回补:只补当前位置往前一小段(默认 60s),利用预取空闲时间做。
        # 别设太大 —— 实测补 2940s 要 5 分钟,用户早走了。
        self.backfill_range = 60.0
        self._backfilled = set()       # 已回补过的窗口起点

        # ---- 磁盘缓存:同片重看时秒出,不用再算 ----
        self.use_cache = os.environ.get('JFP_STT_CACHE', '1') != '0'
        if self.use_cache and self.item_id:
            cached = cache_load(self.item_id)
            if cached:
                self.cues = cached
                self.cached_count = len(cached)
                # 关键:续算点要从**当前播放位置**往后找"连续覆盖到哪",
                # 不能简单地用 max(start_from, 缓存末尾)。
                # 否则:缓存只算过 1787s 附近、实际从 0 开始播时,
                # done_until 直接被拉到 1787,片头 0~1786 永远算不到(实测就是这么丢的)。
                self.done_until = self._contiguous_end_from(start_from, cached)
                log(f'[{self.id}] 命中缓存 {len(cached)} 条字幕,'
                    f'从 {self.done_until:.0f}s 继续(请求起点 {start_from:.0f}s)')
            else:
                self.cached_count = 0
        else:
            self.cached_count = 0

        # 缓存写入节流(避免每个窗口都重写整个文件)
        self._cache_dirty = False
        self._cache_last_save = 0.0
        self._cache_save_interval = 5.0
        self.stats = {'windows': 0, 'asr_s': 0.0, 'mt_s': 0.0, 'lead_s': []}
        # 注意:线程不在 __init__ 里启动 —— 创建会话时它还不是 STATE['session'],
        # 立刻启动会误判"我不是当前会话"而直接退休。由调用方登记后再 start()。
        self.thread = threading.Thread(target=self._loop, daemon=True, name=f'sess-{self.id}')
        log(f'会话 {self.id} 建立 media={self.media_key[:60]} from={start_from:.0f}s')

    def start(self):
        """登记到 STATE 之后再启动线程。"""
        self.thread.start()

    # -- 生命周期 -------------------------------------------------

    def retire(self, reason=''):
        """标记退休:后台线程会在下一个检查点立刻退出。"""
        self.retired = True
        self.stop_flag = True
        if reason:
            log(f'会话 {self.id} 退休: {reason}')
        # 退出前把没落盘的缓存补上,避免丢掉最后一小段
        if getattr(self, 'use_cache', False) and getattr(self, '_cache_dirty', False):
            try:
                with self.lock:
                    snapshot = list(self.cues)
                    self._cache_dirty = False
                if cache_save(self.item_id, snapshot):
                    log(f'[{self.id}] 退出前已保存缓存 {len(snapshot)} 条')
            except Exception as e:
                log(f'[{self.id}] 退出前保存缓存失败: {e}')

    def _alive(self):
        """当前线程是否还应继续工作。

        三重校验,任一不满足就退出:
          1. 没被 retire/stop
          2. 仍是服务端登记的当前会话(防止被新会话顶替后还活着)
          3. 绑定媒体没被改
        """
        if self.retired or self.stop_flag:
            return False
        with STATE['lock']:
            if STATE['session'] is not self:
                self.retired = True
                return False
        return True

    # -- 对外接口 -------------------------------------------------

    def set_position(self, t, playing=True):
        with self.lock:
            self.position = t
            self.playing = playing

    def cues_between(self, lo, hi):
        with self.lock:
            return [c for c in self.cues if c['end'] >= lo and c['start'] <= hi]

    def status(self):
        with self.lock:
            lead = (self.done_until - self.position) if self.position else 0
            return {
                'id': self.id,
                'active': not (self.retired or self.stop_flag),
                'mediaKey': self.media_key[:80],
                'itemId': self.item_id,
                'cues': len(self.cues),
                'position': round(self.position, 1),
                'doneUntil': round(self.done_until, 1),
                'leadSeconds': round(lead, 1),
                'duration': round(self.duration, 1),
                'windows': self.stats['windows'],
                'cacheHit': getattr(self, 'cached_count', 0),   # 启动时命中的缓存条数
                'avgAsr': round(self.stats['asr_s'] / max(1, self.stats['windows']), 2),
                'avgMt': round(self.stats['mt_s'] / max(1, self.stats['windows']), 2),
                'errors': self.errors,
            }

    def _contiguous_end_from(self, start_from, cached):
        """从 start_from 往后,缓存连续覆盖到哪一秒。

        只认"从起点起没有被空洞断开"的区间。比如缓存覆盖
        0~100 和 1780~1800,而现在从 0 开始播 → 返回 100,
        不会因为后面有 1780 的缓存就跳到 1780。

        判定用 window 的一半作为允许的缝隙(相邻窗口本来就可能有小间隙)。
        """
        tol = max(2.0, self.window * 0.5)
        # 只取起点之后的条目
        segs = sorted(
            ((c.get('start', 0), c.get('end', 0)) for c in cached
             if c.get('end', 0) >= start_from - tol),
            key=lambda x: x[0])
        if not segs:
            return start_from

        end = start_from
        for s, e in segs:
            if s > end + tol:
                break          # 出现空洞,到此为止
            end = max(end, e)
        return end

    def _next_backfill(self, pos):
        """空闲时该回补哪个窗口。返回 (off, dur) 或 None。

        只在"当前位置往前 backfill_range 秒"这个范围内找没被覆盖的窗口。
        范围刻意开得小(默认 60s):实测把整个片头(2940s)都补要 5 分钟,
        用户早就走了。补一小段的意义是"往前拖一点也有字幕",不是补全片。

        已试过的窗口一律记入 _backfilled,不管算出来几句 ——
        否则会无限循环:窗口没被 cue 完整覆盖 → 又选它 → 又只算出几句
        → 永远不满足"已覆盖" → 死循环把 GPU 打爆(实测踩过)。
        """
        rng = self.backfill_range
        if pos <= self.window or rng <= 0:
            return None

        lo = max(0.0, pos - rng)
        with self.lock:
            spans = sorted(((c.get('start', 0), c.get('end', 0)) for c in self.cues),
                           key=lambda x: x[0])

        tol = self.window * 0.5
        off = (lo // self.window) * self.window
        scanned = 0
        while off + self.window <= pos + tol and scanned < 40:
            scanned += 1
            if off in self._backfilled:
                off += self.window
                continue
            covered = any(s <= off + tol and e >= off + self.window - tol
                          for s, e in spans)
            if not covered:
                return (off, min(self.window, pos - off))
            off += self.window
        return None

    def stop(self):
        self.retire('stop')

    # -- 后台预取 -------------------------------------------------

    def _loop(self):
        wav = os.path.join(TMPDIR, f'sess_{id(self)}.wav')
        while self._alive():
            with self.lock:
                pos = self.position
                playing = self.playing
                done = self.done_until

            # 播放暂停时不做无用功
            if not playing:
                time.sleep(0.4)
                continue

            # ---------- 1) 先判跳转,再决定要不要休息 ----------
            # 顺序很关键:如果先判"done >= target 就休息",那么用户往回拖时
            # done(很远) 永远 >= target(很小),循环会一直休息,跳转永远检测不到。
            # 实测就是靠这个顺序 bug 导致"往回跳后字幕一直不出来"。
            back_tol = self.lookahead * 0.5              # 允许落后
            fwd_tol = self.lookahead + self.window * 2   # 允许领先

            # 特例:播放器销毁/换片瞬间 currentTime 会瞬间变 0,
            # 那不是用户跳转。若刚才还在远处、现在突然贴近 0,
            # 先当作噪声忽略一次;连续两次都贴近 0 才认。
            suspicious_reset = (pos < 3.0 and self._last_pos > 30.0 and done > 30.0)
            if suspicious_reset:
                if self._reset_seen:
                    log(f'[{self.id}] 连续两次位置贴近 0,认可为跳转')
                    self._reset_seen = False
                else:
                    self._reset_seen = True
                    log(f'[{self.id}] 位置突然贴近 0(疑似播放器销毁),先忽略一次')
                    self._last_pos = pos
                    time.sleep(0.3)
                    continue
            else:
                self._reset_seen = False
            self._last_pos = pos

            if done < pos - back_tol or done > pos + fwd_tol:
                jumped = done < pos - back_tol
                # 对齐到窗口边界,保证覆盖当前位置且不漏片段
                align = max(0.0, (pos // self.window) * self.window)
                with self.lock:
                    self.done_until = align
                reason = '向前跳转' if jumped else '向后跳转'
                log(f'[{self.id}] 检测到{reason} pos={pos:.0f}s done={done:.0f}s '
                    f'→ 对齐到 {align:.0f}s')
                continue

            # ---------- 2) 决定这一轮算哪个窗口 ----------
            # 优先级:① 追进度(done 落后于 pos) ② 空闲时回补前面一小段
            target = pos + self.lookahead
            if self.duration:
                target = min(target, self.duration)

            off = None
            dur = 0.0

            if done < pos:
                # 落后于当前位置:先追进度,别做别的
                off = done
                dur = min(self.window, (self.duration or 1e9) - off)
            elif done >= target:
                # 已经领先够多 → 空闲,利用这段时间回补"当前位置往前一小段"
                # 关键:回补只吃空闲时间,绝不占用正常预取,
                # 否则会重现"续播要补 5 分钟、用户早走了一帧没有"的问题。
                bf = self._next_backfill(pos)
                if bf is None:
                    time.sleep(0.3)
                    continue
                off, dur = bf
                log(f'[{self.id}] 空闲回补 t={off:.0f}s {dur:.0f}s')
            else:
                # 领先量还不够,继续正常往后预取
                off = done
                dur = min(self.window, (self.duration or 1e9) - off)

            if off is None or dur < 1.0:
                time.sleep(0.5)
                continue

            try:
                t0 = time.time()
                cut(self.media, wav, off, dur, token=self.token)
                cut_s = time.time() - t0

                # 每个耗时步骤后都校验一次:已退休/已被顶替/媒体变了 → 立刻退出,
                # 不在旧片上继续烧 GPU。
                if not self._alive():
                    break

                cues, asr_s, dropped = self.rec.transcribe(wav, self.language, offset=off)

                if not self._alive():
                    break

                t0 = time.time()
                if cues:
                    zh, _ = self.translator.batch([c['text'] for c in cues])
                    for c, z in zip(cues, zh):
                        c['zh'] = z
                mt_s = time.time() - t0

                if not self._alive():
                    break

                with self.lock:
                    self.cues.extend(cues)
                    self.cues.sort(key=lambda c: c['start'])
                    # 重要:回补窗口不能把 done_until 往回拉,否则正常预取的
                    # 进度会被破坏(下一次又从头算,无限循环)。
                    if off + dur > self.done_until:
                        self.done_until = off + dur
                    # 不管这个窗口算出几句,都记下"已试过",绝不再选它。
                    # 否则:窗口没被完整覆盖 → 又选它 → 又只算出几句 → 死循环。
                    if off < pos - self.window:
                        self._backfilled.add(off)
                    self.stats['windows'] += 1
                    self.stats['asr_s'] += asr_s
                    self.stats['mt_s'] += mt_s
                    self.stats['dropped'] = self.stats.get('dropped', 0) + dropped
                    lead = self.done_until - pos
                    self.stats['lead_s'].append(lead)
                    self._cache_dirty = True

                # 节流写缓存:每 _cache_save_interval 秒落一次盘,
                # 避免每个窗口都重写整个 JSON(字幕多时开销不小)。
                now = time.time()
                if (self.use_cache and self._cache_dirty
                        and now - self._cache_last_save >= self._cache_save_interval):
                    with self.lock:
                        snapshot = list(self.cues)
                        self._cache_dirty = False
                        self._cache_last_save = now
                    cache_save(self.item_id, snapshot)

                filt = f' 过滤{dropped}' if dropped else ''
                log(f'[{self.id}] 窗口 t={off:.0f}s {dur:.0f}s | 切{cut_s:.2f} '
                    f'识别{asr_s:.2f} 翻译{mt_s:.2f} | 领先{lead:.1f}s | '
                    f'{len(cues)}句{filt}')

            except Exception as e:
                self.errors += 1
                log(f'窗口 t={off:.0f}s 失败: {e}')
                log(traceback.format_exc(limit=2))
                time.sleep(1.0)
                # 失败也推进,避免死循环卡在同一窗口
                with self.lock:
                    self.done_until = off + dur

        try:
            os.remove(wav)
        except OSError:
            pass


# ---------------------------------------------------------------- HTTP

STATE = {'rec': None, 'session': None, 'lock': threading.Lock()}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode('utf-8'))

    # -------------------------------------------------- GET

    def do_GET(self):
        if self.path.startswith('/health'):
            rec = STATE['rec']
            self._json({'ok': True, 'modelLoaded': rec is not None,
                        'device': rec.device if rec else None,
                        'loadSeconds': round(rec.load_s, 2) if rec else None})
            return

        if self.path.startswith('/cues'):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            lo = float(q.get('from', ['0'])[0])
            hi = float(q.get('to', ['1e9'])[0])
            s = STATE['session']
            if not s:
                self._json({'cues': [], 'status': None})
                return
            self._json({'cues': s.cues_between(lo, hi), 'status': s.status()})
            return

        if self.path.startswith('/status'):
            s = STATE['session']
            self._json(s.status() if s else {'active': False})
            return

        self._json({'error': 'not found'}, 404)

    # -------------------------------------------------- POST

    def do_POST(self):
        try:
            data = self._body()

            if self.path.startswith('/start'):
                media = data.get('media') or ''
                # 身份标识:客户端传 itemId,没有就用流地址本身
                media_key = (data.get('itemId') or '').strip() or media

                if not is_url(media) and not os.path.isfile(media):
                    self._json({'error': f'媒体不存在: {media}'}, 400)
                    return

                with STATE['lock']:
                    cur = STATE['session']

                    # 幂等:同一个媒体、同一套参数 → 复用现有会话,不重建
                    if cur and not cur.retired and cur.media_key == media_key:
                        # 只更新播放位置,让预取对准当前位置
                        cur.set_position(float(data.get('from', cur.position)), True)
                        log(f'会话 {cur.id} 已存在且媒体一致,复用(不重建)')
                        self._json({'ok': True, 'reused': True, 'status': cur.status()})
                        return

                    # 换媒体:旧会话必须立刻退休(它会在线程下一检查点退出)
                    if cur:
                        cur.retire(f'被新媒体顶替 {media_key[:40]}')
                        STATE['session'] = None

                    if STATE['rec'] is None:
                        STATE['rec'] = Recognizer(
                            data.get('model') or DEFAULT_MODEL,
                            data.get('device', 'cuda'),
                            data.get('computeType', 'float16'))

                    # 幻觉过滤配置:每次 /start 都可覆盖(改配置后重开会话即生效)
                    apply_filter_config(data.get('filter'))

                    # 缓存开关:客户端传 false 就本次不读不写
                    if data.get('cache') is False:
                        os.environ['JFP_STT_CACHE'] = '0'
                    else:
                        os.environ.pop('JFP_STT_CACHE', None)

                    rec = STATE['rec']
                    token = data.get('token', '')
                    if not data.get('skipWarmup'):
                        rec.warmup(media, data.get('language', 'ja'), token=token)

                    s = Session(
                        rec, media,
                        float(data.get('from', 0)),
                        data.get('language', 'ja'),
                        data.get('llm', 'qwen3.5:9b'),
                        float(data.get('window', 10)),
                        float(data.get('lookahead', 60)),
                        token=token,
                        translator=make_translator(data),
                        media_key=media_key,
                        item_id=(data.get('itemId') or ''))
                    # 空闲回补范围(0 = 关闭),由客户端配置
                    if data.get('backfillRange') is not None:
                        try:
                            s.backfill_range = max(0.0, float(data['backfillRange']))
                        except (TypeError, ValueError):
                            pass
                    # 先登记再启动:线程启动后第一件事就是校验自己是不是当前会话
                    STATE['session'] = s
                    s.start()
                    self._json({'ok': True, 'reused': False, 'status': s.status()})
                return

            if self.path.startswith('/position'):
                s = STATE['session']
                if not s or s.retired:
                    self._json({'ok': False, 'error': 'no session', 'needRestart': True})
                    return

                # 客户端上报了 mediaKey 且与服务端不一致 → 明确告诉它要换片
                key = (data.get('mediaKey') or '').strip()
                if key and key != s.media_key:
                    log(f'位置上报的 mediaKey 变化 {s.media_key[:30]} → {key[:30]}')
                    self._json({'ok': False, 'needRestart': True,
                                'error': 'media changed', 'status': s.status()})
                    return

                s.set_position(float(data.get('time', 0)),
                               bool(data.get('playing', True)))
                self._json({'ok': True, 'status': s.status()})
                return

            if self.path.startswith('/stop'):
                with STATE['lock']:
                    if STATE['session']:
                        STATE['session'].retire('客户端请求停止')
                        STATE['session'] = None
                log('会话已停止')
                self._json({'ok': True})
                return

            # ---------- 缓存管理 ----------
            if self.path.startswith('/cache/clear'):
                item = (data.get('itemId') or '').strip()
                ok = cache_clear(item or None)
                log(f'缓存清理: {"全部" if not item else item} → {ok}')
                self._json({'ok': ok, 'itemId': item or None})
                return

            if self.path.startswith('/cache/info'):
                item = (data.get('itemId') or '').strip()
                if not item:
                    # 列全部缓存文件的摘要
                    items = []
                    try:
                        if os.path.isdir(CACHEDIR):
                            for fn in sorted(os.listdir(CACHEDIR)):
                                if not fn.endswith('.json'):
                                    continue
                                fp = os.path.join(CACHEDIR, fn)
                                try:
                                    with open(fp, 'r', encoding='utf-8') as f:
                                        d = json.load(f)
                                    items.append({
                                        'itemId': d.get('itemId', fn[:-5]),
                                        'count': d.get('count', len(d.get('cues') or [])),
                                        'updated': d.get('updated'),
                                        'bytes': os.path.getsize(fp),
                                    })
                                except Exception:
                                    pass
                    except Exception:
                        pass
                    self._json({'ok': True, 'items': items, 'dir': CACHEDIR})
                    return
                p = _cache_path(item)
                if p and os.path.isfile(p):
                    try:
                        with open(p, 'r', encoding='utf-8') as f:
                            d = json.load(f)
                        self._json({'ok': True, 'itemId': item,
                                    'count': d.get('count', 0),
                                    'updated': d.get('updated'),
                                    'bytes': os.path.getsize(p)})
                    except Exception as e:
                        self._json({'ok': False, 'error': str(e)})
                else:
                    self._json({'ok': True, 'itemId': item, 'count': 0})
                return

            self._json({'error': 'not found'}, 404)

        except Exception as e:
            log('请求失败:', e)
            log(traceback.format_exc(limit=3))
            self._json({'error': str(e)}, 500)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--preload', action='store_true', help='启动即加载模型')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--compute-type', default='float16')
    args = ap.parse_args()

    if args.preload:
        STATE['rec'] = Recognizer(args.model, args.device, args.compute_type)
        # 模型加载后立即预热(用静音),用户点开关时就不用再等
        STATE['rec'].warmup(None, 'ja')

    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    log(f'字幕服务已启动 http://127.0.0.1:{args.port}')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if STATE['session']:
            STATE['session'].stop()


if __name__ == '__main__':
    main()
