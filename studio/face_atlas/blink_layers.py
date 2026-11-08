# Play expression in-betweens from the standard VRM expression value (no app-side frame stepping).
# Called by expr_video.py build (the standard output); also usable alone: python blink_layers.py IN.vrm OUT.vrm
#   IN.vrm  the atlas.vrm of expr_video.py: preset expressions NAME with custom NAME_1..N in-between cells
#
# For each such NAME, every frame (NAME_1..N, then the NAME cell) becomes a copy of the Face_upper triangles, split
# into the two eyes, showing that frame's cell. The copies wait behind the eyeball layer. NAME's morph moves frame k
# forward by A_k * weight, starting B_k behind the lid; with A_k growing with k, the frontmost copy at weight w is
# frame k for w in [t_k, t_k+1) (the upper envelope of the lines z_k = A_k w - B_k), so a value that an app ramps
# 0 -> 1 -> 0 shows the frames in order. blink moves both eyes, blinkLeft / blinkRight one eye each of the blink
# frames. The expressions become non-binary morph expressions and the custom NAME_k expressions are removed.
# Their Face_upper and EyeBall texture shifts are removed. Every layer has a copy of the eyeball triangles EPS behind it,
# moved by the same morph and drawn with the EyeBall material, so where expr_video.py made a frame's eye opening
# transparent the eyeball shows, and the lookAt texture shift of that material moves it: the gaze moves during an
# expression. The copies show the neutral iris cell: the drawn iris cells of the expressions had old lid lines drawn
# in them, which showed when the iris moved (chara1 relaxed and surprised). An expression that keeps another texture-transform bind
# (the EyeShade layer of chara3's relaxed) stays binary, because a texture shift cannot be blended; it then shows
# only its last frame.
# A face with a mouth region (Face_mouth, chara4) gets the same layers for the mouth: one set over the whole mouth
# region, moved by the expression's first target; expressions that show both regions move both, and lose both texture
# shifts.
import io, json, struct, sys
import numpy as np
from PIL import Image

T = [0.15, 0.35, 0.55, 0.75, 0.92]      # weights where in-between 1..4 and the closed frame come to the front
SLOPE_STEP = 0.0003                      # m: A_k - A_k-1 (depth gap between neighbouring frames grows with it)
MARGIN = 0.0001                          # m: frame 1 starts this far behind the eyeball layer
EPS = 0.00002                            # m: each frame's eyeball copy sits this far behind the frame
LAST_GAP = float(__import__('os').environ.get('LAST_GAP', 0.0002))   # m: the last frame's lead over the frame before at weight 1
VISEMES = ('aa', 'ih', 'ou', 'ee', 'oh')
HIDE_AT = 0.9                            # a viseme at HIDE_AT * TV[0] has pushed the emotions' mouth layers behind the face
# the visemes reach their open frames early: apps blend two visemes at about half each while switching, and with T a
# half-weight mouth showed a small in-between, so speech looked like it closed between vowels (chara4)
TV = [float(x) for x in __import__('os').environ.get('VISEME_T', '0.04,0.10,0.18,0.30,0.50').split(',')]

