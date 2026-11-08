# Round a pointed chin on the rigged head mesh (chara4: Kimi kept the original art's narrow V jaw).
# Usage: blender -b character.blend --python round_chin.py -- OUT.blend Z_MOUTH Z_CHIN [WIDEN] [LIFT_MM] [BACK_MM]
#   Z_MOUTH / Z_CHIN  world heights (m) of the mouth line and of the chin tip
#   WIDEN    how much wider the jaw gets at the chin (share of x, default 0.18), fading to 0 at the mouth
#   LIFT_MM  how far the chin tip moves up at the centre (default 3), fading out sideways over 3 cm
#   BACK_MM  how far the forward-most chin vertices move back (default 0), so the side profile rounds too; the
#            pull fades with the height weight and with how far forward the vertex is (none behind the jaw line)
# Only front-half vertices of Head between the chin and the mouth move (the neck stub and the back stay), so the
# head keeps its topology, UVs, weights and the seam with the body; the face regions are made again afterwards.
import bpy, sys, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
out, zm, zc = a[0], float(a[1]), float(a[2])
widen = float(a[3]) if len(a) > 3 else 0.18; lift = (float(a[4]) if len(a) > 4 else 3.0) / 1000
back = (float(a[5]) if len(a) > 5 else 0.0) / 1000
import os
UNDER = float(os.environ.get('CHIN_UNDER', '0.012'))      # m below the chin tip over which the change fades out (the underside of the jaw)
h = bpy.data.objects['Head']; M = h.matrix_world; Mi = M.inverted()
ys = sorted((M @ v.co).y for v in h.data.vertices); ymid = ys[len(ys) // 2]; yfront = ys[0]
def sstep(e0, e1, x):
    t = min(1, max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t)
moved = 0
for v in h.data.vertices:
    p = M @ v.co
    if p.y > ymid - 0.01: continue                            # the back half and the neck behind the jaw stay
    t = 1 - sstep(zc, zm, p.z)                                # 1 at the chin, 0 at the mouth
    t *= sstep(zc - UNDER, zc, p.z)                           # and back to 0 below the chin (neck stub)
    if t <= 0: continue
    fw = sstep(ymid - 0.01, yfront + 0.01, p.y)               # 0 at the jaw line, 1 at the front of the face
    q = Vector((p.x * (1 + widen * t), p.y + back * t * fw, p.z + lift * t * math.exp(-(p.x / 0.03) ** 2)))
    v.co = Mi @ q; moved += 1
h.data.update()
bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
print('ROUND_CHIN moved', moved, 'widen', widen, 'lift mm', lift * 1000, 'back mm', back * 1000, '->', out)
