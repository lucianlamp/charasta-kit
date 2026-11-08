# コピーした .blend の外部の画像の場所を、作業場所の inputs/images/ に付け替えて上書き保存する(元の .blend は変えない)。
# blender -b --factory-startup inputs/character.blend --python relink_images.py -- '{"元の filepath": "新しい場所", ...}'
import bpy, json, sys
m = json.loads(sys.argv[sys.argv.index('--') + 1])
n = 0
for im in bpy.data.images:
    if im.filepath in m: im.filepath = m[im.filepath]; n += 1
bpy.context.preferences.filepaths.save_version = 0   # .blend1 の控えを作らない
bpy.ops.wm.save_mainfile()
print('RELINKED', n)
