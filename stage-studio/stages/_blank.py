"""ステージの見本。build は場面を作り、撮影の情報を返す。キャラはステージの mark に立ち、正面は -Y(facing で回す)。"""
import bpy


def build(ctx):
    bpy.ops.mesh.primitive_plane_add(size=30)
    bpy.ops.object.light_add(type='SUN', rotation=(0.8, 0, 0.5))
    bpy.context.object.data.energy = 3
    return {
        'mark': (0, 0, 0),         # キャラの立つ位置
        'facing': 0,               # キャラの向き(度)
        'bounds': ((-8, 8), (-8, 8), (0.1, 6)),  # カメラが入ってよい範囲
        'char_emission': 0.32,     # キャラの自己発光の強さ
        'beats_per_shot': 8,       # 切り替えの拍数
        'views': {                 # 静止画の視点。target が目標画像の視点、hold は採点に使わない確認用
            'target': {'loc': (0, -5, 0.3), 'look': (0, 0, 1.5), 'lens': 24},
            'hold1': {'loc': (3, -3, 1.2), 'look': (0, 0, 1), 'lens': 35},
            'hold2': {'loc': (-3, -1, 0.5), 'look': (0, 2, 1.4), 'lens': 28},
        },
    }
