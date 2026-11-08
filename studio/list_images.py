# .blend が読む画像の一覧を 1 行の JSON で出す(表情づくりの「材料をコピー」が、取り込んで固めていない外部の画像を探すのに使う)。
# blender -b --factory-startup character.blend --python list_images.py   ->  IMAGES [{"name", "filepath", "abs", "packed"}]
import bpy, json
out = [{'name': im.name, 'filepath': im.filepath, 'abs': bpy.path.abspath(im.filepath) if im.filepath else '', 'packed': bool(im.packed_file)}
       for im in bpy.data.images if im.source in ('FILE', 'SEQUENCE', 'TILED')]
print('IMAGES ' + json.dumps(out))
