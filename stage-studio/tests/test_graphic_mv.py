"""グラフィックの MV(tools/graphic_mv、tools/make_graphic_mv.py)のテスト。Blender は使わない。
    python -m unittest tests/test_graphic_mv.py
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))

from graphic_mv import plan as Pl  # noqa: E402
from graphic_mv.compose import compose  # noqa: E402
from graphic_mv.core import Clock, Palette, check_color, fit, text  # noqa: E402
from graphic_mv.scenes import NOMINAL, SCENES  # noqa: E402

V12 = ['intro', 'name', 'move', 'feel', 'triple', 'face', 'kick', 'dance', 'end']


def run(*args, cwd=ROOT):
    return subprocess.run([sys.executable, str(ROOT / 'tools' / 'make_graphic_mv.py'), *args], cwd=cwd, capture_output=True, text=True, encoding='utf8')


class PlanTest(unittest.TestCase):
    def test_count_and_ends(self):
        p = Pl.make_plan(18, 120, seed=3)
        self.assertEqual(len(p), 9)  # 36 拍 / 4
        self.assertEqual(p[0]['scene'], 'intro')
        self.assertEqual(p[-1]['scene'], 'end')
        self.assertEqual(p[0]['start'], 0)
        self.assertAlmostEqual(p[-1]['end'], 18)
        self.assertIsNone(p[0]['wipe'])
        for a, b in zip(p, p[1:]):
            self.assertAlmostEqual(a['end'], b['start'])
            self.assertNotEqual(a['scene'], b['scene'])
        self.assertEqual(len(Pl.make_plan(10, 96)), 4)  # 16 拍
        self.assertEqual(len(Pl.make_plan(3, 120)), 2)  # 短くても INTRO と END

    def test_seed_changes_order(self):
        a = [e['scene'] for e in Pl.make_plan(18, 120, seed=1)]
        b = [e['scene'] for e in Pl.make_plan(18, 120, seed=2)]
        self.assertNotEqual(a, b)
        self.assertEqual(a, [e['scene'] for e in Pl.make_plan(18, 120, seed=1)])
        self.assertEqual([e['scene'] for e in Pl.make_plan(18, 120, seed=0)], V12)
        self.assertEqual(sorted(a[1:-1]), sorted(V12[1:-1]))

    def test_long_video_repeats_without_neighbours(self):
        p = [e['scene'] for e in Pl.make_plan(60, 120, seed=5)]
        self.assertEqual(len(p), 30)
        self.assertTrue(all(x != y for x, y in zip(p, p[1:])))

    def test_beats_list(self):
        beats = [0.25 + 0.5 * i for i in range(60)]
        p = Pl.make_plan(18, beats=beats)
        self.assertEqual(p[0]['start'], 0)
        self.assertAlmostEqual(p[1]['start'], 0.25 + 4 * 0.5)
        self.assertAlmostEqual(p[-1]['end'], 18)

    def test_words_fill_slots_in_order(self):
        p = Pl.make_plan(18, 120, seed=0)
        got = {e['scene']: e['words'] for e in p}
        self.assertEqual(got['move'], ['MOVE', 'STEP', 'TURN'])
        self.assertEqual(got['feel'], ['FEEL', 'BEAT'])
        self.assertEqual(got['face'], ['RHYTHM'])
        self.assertEqual(got['kick'], ['KICK'])
        self.assertEqual(got['dance'], ['DANCE'])
        self.assertEqual(got['intro'], [])

    def test_from_cuts(self):
        cuts = [{'scene': s, 'seconds': 2} for s in V12]
        cuts[2]['word'] = 'KAWAII / CUTE / POP'
        p = Pl.from_cuts(cuts, 18, 120)
        self.assertEqual([e['b0'] for e in p], [0, 4, 8, 12, 16, 20, 24, 28, 32])
        self.assertEqual(p[2]['words'], ['KAWAII', 'CUTE', 'POP'])
        self.assertEqual(p[3]['words'], ['FEEL', 'BEAT'], '手で書いた枠のあとも、配る順は場面の位置で決まる')
        with self.assertRaises(ValueError):
            Pl.from_cuts(cuts, 20, 120)
        with self.assertRaises(ValueError):
            Pl.from_cuts([{'scene': 'nope', 'seconds': 18}], 18, 120)


class FramesTest(unittest.TestCase):
    def test_v12_passes(self):
        p = Pl.make_plan(18, 120, seed=0)
        need = Pl.needed_frames(p, 18, 120)
        # 試作 v12 で手で書いた範囲。全身は v12 では 1-510 を続けて描いたが、全身を使うのは INTRO(1-60)と MOVE から DANCE(121-480)と、
        # その前のワイプの重なりと残像の戻りだけなので、NAME と FACE の間と END は含まない
        self.assertTrue(set(range(1, 61)) | set(range(113, 301)) | set(range(345, 482)) <= need["full"])
        self.assertFalse(set(range(80, 100)) & need['full'])
        self.assertTrue(set(range(48, 127)) | set(range(468, 541)) <= need['mid'])
        self.assertTrue(set(range(286, 367)) <= need['face'])
        self.assertLess(len(need['face']), 120)
        self.assertEqual(max(need['mid']), 540)

    def test_ranges(self):
        self.assertEqual(Pl.ranges({1, 2, 3, 7, 9, 10}), '1-3,7,9-10')
        self.assertEqual(Pl.parse_ranges('1-3,7,9-10'), {1, 2, 3, 7, 9, 10})


class ClockTest(unittest.TestCase):
    def test_bpm(self):
        c = Clock(120)
        self.assertAlmostEqual(c.beat(2.0), 4)
        self.assertAlmostEqual(c.time(4), 2.0)

    def test_beats(self):
        c = Clock(beats=[0.25, 0.75, 1.25, 1.75])
        self.assertAlmostEqual(c.beat(0.75), 1)
        self.assertAlmostEqual(c.beat(0.0), -0.5)
        self.assertAlmostEqual(c.beat(2.25), 4)
        self.assertAlmostEqual(c.time(1.5), 1.0)
        self.assertAlmostEqual(c.time(-0.5), 0.0)
        self.assertAlmostEqual(c.time(5), 2.75)


class TextAndColorTest(unittest.TestCase):
    def test_long_title_fits(self):
        long = text('アイウエオカキクケコサシスセソ', 'dela', 140, '#000000')
        self.assertGreater(long.width, 1000)
        self.assertLessEqual(long.width * fit(long, 1000), 1000)
        short = text('ナ', 'dela', 140, '#000000')
        self.assertEqual(fit(short, 1000), 1.0)
        v = text('ナースの子ナースの子', 'dela', 240, '#000000', vertical=True)
        self.assertLessEqual(v.height * fit(v, 280, 880), 880.5)

    def test_color(self):
        self.assertEqual(check_color('#ff2d87'), '#FF2D87')
        for bad in ('red', '#FFF', '#GG0000', None, '#1234567'):
            with self.assertRaises(ValueError):
                check_color(bad)
        with self.assertRaises(ValueError):
            Palette({'bg': ['#000000', '#111111'], 'ink': '#000000', 'accent': '#000000', 'light': '#FFFFFF'})
        Palette({'bg': ['#000000', '#111111', '#222222'], 'ink': '#000000', 'accent': '#FF0000', 'light': '#FFFFFF'})


def fake_dancer(root, frames):
    """透明な背景に楕円の人を描いた連番と、顔の位置の記録"""
    res = {'full': (1620, 1920), 'mid': (1440, 1920), 'face': (1440, 1920)}
    for pas, (w, h) in res.items():
        (root / pas).mkdir(parents=True)
        meta = {'pass': pas, 'res': [w, h], 'frames': {}}
        for f in frames:
            im = Image.new('RGBA', (w // 2, h // 2), (0, 0, 0, 0))  # 試しは半分の大きさで描く
            d = ImageDraw.Draw(im)
            d.ellipse((w // 2 * 0.3, h // 2 * 0.25, w // 2 * 0.7, h // 2), fill=(200, 80, 80, 255))
            d.ellipse((w // 2 * 0.4, h // 2 * 0.05, w // 2 * 0.6, h // 2 * 0.25), fill=(240, 200, 180, 255))
            im.save(root / pas / f'{f:05d}.png')
            meta['frames'][str(f)] = {'face': (0.5, 0.15), 'hips': (0.5, 0.6), 'skirt': False, 'crotch': 0}
        (root / f'{pas}.json').write_text(json.dumps(meta))


class ComposeTest(unittest.TestCase):
    def test_three_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            frames = list(range(1, 541))
            fake_dancer(tmp / 'dancer', frames)
            plan = Pl.make_plan(18, 120, seed=0)
            cfg = {'dancer': str(tmp / 'dancer'), 'plan': plan, 'bpm': 120, 'beats': None, 'text': {'title': 'ナースの子', 'titleEn': 'NURSE', 'credit': "DANCE  ILLIT IT'S ME"},
                   'palette': None, 'frames_dir': str(tmp / 'frames'), 'comp_w': 540, 'comp_h': 960}
            # 2 秒(NAME の頭)、10.8 秒(FACE)、17.5 秒(END)
            r = compose(cfg, [61, 325, 526], jobs=1)
            for f in (61, 325, 526):
                im = Image.open(tmp / 'frames' / f'{f:05d}.png')
                self.assertEqual(im.size, (540, 960))
                self.assertGreater(len(set(im.convert('L').resize((54, 96)).getdata())), 8, '空でない')
            self.assertIsInstance(r['faceHits'], list)
            self.assertTrue(all(h > 0 for _, h in r['faceHits']))

    def test_every_scene_draws(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            fake_dancer(tmp / 'dancer', range(1, 31))
            from graphic_mv.compose import ctx_for, setup
            setup({'dancer': str(tmp / 'dancer'), 'plan': Pl.make_plan(18, 120, seed=0), 'bpm': 120, 'text': {'title': 'とても長いキャラクターの名前です', 'titleEn': 'AVERYLONGCHARACTERNAME', 'credit': 'DANCE  X'}})
            for sid in SCENES:
                e = {'scene': sid, 'b0': 0, 'words': ['SUPERCALIFRAGI', 'X', 'Y']}
                c = ctx_for(e)
                img = SCENES[sid](c, 0.5, c.beat(0.5) + 3)
                self.assertEqual(img.size, (1080, 1920), sid)
            self.assertEqual(set(NOMINAL), set(SCENES))


class CliTest(unittest.TestCase):
    def test_catalog(self):
        r = run('--catalog')
        self.assertEqual(r.returncode, 0, r.stderr)
        cat = json.loads(r.stdout)
        self.assertEqual([c['id'] for c in cat], V12)
        for c in cat:
            self.assertTrue({'id', 'label', 'name', 'passes', 'words', 'wipe'} <= set(c))

    def test_plan_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = Path(tmp) / 'spec.json'
            spec.write_text(json.dumps({'char': 'nurse', 'ver': 'v12-slim', 'motion': 'm', 'seconds': 18, 'bpm': 120, 'seed': 0, 'text': {'words': ['A', 'B']}}))
            r = run('--plan-only', '--spec', str(spec))
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out['source'], 'bpm')
            self.assertEqual(out['frames'], 540)
            self.assertEqual([e['scene'] for e in out['plan']], V12)
            self.assertEqual(out['plan'][2]['words'], ['A', 'B', 'A'])
            self.assertEqual(set(out['passes']), {'full', 'mid', 'face'})
            spec.write_text(json.dumps({'seconds': 18, 'palette': {'bg': ['#FFF', '#000000', '#000000'], 'ink': '#000000', 'accent': '#000000', 'light': '#000000'}}))
            r = run('--plan-only', '--spec', str(spec))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn('#RRGGBB', r.stderr)


if __name__ == '__main__':
    unittest.main()
