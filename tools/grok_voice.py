# 顔の絵 1 枚と声の種類から、Grok Build CLI で「その子が文を言う動画」を 1 本作る(声のジョブが呼ぶ)。
#
#   python grok_voice.py OUT.mp4 --first FACE.png --voice eve --text "こんにちは" [--duration 4] [--timeout 900] [--dry-run]
#
# reference_to_video を 1 回だけ呼ばせる。first_frame = 顔の絵、voices = [声]、480p、16:9。
# duration を省くと文字数から 3〜8 秒を決める。失敗しても再試行しない(Grok を呼ぶのはボタンを押した 1 回だけ)。
# OUT.prompt.txt(Grok への依頼文)、OUT.log(Grok の返事)を OUT の隣に書く。--dry-run は依頼文を出して終わる。
# 参考: ~/.claude/skills/grok-build-video/scripts/grok_video.py(依頼文の決まり文句、エラーの見分け方)
import argparse, json, math, os, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8')

ap = argparse.ArgumentParser()
ap.add_argument('out')
ap.add_argument('--first', required=True, help='顔の絵(first_frame)')
ap.add_argument('--voice', required=True, help='声の種類(ara / eve / leo / rex など)')
ap.add_argument('--text', required=True, help='その子が言う文')
ap.add_argument('--duration', type=int)
ap.add_argument('--timeout', type=int, default=900)
ap.add_argument('--dry-run', action='store_true')
a = ap.parse_args()

absp = lambda p: os.path.abspath(p)
out = absp(a.out); base = os.path.splitext(out)[0]
if not os.path.isfile(a.first): sys.exit(f'not found: {a.first}')
if not a.text.strip(): sys.exit('--text is empty')
# 1 文字 0.3 秒 + 前後 1.5 秒、3〜8 秒
duration = a.duration if a.duration is not None else min(8, max(3, math.ceil(len(a.text) * 0.3 + 1.5)))
if not 1 <= duration <= 15: sys.exit('reference_to_video takes 1-15 seconds')

motion = (f'<AUDIO_0> がこの子の声。この子がカメラを見て、日本語で「{a.text}」と一度だけ言う。'
          '口の動きは声に合わせる。カメラは固定で動かさない。音楽も効果音も入れない。声だけ。')
args = {'first_frame': absp(a.first), 'voices': [a.voice], 'duration': duration, 'resolution_name': '480p',
        'aspect_ratio': '16:9', 'prompt': motion}

prompt = f'''reference_to_video ツールを1回だけ呼んで、動画を1本生成してください。失敗しても再試行せず、エラーをそのまま報告してください。
画像の生成・編集やファイルの加工は、ほかのツールでしないでください。
引数（JSON）:
{json.dumps(args, ensure_ascii=False, indent=2)}
生成された動画ファイルを {out} に保存（ダウンロードまたはコピー）し、保存先のパス、解像度、fps、フレーム数、長さを報告してください。
'''
os.makedirs(os.path.dirname(out), exist_ok=True)
open(base + '.prompt.txt', 'w', encoding='utf-8').write(prompt)
if a.dry_run:
    print(prompt); sys.exit(0)
if os.path.exists(out): sys.exit(f'{out} already exists; choose another name (a new generation is not overwritten silently)')

cmd = ['grok', '--prompt-file', base + '.prompt.txt', '--always-approve', '--output-format', 'plain']
try:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=a.timeout)
    log = r.stdout + r.stderr
except subprocess.TimeoutExpired as e:
    log = f'timeout after {a.timeout} s\n' + ((e.stdout or b'').decode('utf-8', 'replace') if isinstance(e.stdout, bytes) else (e.stdout or ''))
except FileNotFoundError:
    sys.exit('grok command not found (Grok Build CLI is not installed or not on PATH)')
open(base + '.log', 'w', encoding='utf-8').write(log)

if not os.path.isfile(out):
    print(log[-1500:])
    if 'response.metadata' in log:
        print('\n-> Grok Build could not read the model server\'s answer (stopped before any tool call). Retrying later worked on 2026-10-29.')
    if '401' in log and 'Unauthorized' in log:
        print('\n-> not signed in for this model: run `grok login` (the user does it), or use the default model.')
    # 2026-10-30: 残高が尽きると 402 Payment Required。画面に出るのは最後の行なので、日本語の短い文で終える
    if '402' in log and 'balance exhausted' in log:
        sys.exit('Grok Build の利用残高が尽きている（402）。残高を足してからもう一度押す')
    sys.exit('no video was saved')

probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                        'stream=width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', out],
                       capture_output=True, text=True)
info = json.loads(probe.stdout or '{}'); s = (info.get('streams') or [{}])[0]
print('saved', out, s.get('width'), 'x', s.get('height'), s.get('r_frame_rate'), 'fps', s.get('nb_frames'), 'frames',
      round(float(info.get('format', {}).get('duration', 0)), 3), 's')
