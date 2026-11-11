#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
faster-whisper 预取窗口识别基准测试(已针对 GPU 优化)。

关键发现:
  * 模型只加载一次,常驻内存 —— 每次重新加载要 5s,这是最大的坑
  * beam_size=1 比 5 快约 3 倍,质量差异很小
  * VAD 对已切好的窗口无收益,反而拖慢

用法:
    python bench.py --audio <wav> [--window 10] [--language ja]
"""
import argparse
import json
import os
import sys
import time

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# CUDA DLL 路径(ctranslate2 需要 cublas/cudnn)
_VENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.stt', 'venv')
_VENV = os.path.abspath(_VENV)
for lib in ('cublas', 'cudnn', 'cudart'):
    p = os.path.join(_VENV, 'Lib', 'site-packages', 'nvidia', lib, 'bin')
    if os.path.isdir(p) and p not in os.environ['PATH']:
        os.environ['PATH'] = p + os.pathsep + os.environ['PATH']

DEFAULT_MODEL = (
    r'C:\AI\VideoCaptioner-0.0.0.dev535+g95842ecb5.d20260625-windows-x64'
    r'\VideoCaptioner\AppData\models\faster-whisper-large-v2'
)


class Recognizer:
    """常驻识别器:模型只加载一次。"""

    def __init__(self, model_dir, device='cuda', compute_type='float16'):
        from faster_whisper import WhisperModel
        t0 = time.time()
        self.model = WhisperModel(model_dir, device=device, compute_type=compute_type)
        self.load_s = time.time() - t0
        self.device = device
        self.model_dir = model_dir

    def warmup(self, audio_path, language='ja'):
        """预热:第一次推理会初始化 CUDA kernel,不计入正式耗时。"""
        t0 = time.time()
        segs, _ = self.model.transcribe(
            audio_path, language=language, beam_size=1, vad_filter=False)
        list(segs)
        return time.time() - t0

    def transcribe(self, audio_path, language='ja', beam_size=1,
                   vad=False, offset=0.0):
        t0 = time.time()
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            beam_size=beam_size,
            vad_filter=vad,
            vad_parameters={'min_silence_duration_ms': 300} if vad else None,
            condition_on_previous_text=False,
            word_timestamps=False,
        )
        segs = [{'start': round(s.start + offset, 2),
                 'end': round(s.end + offset, 2),
                 'text': s.text.strip()} for s in segments]
        return segs, info, time.time() - t0


def make_window(src, dst, start, dur, ffmpeg):
    """用 ffmpeg 精确切出一段音频(模拟预取窗口)。"""
    import subprocess
    cmd = [ffmpeg, '-ss', str(start), '-t', str(dur), '-i', src,
           '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', dst]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--compute-type', default='float16')
    ap.add_argument('--language', default='ja')
    ap.add_argument('--beam', type=int, default=1)
    ap.add_argument('--window', type=float, default=10.0,
                    help='预取窗口秒数;0 表示整段一次识别')
    ap.add_argument('--ffmpeg', default=r'C:\Program Files\Jellyfin\Server\ffmpeg.exe')
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        print(f'[ERR] 模型目录不存在: {args.model}'); return 2
    if not os.path.isfile(args.audio):
        print(f'[ERR] 音频不存在: {args.audio}'); return 2

    print(f'模型: {os.path.basename(args.model)}')
    print(f'设备: {args.device} / {args.compute_type}  beam={args.beam}')

    rec = Recognizer(args.model, args.device, args.compute_type)
    print(f'模型加载: {rec.load_s:.2f}s')
    wu = rec.warmup(args.audio, args.language)
    print(f'预热: {wu:.2f}s(不计入)')

    import wave
    with wave.open(args.audio, 'rb') as w:
        total = w.getnframes() / float(w.getframerate())
    print(f'音频: {total:.1f}s')

    result = {'model': os.path.basename(args.model), 'device': args.device,
              'compute_type': args.compute_type, 'beam': args.beam,
              'load_s': round(rec.load_s, 2), 'audio_s': round(total, 1), 'runs': []}

    if args.window <= 0:
        segs, info, el = rec.transcribe(args.audio, args.language, args.beam)
        result['runs'].append({'window': total, 'elapsed_s': round(el, 2),
                               'speedup': round(total / el, 1), 'segments': segs})
        print(f'\n整段: {el:.2f}s ({total/el:.1f}x)')
        for s in segs:
            print(f'  [{s["start"]:6.2f}-{s["end"]:6.2f}] {s["text"]}')
    else:
        win = args.window
        n = int(total // win) + (1 if total % win > 0.05 else 0)
        tmp = os.path.join(os.path.dirname(os.path.abspath(args.audio)), '_win.wav')
        print(f'\n按 {win}s 窗口切分,共 {n} 个窗口')
        for i in range(n):
            off = i * win
            dur = min(win, total - off)
            if dur < 1.0:
                break
            make_window(args.audio, tmp, off, dur, args.ffmpeg)
            segs, info, el = rec.transcribe(tmp, args.language, args.beam, offset=off)
            sp = dur / el if el > 0 else 0
            result['runs'].append({'offset': round(off, 1), 'window': round(dur, 1),
                                   'elapsed_s': round(el, 2), 'speedup': round(sp, 1),
                                   'segments': segs})
            flag = 'OK ' if sp > 1.0 else 'SLOW'
            print(f'[{flag}] t={off:5.0f}s win={dur:4.0f}s  {el:5.2f}s  {sp:5.1f}x   ', end='')
            print(' / '.join(s['text'] for s in segs) or '(无语音)')

    if result['runs']:
        els = [r['elapsed_s'] for r in result['runs']]
        sps = [r['speedup'] for r in result['runs']]
        result['summary'] = {
            'runs': len(result['runs']),
            'avg_elapsed_s': round(sum(els) / len(els), 2),
            'min_speedup': round(min(sps), 1),
            'avg_speedup': round(sum(sps) / len(sps), 1),
        }
        print(f'\n汇总: {result["summary"]}')
        if result['summary']['min_speedup'] <= 1.0:
            print('[WARN] 存在慢于实时的窗口,预取会跟不上播放')
        else:
            print('[OK] 所有窗口都快于实时,预取方案可行')

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f'已写入 {args.json}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
