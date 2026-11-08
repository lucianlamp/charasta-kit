# 効果音と BGM の出どころ

このキットの `assets/sfx/*.wav` と `assets/bgm/*.m4a` は、作者が `tools/make_sfx.py`、`tools/make_bgm.py` で numpy を使って合成した音です。外部の素材を使っていません。

ショートの合成は、素材が無い効果音(whoosh、pop、impact、glitch の本来の素材と、ドラマ用の音)を、自作の wav で代えるか、鳴らさずに進みます。ドラマ用の音は `tools/make_drama_sfx.mjs` に自分の ElevenLabs の API キーを渡して作り、`assets/sfx/drama/` に置けます。
