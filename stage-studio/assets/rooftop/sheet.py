"""out/rooftop の画像を横に並べる。python sheet.py 出力 高さ 画像...  確認用"""
import sys

from PIL import Image

out, h = sys.argv[1], int(sys.argv[2])
ims = [Image.open(f).convert('RGB') for f in sys.argv[3:]]
ims = [i.resize((round(i.width * h / i.height), h)) for i in ims]
sh = Image.new('RGB', (sum(i.width for i in ims), h))
x = 0
for i in ims:
    sh.paste(i, (x, 0))
    x += i.width
sh.save(out, quality=90)
print(sh.size)
