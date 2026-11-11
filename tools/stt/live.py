#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
实时字幕原型:预取音频窗口 -> faster-whisper 识别 -> LLM 翻译 -> 双语字幕。

模拟播放中的持续预取:每 WINDOW 秒取一段音频,识别并翻译,
统计"字幕比画面提前多久就绪"。

用法:
    python live.py --media <视频/音频文件> [--start 60] [--windows 6] [--window 10]
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

_VENV = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.stt', 'venv'))
for lib in ('cublas', 'cudnn', 'cudart'):
    p = os.path.join(_VENV, 'Lib', 'site-packages', 'nvidia', lib, 'bin')
    if os.path.isdir(p) and p not in os.environ['PATH']:
        os.environ['PATH'] = p + os.pathsep + os.environ['PATH']

DEFAULT_MODEL = (
    r'C:\AI\VideoCaptioner-0.0.0.dev535+g95842ecb5.d20260625-windows-x64'
    r'\VideoCaptioner\AppData\models\faster-whisper-large-v2'
)
FFMPEG = r'C:\Program Files\Jellyfin\Server\ffmpeg.exe'
OLLAMA = 'http://127.0.0.1:11434/api/generate'

SYS_PROMPT = (
    '你是专业的影视字幕翻译。把日语翻译成简体中文口语，要求：\n'
    '- 保持口语自然，符合对话语气\n'
    '- 如果原文是语气词或很短，就译成对应的中文语气词\n'
)


def cut_audio(src, dst, start, dur, ffmpeg=FFMPEG):
    import subprocess
    cmd = [ffmpeg, '-ss', str(start), '-t', str(dur), '-i', src,
           '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', dst]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def ollama_translate_batch(texts, model, timeout=120):
    """批量翻译一个窗口里的所有句子。

    一次请求翻多句远比逐句请求快(省掉重复的 prompt 处理与网络往返)。
    用带编号的格式让模型逐条输出,再按编号解析。
    """
    if not texts:
        return [], 0.0
    numbered = '\n'.join(f'{i+1}. {t}' for i, t in enumerate(texts))
    prompt = (
        f'{SYS_PROMPT}\n'
        '下面是按编号排列的日语字幕，逐条翻译成简体中文。\n'
        '严格按相同编号输出，每条一行，格式为「编号. 译文」，不要合并、不要遗漏。\n\n'
        f'{numbered}\n'
    )
    body = json.dumps({
        'model': model,
        'prompt': prompt,
        'stream': False,
        'think': False,
        'options': {'num_predict': 400, 'temperature': 0.2},
    }).encode('utf-8')
    req = urllib.request.Request(OLLAMA, data=body,
                                 headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode('utf-8'))
    el = time.time() - t0
    raw = (data.get('response') or '').strip()

    out = [''] * len(texts)
    for line in raw.splitlines():
        m = re.match(r'^\s*(\d+)\s*[.、,:：)]\s*(.+)$', line)
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(out):
                out[idx] = m.group(2).strip().strip('"').strip('「」')
    for i, v in enumerate(out):
        if not v:
            out[i] = raw if len(texts) == 1 else texts[i]
    return out, el


def ollama_translate(text, model, timeout=60):
    """单句翻译(向后兼容)。"""
    r, el = ollama_translate_batch([text], model, timeout)
    return (r[0] if r else ''), el
    return out, el


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--media', required=True, help='视频或音频文件')
    ap.add_argument('--start', type=float, default=60.0, help='从第几秒开始')
    ap.add_argument('--windows', type=int, default=6, help='测几个窗口')
    ap.add_argument('--window', type=float, default=10.0, help='窗口秒数')
    ap.add_argument('--language', default='ja')
    ap.add_argument('--llm', default='qwen3.5:9b')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--compute-type', default='float16')
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    tmpdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.stt', 'tmp')
    os.makedirs(tmpdir, exist_ok=True)
    wav = os.path.join(tmpdir, 'live_win.wav')

    print('=' * 78)
    print('实时字幕原型:预取 → 识别 → 翻译')
    print('=' * 78)

    from faster_whisper import WhisperModel
    t0 = time.time()
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    load_s = time.time() - t0
    print(f'模型加载: {load_s:.2f}s')

    # 预热(初始化 CUDA kernel)
    cut_audio(args.media, wav, args.start, args.window)
    t0 = time.time()
    list(model.transcribe(wav, language=args.language, beam_size=1, vad_filter=False)[0])
    print(f'预热: {time.time()-t0:.2f}s(不计入)')
    print(f'LLM 翻译: {args.llm}')
    print()

    runs = []
    total_lead = 0.0
    for i in range(args.windows):
        off = args.start + i * args.window
        print(f'--- 窗口 {i+1}/{args.windows}  t={off:.0f}s ~ {off+args.window:.0f}s ---')

        # 1) 预取音频
        t_a = time.time()
        cut_audio(args.media, wav, off, args.window)
        cut_s = time.time() - t_a

        # 2) 识别
        t_a = time.time()
        segs, info = model.transcribe(
            wav, language=args.language, beam_size=1, vad_filter=False,
            condition_on_previous_text=False, word_timestamps=False)
        segs = [{'start': round(s.start + off, 2), 'end': round(s.end + off, 2),
                 'text': s.text.strip()} for s in segs]
        asr_s = time.time() - t_a

        # 3) 翻译(整个窗口一次批量请求,比逐句快很多)
        t_a = time.time()
        texts = [s['text'] for s in segs]
        try:
            zh_list, _ = ollama_translate_batch(texts, args.llm)
            for s, zh in zip(segs, zh_list):
                s['zh'] = zh
        except Exception as e:
            for s in segs:
                s['zh'] = f'<翻译失败: {e}>'
        mt_s = time.time() - t_a

        ready_s = cut_s + asr_s + mt_s
        lead = args.window - ready_s   # 正数 = 字幕比画面提前就绪
        total_lead += lead

        print(f'  切音频 {cut_s:.2f}s | 识别 {asr_s:.2f}s | 翻译 {mt_s:.2f}s '
              f'| 合计 {ready_s:.2f}s')
        print(f'  预取提前量: {lead:+.2f}s  ({"领先" if lead > 0 else "落后"}画面)')
        for s in segs:
            print(f'    [{s["start"]:7.2f}] {s["text"]}')
            print(f'             └─ {s["zh"]}')

        runs.append({'offset': off, 'cut_s': round(cut_s, 2),
                     'asr_s': round(asr_s, 2), 'mt_s': round(mt_s, 2),
                     'ready_s': round(ready_s, 2), 'lead_s': round(lead, 2),
                     'segments': segs})
        print()

    avg_ready = sum(r['ready_s'] for r in runs) / len(runs)
    avg_lead = total_lead / len(runs)
    print('=' * 78)
    print(f'平均每窗口耗时: {avg_ready:.2f}s (窗口 {args.window:.0f}s)')
    print(f'平均提前量: {avg_lead:+.2f}s')
    if avg_lead > 0:
        print(f'[OK] 字幕可以比画面提前 {avg_lead:.1f}s 就绪 → 播放时零等待')
    else:
        print('[WARN] 字幕跟不上画面,需要缩小窗口或提速')

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump({'llm': args.llm, 'window': args.window, 'runs': runs,
                       'avg_ready_s': round(avg_ready, 2),
                       'avg_lead_s': round(avg_lead, 2)}, f,
                      ensure_ascii=False, indent=2)
        print(f'已写入 {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
