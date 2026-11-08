"""シェイプキー方式の顔を作る入口(references/face_own.md)。
python own.py merge defaults.json character.json out.json  既定の値にキャラの値を重ねる
python own.py place params.json          頭の面を読み、絵と正面を合わせ、目と口の位置を重ねた確認の絵を作る
python own.py build params.json out.vrm  VRM を組み立てる(place のあとに)"""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)


def deep(a, b):
    for k, v in b.items():
        a[k] = deep(dict(a[k]), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a


def load(f):
    return json.load(open(f, encoding='utf8'))


def main():
    if len(sys.argv) < 3: raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == 'merge':
        P = deep(load(sys.argv[2]), load(sys.argv[3]))
        json.dump(P, open(sys.argv[4], 'w', encoding='utf8'), ensure_ascii=False, indent=1)
        return
    P = load(sys.argv[2])
    os.makedirs(P['work'], exist_ok=True)
    import base, parts
    if cmd == 'place':
        import register, overlay
        base.configure(P); base.raycast(P); register.main(P)
        parts.configure(P); overlay.main(P)
    elif cmd == 'build':
        import build
        parts.configure(P)
        R = build.build(P)
        rep = build.assemble(R, P, sys.argv[3])
        print('keys', len(rep), 'empty', [k for k, v in rep.items() if max(v.values()) < 1e-3])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
