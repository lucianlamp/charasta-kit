"""2 回目の image_gen のプロンプトと、手前の亀裂の下絵を書き出す"""
from pathlib import Path

from PIL import Image, ImageDraw

OR = ('Orthographic straight-on elevation, perfectly flat to the picture plane, no perspective convergence, no sky, no ground, '
      'the facade fills the entire frame edge to edge and repeats seamlessly. Photographic night reference plate for a film. '
      'No text, no letters, no logos, no signage.')
P = {
    'r_navy': f'Night photograph of a very tall office tower facade. The building body is almost black dark navy glass and dark spandrel panels. Lights form horizontal rows: long continuous ribbons of lit windows along whole floors, each floor a separate horizontal strip, cool white and pale blue, about 36 floors in the image, with whole dark floors between groups of lit floors. Small dark mullions divide each ribbon into about 24 windows. {OR}',
    'r_warm': f'Night photograph of an office tower facade. Dark brown-black body with horizontal rows of warm amber windows, floor by floor, about 30 floors in the image and about 18 windows per floor. Roughly half of the floors are lit as continuous rows, the other floors are mostly dark with a few lit windows. {OR}',
    'r_ice': f'Night photograph of a slim glass tower facade. Dark teal-black glass body, thin vertical fins, narrow horizontal bands of pale icy cyan light on about 34 floors, with long dark sections between groups of bright floors. {OR}',
    'r_sparse': f'Night photograph of a dark office building late at night. Almost black facade with about 28 floors and 16 windows per floor. Only about 15 percent of the windows are lit, in pale white and soft yellow, in small clusters along the same floor. {OR}',
    'r_low': f'Night photograph of a low dark city building facade from the side street: dark grey concrete and small windows, about 12 floors and 10 windows per floor, a few warm lit windows, dim air conditioner units, pipes and small balconies. {OR}',
    'sky_base2': 'Smooth deep navy blue night sky over a city, the colour is a calm dark blue around hex 0E1D3A, slightly lighter steel blue haze towards the bottom of the image, very soft faint high cloud veils, no stars, no moon. Nothing but sky. No text, no logos.',
    'clouds_c': 'Large soft out-of-focus night clouds, huge smooth flowing volumes with blurred feathered edges and very gentle shading, grey-violet and cool slate tones, low contrast, no small puffy detail, no hard edges, seen against a pure solid black background. A long flowing cloud bank that rises from the left side and trails away to the right, with a smaller separate soft mass at the far right. No stars, no buildings, no text.',
    'clouds_d': 'Very soft thin veils of night haze and stratus, smooth blurred streaks, pale grey-blue, low contrast, against a pure solid black background, spanning the full width. No stars, no buildings, no text.',
    'wall_plain': 'Weathered smooth cast concrete wall texture, even mid grey, faint mottled damp patches, small dark stains and fine hairline cracks, small tie holes on a wide regular grid. No strong vertical streaks, no planks, no boards. Straight-on, even lighting, seamlessly tileable. No text, no logos.',
    'near_cracks': 'Redraw the attached rough sketch as a realistic black and white mask of deep fractures in an old concrete slab seen from straight above. Keep every thick black line exactly in its position and direction, make each one an irregular jagged wandering crack with varying width, add thin hairline branches leaving the main cracks. Pure white background, pure black cracks, no grey, no shading. No text.',
}
d = Path(__file__).parent
for k, v in P.items():
    (d / 'prompts' / f'{k}.txt').write_text(v + '\n', encoding='utf-8')

# 目標の画素で読んだ亀裂の経路を、真上から見た手前の床の下絵にする
H, F = 825.0, 1050.0
PATCH = (-1.6, 1.6, -4.7, -1.5)


def G(px, py):
    z = .5 * F / (py - H)
    return (px - 470.5) / F * z, -5 + z


LINES = [
    [(150, 1365), (340, 1385), (490, 1440), (560, 1385), (640, 1350)],
    [(450, 1160), (570, 1240), (640, 1350)],
    [(790, 1270), (850, 1320), (930, 1490), (900, 1640)],
    [(0, 1500), (30, 1520), (150, 1590), (330, 1560), (490, 1440)],
    [(515, 940), (620, 1020), (560, 1120), (450, 1160), (300, 1200), (120, 1260), (0, 1270)],
    [(330, 1560), (230, 1672)],
    [(640, 1350), (790, 1270), (900, 1210)],
    [(150, 1365), (60, 1420), (0, 1430)],
]
S = 1254
im = Image.new('L', (S, S), 255)
dr = ImageDraw.Draw(im)
for ln in LINES:
    pts = []
    for px, py in ln:
        x, y = G(px, py)
        pts.append(((x - PATCH[0]) / (PATCH[1] - PATCH[0]) * S, (1 - (y - PATCH[2]) / (PATCH[3] - PATCH[2])) * S))
    dr.line(pts, fill=0, width=5)
im.save(d / 'near_sketch.png')
print(len(P))
