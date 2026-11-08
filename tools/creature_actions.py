"""生き物の blend にある Action の名前とコマの範囲を JSON に書く。Blender の背景で動かす。
blender -b <blend> --python-exit-code 1 --python tools/creature_actions.py -- <out.json>
Armature が無い、Action が 1 つも無いときは理由を stderr に出して終了コード 1 で終わる。"""
import json
import sys

import bpy

out = sys.argv[sys.argv.index('--') + 1]
armatures = [o.name for o in bpy.data.objects if o.type == 'ARMATURE']
actions = {a.name: {'frames': [a.frame_range[0], a.frame_range[1]]} for a in bpy.data.actions}
external_images = sorted({i.filepath for i in bpy.data.images if i.source == 'FILE' and not i.packed_file and i.filepath})
with open(out, 'w', encoding='utf8') as f:
    json.dump({'armatures': armatures, 'actions': actions, 'externalImages': external_images}, f, ensure_ascii=False)
if not armatures:
    sys.stderr.write('Armature が無い\n')
    sys.exit(1)
if not actions:
    sys.stderr.write('Action が無い\n')
    sys.exit(1)
