"""枝にとまる生き物。ステージのコードの外から差し込む。Blender の中で動く。
spec: {"blend": "...", "perch": 0, "drop": 0.07, "scale": 0.62, "yaw": 145, "fps": 24, "rest": ["perch", 60, 60], "clips": {"down": ["perch", 96, 135], "caw": ["perch", 166, 188]}, "fly": ["flap", 1, 121], "path": [[2.4, 10, 3], [1.3, 4, 1.9], [0.6, -3, 3]],
       "events": [{"at": 6.9, "name": "down"}, {"at": 20.9, "name": "takeoff"}]}
rest、clips、fly は [Action の名前, 始めのコマ, 終わりのコマ]。clips は event の時刻から 1 回再生して最後のコマを保つ。takeoff は caw を再生してから fly を繰り返しながら飛ぶ。path は枝から先の 3 次のベジェの残り 3 点。flight は path の終わりまでの秒(省くと FLIGHT)。
座標は生き物の前が +X、上が +Z の Action を前提にする。
"""
import math
from pathlib import Path

import bpy
from mathutils import Vector

BLEND = 0.3  # 動きの間をつなぐ秒
LIFT = 0.4  # 羽を動かし始めてから足が枝を離れるまでの秒
FLIGHT = 2.8  # 枝から to までの秒


def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def load(blend):
    with bpy.data.libraries.load(str(Path(blend)), link=False) as (src, dst):
        dst.objects = src.objects
        dst.actions = src.actions
    for o in dst.objects:
        bpy.context.collection.objects.link(o)
    return next(o for o in dst.objects if o.type == 'ARMATURE'), {a.name: a for a in dst.actions}


def channels(action):
    """Action の F カーブ。スロットは 1 つの前提"""
    return list(action.layers[0].strips[0].channelbags[0].fcurves)


def key(fc, values):
    """F カーブへ毎コマの値を置く"""
    pts = fc.keyframe_points
    pts.add(len(values))
    pts.foreach_set('co', [x for f, v in enumerate(values, 1) for x in (f, v)])
    linear = bpy.types.Keyframe.bl_rna.properties['interpolation'].enum_items['LINEAR'].value
    pts.foreach_set('interpolation', [linear] * len(values))
    fc.update()


def schedule(spec):
    """再生の予定 [(開始の秒, (Action, 始め, 終わり), 繰り返すか)] と、飛び立つ秒(無ければ None)"""
    plan, fly_at = [(0.0, spec['rest'], False)], None
    for e in spec['events']:
        if e['name'] == 'takeoff':
            caw = spec['clips']['caw']
            fly_at = e['at'] + (caw[2] - caw[1]) / spec['fps']
            plan += [(e['at'], caw, False), (fly_at, spec['fly'], True)]
        else:
            plan.append((e['at'], spec['clips'][e['name']], False))
    return plan, fly_at


def clip_frame(clip, loop, t, fps):
    """開始から t 秒のコマ"""
    _, a, b = clip
    return a + (t * fps) % max(b - a, 1) if loop else min(b, a + t * fps)


def bone_row(by, none, plan, F, frame_fps, fps):
    """1 本の F カーブの全コマの値。切り替えは BLEND 秒で混ぜる"""
    def value(entry, t):
        at, clip, loop = entry
        fc = by.get(clip[0])
        return fc.evaluate(clip_frame(clip, loop, max(0.0, t - at), fps)) if fc else none

    row = []
    for f in range(F):
        t = f / frame_fps
        k = max(i for i, e in enumerate(plan) if e[0] <= t)
        v = value(plan[k], t)
        if k and t - plan[k][0] < BLEND:
            mix = smooth((t - plan[k][0]) / BLEND)
            v = value(plan[k - 1], t) * (1 - mix) + v * mix
        row.append(v)
    return row


def flight(perch, path, t, seconds=FLIGHT):
    """足が離れてからの位置。初めはゆっくり"""
    a = perch
    b, c, d = (Vector(p) for p in path)
    u = max(0.0, t / seconds)
    u = min(1.0, u) ** 2 * (1.4 - 0.4 * min(1.0, u)) + max(0.0, u - 1)
    w = 1 - u
    return a * w ** 3 + b * 3 * w * w * u + c * 3 * w * u * u + d * u ** 3


def add(spec, stage, F, fps):
    """生き物を枝へ置き、全コマの動きを F カーブへ焼く。答えは枝の上の頭のあたりの位置(カメラの見る点)"""
    arm, actions = load(spec['blend'])
    perch = Vector(stage['perches'][spec['perch']]) - Vector((0, 0, spec.get('drop', 0)))  # drop は足を枝へ下ろす量
    arm.scale = (spec['scale'],) * 3
    arm.rotation_mode = 'XYZ'
    yaw0 = math.radians(spec['yaw'])
    plan, fly_at = schedule(spec)
    curves = {}
    for name in {e[1][0] for e in plan}:
        for fc in channels(actions[name]):
            curves.setdefault((fc.data_path, fc.array_index), {})[name] = fc
    baked = bpy.data.actions.new('CreatureTake')
    arm.animation_data_create()
    arm.animation_data.action = baked
    for (path, index), by in curves.items():
        none = 1.0 if path.endswith('rotation_quaternion') and index == 0 else 0.0
        key(baked.fcurve_ensure_for_datablock(arm, path, index=index), bone_row(by, none, plan, F, fps, spec['fps']))
    loc, rot = [], []
    for f in range(F):
        fly = f / fps - fly_at - LIFT if fly_at is not None else -1
        if fly <= 0:
            loc.append(perch)
            rot.append((0.0, 0.0, yaw0))
            continue
        p = flight(perch, spec['path'], fly, spec.get('flight', FLIGHT))
        v = flight(perch, spec['path'], fly + 0.1, spec.get('flight', FLIGHT)) - p
        d = (math.atan2(v.y, v.x) - yaw0 + math.pi) % math.tau - math.pi
        k = smooth(fly / 0.5)
        rot.append((0.0, -k * math.atan2(v.z, v.xy.length), yaw0 + d * k))
        loc.append(p)
    for i in range(3):
        key(baked.fcurve_ensure_for_datablock(arm, 'location', index=i), [p[i] for p in loc])
        key(baked.fcurve_ensure_for_datablock(arm, 'rotation_euler', index=i), [r[i] for r in rot])
    bpy.context.scene.frame_set(1)
    return tuple(arm.matrix_world @ arm.pose.bones['Head'].head)