def apply(src, dst):
    global j, blob
    b = open(src, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n]); bin0 = 20 + n + 8
    blob = bytearray(b[bin0:bin0 + struct.unpack('<I', b[20 + n:24 + n])[0]])
    def view(i):
        v = j['bufferViews'][i]; o = v.get('byteOffset', 0); return bytes(blob[o:o + v['byteLength']])
    def acc(i):
        a = j['accessors'][i]; comp = {5126: np.float32, 5123: np.uint16, 5125: np.uint32, 5121: np.uint8}[a['componentType']]
        k = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        bv = j['bufferViews'][a['bufferView']]; assert 'byteStride' not in bv or bv['byteStride'] == k * np.dtype(comp).itemsize
        return np.frombuffer(view(a['bufferView']), comp, a['count'] * k, a.get('byteOffset', 0)).reshape(a['count'], k).copy()
    def add(arr, ctype, typ, target=None, minmax=False):
        while len(blob) % 4: blob.append(0)
        data = np.ascontiguousarray(arr).tobytes(); bv = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if target: bv['target'] = target
        blob.extend(data); j['bufferViews'].append(bv)
        a = {'bufferView': len(j['bufferViews']) - 1, 'componentType': ctype, 'count': len(arr), 'type': typ}
        if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        j['accessors'].append(a); return len(j['accessors']) - 1

    mats = {m['name']: i for i, m in enumerate(j['materials'])}
    LID, EYE = mats['Face_upper'], mats['EyeBall']
    MOUTH = mats.get('Face_mouth')
    def prim_of(mi):
        for ni, nd in enumerate(j['nodes']):
            if 'mesh' in nd:
                for p in j['meshes'][nd['mesh']]['primitives']:
                    if p['material'] == mi: return ni, p
    node_lid, P = prim_of(LID); _, PE = prim_of(EYE)
    pos = acc(P['attributes']['POSITION']); nrm = acc(P['attributes']['NORMAL']); uv = acc(P['attributes']['TEXCOORD_0'])
    jo = acc(P['attributes']['JOINTS_0']); we = acc(P['attributes']['WEIGHTS_0']); idx = acc(P['indices'])[:, 0].reshape(-1, 3)
    jtype = j['accessors'][P['attributes']['JOINTS_0']]['componentType']

    # forward direction and depth of the eyeball layer: from each eyeball vertex to the nearest lid vertex
    pe = acc(PE['attributes']['POSITION'])
    d = np.linalg.norm(pe[:, None] - pos[None], axis=2); near = pos[d.argmin(1)] - pe
    fwd = near.mean(0); depth = np.linalg.norm(fwd); fwd /= depth
    gap = near @ fwd                       # per eyeball vertex: how far the lid is in front of it
    print('eyeball to lid gap mm min/max', round(gap.min() * 1000, 3), round(gap.max() * 1000, 3))
    a_e = lambda k: acc(PE['attributes'][k])
    nrm_e, uv_e, jo_e, we_e = a_e('NORMAL'), a_e('TEXCOORD_0'), a_e('JOINTS_0'), a_e('WEIGHTS_0')
    idx_e = acc(PE['indices'])[:, 0].reshape(-1, 3)
    assert j['accessors'][PE['attributes']['JOINTS_0']]['componentType'] == j['accessors'][P['attributes']['JOINTS_0']]['componentType']
    print('eyeball layer', round(depth * 1000, 3), 'mm behind the lid, forward', np.round(fwd, 3))

    # frames of each expression: custom NAME_1..N in order, then the NAME cell
    ex = j['extensions']['VRMC_vrm']['expressions']
    off = lambda e, mi=LID: next((t['offset'] for t in e.get('textureTransformBinds', []) if t['material'] == mi), None)
    isnum = lambda k: k.rsplit('_', 1)[-1].isdigit() and '_' in k
    names = sorted({k.rsplit('_', 1)[0] for k in ex.get('custom', {}) if isnum(k) and k.rsplit('_', 1)[0] in ex.get('preset', {})})
    cust, frames = {}, {}
    for nm in names:
        cust[nm] = sorted([k for k in ex['custom'] if isnum(k) and k.rsplit('_', 1)[0] == nm], key=lambda k: int(k.rsplit('_', 1)[1]))
        frames[nm] = [off(ex['custom'][k]) for k in cust[nm]] + [off(ex['preset'][nm])]
        assert len(frames[nm]) <= len(T), f'{nm}: {len(frames[nm])} frames but only {len(T)} switch weights'
    # frames on the mouth atlas, for the names that show the mouth region
    mframes = {}
    if MOUTH is not None:
        for nm in names:
            fm = [off(ex['custom'][k], MOUTH) for k in cust[nm]] + [off(ex['preset'][nm], MOUTH)]
            if all(f is not None for f in fm): mframes[nm] = fm
    names_u = [nm for nm in names if all(f is not None for f in frames[nm])]
    nf = max(len(f) for f in list(frames.values()) + list(mframes.values())); t = T[-nf:]

    # eyes: split the lid triangles by the x of their centre (the face is centred on x = 0)
    cx = pos[idx].mean(1)[:, 0]; mid = np.median(pos[:, 0]) if abs(np.median(pos[:, 0])) > 1e-3 else 0.0
    sides = [idx[cx < mid], idx[cx >= mid]]
    ce = pe[idx_e].mean(1)[:, 0]; sides_e = [idx_e[ce < mid], idx_e[ce >= mid]]
    assert all(len(t) for t in sides_e), 'eyeball triangles on one side only'
    # which side blinkLeft closes: compare its cell with cell 0 on each side's texels
    tex = j['textures'][j['materials'][LID]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    atlas = np.asarray(Image.open(io.BytesIO(view(j['images'][tex]['bufferView']))).convert('RGB'), float)
    Ht, Wt = atlas.shape[:2]
    def texels(tris, o):
        u = uv[np.unique(tris)] + np.array(o)
        return atlas[np.clip((u[:, 1] * Ht).astype(int), 0, Ht - 1), np.clip((u[:, 0] * Wt).astype(int), 0, Wt - 1)]
    side_of = {}
    for name in ('blinkLeft', 'blinkRight'):
        if name in ex['preset'] and 'blink' in names_u:
            o = off(ex['preset'][name])
            side_of[name] = int(np.argmax([np.abs(texels(s, o) - texels(s, [0, 0])).mean() for s in sides]))
    print('expressions', {nm: len(frames[nm]) for nm in names_u}, 'mouth', {nm: len(f) for nm, f in mframes.items()},
          'switch weights', t, 'wink sides', side_of)

    # lines z_k = A_k w - B_k: frame 1 crosses the lid at t_1 starting behind the eyeball; each later frame overtakes
    # the one before at t_k (an expression with fewer frames uses the last lines)
    B1 = depth + MARGIN; A = [B1 / t[0]]; B = [B1]
    for k in range(1, nf):
        # the last frame's line is steeper, so at weight 1 it stands LAST_GAP in front of the frame before it (with the
        # plain step it was 0.024 mm ahead and chara4's aa / oh at 1 showed a triangle of frame 4 through it)
        st = max(SLOPE_STEP, LAST_GAP / (1 - t[k])) if k == nf - 1 else SLOPE_STEP
        A.append(A[-1] + st); B.append(B[-1] + st * t[k])
    def lines(t):
        B1 = depth + MARGIN; A = [B1 / t[0]]; B = [B1]
        for k in range(1, nf):
            st = max(SLOPE_STEP, LAST_GAP / (1 - t[k])) if k == nf - 1 else SLOPE_STEP
            A.append(A[-1] + st); B.append(B[-1] + st * t[k])
        return A, B
    tv = TV[-nf:]; AV, BV = lines(tv)
    print('A mm', np.round(np.array(A) * 1000, 3).tolist(), 'B mm', np.round(np.array(B) * 1000, 3).tolist(),
          'in front at weight 1 (mm)', np.round((np.array(A) - np.array(B)) * 1000, 3).tolist())

    # material: a copy of the lid material (same atlas, MASK; transparent outside each frame's eye area)
    mat = json.loads(json.dumps(j['materials'][LID])); mat['name'] = 'Face_layers'
    j['materials'].append(mat); MB = len(j['materials']) - 1

    # lip sync over an emotion (chara4): the emotions stop blocking the visemes, and every viseme also moves a shared
    # target that pushes the emotions' mouth layers back, so while she speaks the viseme's mouth shows (eyes stay)
    vis = [nm for nm in mframes if nm in VISEMES]; emo_m = [nm for nm in mframes if nm not in VISEMES]
    BACK = 2 * len(names) if vis and emo_m else None
    X = (A[-1] - B[-1]) / (HIDE_AT * tv[0]) if BACK is not None else 0.0
    prims = []; ntg = 2 * len(names) + (BACK is not None); jdt = {5121: np.uint8, 5123: np.uint16}[jtype]
    def part(tris, P_, N_, UV, J_, W_):
        # one side's vertices of a mesh, and a function making a primitive of them set back along fwd
        vs = np.unique(tris); remap = {v: i for i, v in enumerate(vs)}
        ind = add(np.vectorize(remap.get)(tris).astype(np.uint32).reshape(-1), 5125, 'SCALAR', 34963)
        zero = add(np.zeros((len(vs), 3), np.float32), 5126, 'VEC3', 34962, True)
        n_ = add(N_[vs].astype(np.float32), 5126, 'VEC3', 34962)
        j_ = add(J_[vs].astype(jdt), jtype, 'VEC4', 34962); w_ = add(W_[vs].astype(np.float32), 5126, 'VEC4', 34962)
        def prim(back, a, uvoff, mat, target, back_acc=None):
            p = (P_[vs] - np.reshape(back, (-1, 1)) * fwd).astype(np.float32)
            delta = add(np.tile((a * fwd).astype(np.float32), (len(vs), 1)), 5126, 'VEC3', 34962, True)
            attrs = {'POSITION': add(p, 5126, 'VEC3', 34962, True), 'NORMAL': n_, 'JOINTS_0': j_, 'WEIGHTS_0': w_,
                     'TEXCOORD_0': add((UV[vs] + np.array(uvoff)).astype(np.float32), 5126, 'VEC2', 34962)}
            return {'attributes': attrs, 'indices': ind, 'material': mat, 'mode': 4,
                    'targets': [{'POSITION': delta if i == target else back_acc if i == BACK and back_acc is not None else zero}
                                for i in range(ntg)]}
        return vs, prim
    # the eyeball copies are one primitive: three-vrm adds a texture-transform bind once per primitive of the material,
    # so 60 primitives moved the gaze 60 times as far (the iris left the eye)
    E = {'P': [], 'N': [], 'UV': [], 'J': [], 'W': [], 'I': [], 'T': []}; nv = 0
    for s_ in range(2):
        _, lid_prim = part(sides[s_], pos, nrm, uv, jo, we)
        vse = np.unique(sides_e[s_]); remap = {v: i for i, v in enumerate(vse)}
        ind_e = np.vectorize(remap.get)(sides_e[s_]).reshape(-1)
        for ni, nm in enumerate(names):
            if nm not in names_u: continue
            fr = frames[nm]
            for k, f in enumerate(fr, start=nf - len(fr)):
                prims.append(lid_prim(B[k], A[k], f, MB, 2 * ni + s_))
                # the eyeball copy: each vertex brought to EPS behind the lid, then set back with the frame
                E['P'].append(pe[vse] - (B[k] - (gap[vse] - EPS))[:, None] * fwd)
                E['N'].append(nrm_e[vse]); E['J'].append(jo_e[vse]); E['W'].append(we_e[vse])
                E['UV'].append(uv_e[vse])
                E['I'].append(ind_e + nv); E['T'].append((2 * ni + s_, A[k], len(vse))); nv += len(vse)
    cat = lambda key, dt: np.concatenate(E[key]).astype(dt)
    tg, o = [np.zeros((nv, 3), np.float32) for _ in range(ntg)], 0
    for t_, a_, n_ in E['T']: tg[t_][o:o + n_] = a_ * fwd; o += n_
    prims.append({'attributes': {'POSITION': add(cat('P', np.float32), 5126, 'VEC3', 34962, True),
                                 'NORMAL': add(cat('N', np.float32), 5126, 'VEC3', 34962),
                                 'TEXCOORD_0': add(cat('UV', np.float32), 5126, 'VEC2', 34962),
                                 'JOINTS_0': add(cat('J', jdt), jtype, 'VEC4', 34962), 'WEIGHTS_0': add(cat('W', np.float32), 5126, 'VEC4', 34962)},
                  'indices': add(cat('I', np.uint32), 5125, 'SCALAR', 34963), 'material': EYE, 'mode': 4,
                  'targets': [{'POSITION': add(t, 5126, 'VEC3', 34962, True)} for t in tg]})
    if mframes:
        # the mouth: a copy of the lid material for the mouth atlas, one part over the whole mouth region
        node_m, PM = prim_of(MOUTH)
        assert j['nodes'][node_m].get('skin') == j['nodes'][node_lid].get('skin'), 'mouth and lid on different skins'
        am = lambda k: acc(PM['attributes'][k])
        idx_m = acc(PM['indices'])[:, 0].reshape(-1, 3)
        matm = json.loads(json.dumps(j['materials'][MOUTH])); matm['name'] = 'Face_layers_mouth'
        j['materials'].append(matm); MBM = len(j['materials']) - 1
        vs_m, mouth_prim = part(idx_m, am('POSITION'), am('NORMAL'), am('TEXCOORD_0'), am('JOINTS_0'), am('WEIGHTS_0'))
        bk = add(np.tile((-X * fwd).astype(np.float32), (len(vs_m), 1)), 5126, 'VEC3', 34962, True) if BACK is not None else None
        if BACK is not None: print('visemes', vis, 'push the mouth layers of', emo_m, 'back', round(X * 1000, 3), 'mm per unit')
        for ni, nm in enumerate(names):
            if nm not in mframes: continue
            fr = mframes[nm]
            for k, f in enumerate(fr, start=nf - len(fr)):
                a_, b_ = (AV, BV) if nm in VISEMES else (A, B)
                prims.append(mouth_prim(b_[k], a_[k], f, MBM, 2 * ni, bk if nm in emo_m else None))
    j['meshes'].append({'name': 'Face_layers', 'primitives': prims, 'weights': [0] * ntg,
                        'extras': {'targetNames': [f'{nm}_side{x}' for nm in names for x in (0, 1)] + (['mouth_back'] if BACK is not None else [])}})
    nd = {'name': 'Face_layers', 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][node_lid]['skin']}
    j['nodes'].append(nd); NB = len(j['nodes']) - 1; j['scenes'][j.get('scene', 0)]['nodes'].append(NB)

    def morph(e, ts, name):
        # the lid shift and the eyeball's iris shift go: the layers and their eyeball copies show them
        e['textureTransformBinds'] = [x for x in e.get('textureTransformBinds', []) if x['material'] not in (LID, EYE, MOUTH)]
        if e['textureTransformBinds']:
            print(name, 'keeps', len(e['textureTransformBinds']), 'other texture binds: stays binary (last frame only)')
        else:
            e.pop('textureTransformBinds'); e['isBinary'] = False
        e['morphTargetBinds'] = e.get('morphTargetBinds', []) + [{'node': NB, 'index': i, 'weight': 1.0} for i in ts]
    for ni, nm in enumerate(names):
        morph(ex['preset'][nm], [2 * ni, 2 * ni + 1], nm)
        for k in cust[nm]: del ex['custom'][k]
    for name, sd in side_of.items(): morph(ex['preset'][name], [2 * names.index('blink') + sd], name)
    if BACK is not None:
        for nm in vis: ex['preset'][nm]['morphTargetBinds'].append({'node': NB, 'index': BACK, 'weight': 1.0})
        for nm in emo_m: ex['preset'][nm]['overrideMouth'] = 'none'
    # the visemes and other names in the custom frames that show only the mouth are covered by the loop above

    while len(blob) % 4: blob.append(0)
    j['buffers'][0]['byteLength'] = len(blob)
    js = json.dumps(j, separators=(',', ':')).encode()
    while len(js) % 4: js += b' '
    glb = (struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(blob)) + struct.pack('<I4s', len(js), b'JSON') + js
           + struct.pack('<I4s', len(blob), b'BIN\0') + bytes(blob))
    open(dst, 'wb').write(glb)
    print('layers', len(prims), '(lid frames x 2 eyes, plus 1 of all eyeball copies)', 'size', len(glb))


if __name__ == '__main__':
    apply(*sys.argv[1:3])
