"""きゃらすたのキットに入れる stage-studio の assets/ の PNG を、assets/webp_manifest.json のとおりに WebP へ変え、PNG を消す。
    python tools/kit_webp.py <書き出した stage-studio のフォルダ>
作者のリポジトリでは動かさない(PNG が消える)。きゃらすたの scripts/export-kit.mjs が、書き出した写しに対して呼ぶ。
扱い: lossy は WebP の quality(既定は lossy_quality、ファイルごとに q で上書き)、lossless は可逆の WebP(読み直して元と同じ値か確かめる)、
keep は PNG のまま、exclude はキットに入れない(消す)。表に無い PNG や、表にあってファイルが無いものがあれば、何も変えずに止まる。
ステージは lib/studio.py の load_image で読み、.png が無ければ同じ名前の .webp を読む。"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image


def convert(job):
    src, mode, q = job
    src = Path(src)
    dst = src.with_suffix('.webp')
    im = Image.open(src)
    im.load()
    if im.mode not in ('RGB', 'RGBA'):  # WebP は灰色を持たない。R=G=B にする(Blender は灰色の PNG も RGB で読む)
        im = im.convert('RGBA' if 'A' in im.mode or 'transparency' in im.info else 'RGB')
    if mode == 'lossless':
        im.save(dst, 'WEBP', lossless=True, quality=80, method=4, exact=True)
        back = Image.open(dst).convert(im.mode)
        if not np.array_equal(np.asarray(back), np.asarray(im)):
            raise SystemExit(f'可逆の WebP が元と違う: {src}')
    else:
        im.save(dst, 'WEBP', quality=q, method=6, alpha_quality=100)
    before = src.stat().st_size
    src.unlink()
    return before, dst.stat().st_size


def main(root):
    if (Path(root) / '.git').exists():
        raise SystemExit(f'{root} は git のリポジトリ。PNG を消すので、書き出した写しにだけ使う')
    assets = Path(root) / 'assets'
    doc = json.loads((assets / 'webp_manifest.json').read_text(encoding='utf8'))
    files = doc['files']
    found = {p.relative_to(assets).as_posix() for p in assets.rglob('*.png')}
    missing = sorted(found - set(files))
    stale = sorted(set(files) - found)
    if missing or stale:
        for f in missing:
            print(f'表に無い PNG: assets/{f}', file=sys.stderr)
        for f in stale:
            print(f'表にあるがファイルが無い: assets/{f}', file=sys.stderr)
        raise SystemExit('assets/webp_manifest.json を直してから書き出してほしい(何も変えていない)')
    total = {m: [0, 0, 0] for m in ('lossy', 'lossless', 'keep', 'exclude')}  # 件数、前、後
    jobs = []
    for f, e in sorted(files.items()):
        p, m = assets / f, e['mode']
        if m not in total:
            raise SystemExit(f'扱いが分からない: {f} {m}')
        total[m][0] += 1
        total[m][1] += p.stat().st_size
        if m == 'keep':
            total[m][2] += p.stat().st_size
        elif m == 'exclude':
            print(f'  入れない {p.stat().st_size / 1048576:6.2f} MiB  assets/{f}')
            p.unlink()
        else:
            jobs.append((f, (str(p), m, e.get('q', doc['lossy_quality']))))
    with ProcessPoolExecutor() as ex:
        for (f, (_, m, _q)), (_b, a) in zip(jobs, ex.map(convert, [j for _, j in jobs])):
            total[m][2] += a
    for m, (n, b, a) in total.items():
        print(f'{m:8} {n:4} 件  {b / 1048576:7.1f} MiB -> {a / 1048576:7.1f} MiB')
    b, a = sum(t[1] for t in total.values()), sum(t[2] for t in total.values())
    print(f'assets の絵 {b / 1048576:.1f} MiB -> {a / 1048576:.1f} MiB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
