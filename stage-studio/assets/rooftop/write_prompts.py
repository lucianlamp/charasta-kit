"""image_gen のプロンプトを prompts/ に書き出す"""
from pathlib import Path

OR = ('Orthographic straight-on elevation, perfectly flat to the picture plane, no perspective convergence, no sky, no ground, '
      'the facade fills the entire frame edge to edge and repeats seamlessly. Photographic night reference plate for a film. '
      'No text, no letters, no logos, no signage.')
TILE = 'Perfectly flat top-down orthographic view, shadowless even lighting, seamlessly tileable on all four edges. No text, no logos, no objects.'
WALL = 'Straight-on, even lighting, seamlessly tileable. No text, no logos.'
P = {
    'f_warm': f'Night photograph of a mid-rise office building facade. Dark charcoal concrete frame with a regular grid of about 28 columns and 28 rows of rectangular windows. About 70 percent of the windows glow warm amber and pale yellow office light with varied brightness, ceiling lights and blinds faintly visible, the rest are dark. {OR}',
    'f_cool': f'Night photograph of a modern glass office tower curtain wall. Tight grid of about 30 columns and 34 rows of glass panels. About half glow cool white and pale blue fluorescent light with varied brightness, others dark navy glass. Thin dark steel mullions. {OR}',
    'f_navy': f'Night photograph of a very tall dark blue glass skyscraper curtain wall. Deep navy reflective glass, thin mullions, about 26 columns and 38 rows of panels. Scattered cool white and icy blue lit office floors, whole bright horizontal bands on a few floors and many isolated lit panels, about 35 percent lit. {OR}',
    'f_apart': f'Night photograph of an urban apartment block facade in a Japanese city. Grey concrete, balconies with railings in a regular grid of about 16 columns and 24 rows, warm curtained windows, about 40 percent lit in orange and yellow, some with white light, the rest dark. {OR}',
    'f_tan': f'Night photograph of an older tan stone office building facade, about 20 columns and 22 rows of tall recessed windows, warm tan masonry faintly lit from below, about 60 percent of the windows glowing warm gold. {OR}',
    'f_mixed': f'Night photograph of a dense downtown commercial building facade: dark panels with rows of warm windows and occasional cold lit floors, a few glowing magenta and cyan strips of light running vertically along the piers, about 24 columns and 26 rows. {OR}',
    'neon': 'Abstract vertical neon light signage for a futuristic Japanese city at night, photographed straight on against a pure black background: tall glowing magenta tubes, hot pink bars, cyan and electric blue bars, purely geometric rectangles and stripes with soft glow. Several separate tall thin rectangular strips side by side. Absolutely no text, no letters, no characters, no kanji, no symbols, no logos.',
    'street': 'Straight down aerial night photograph of a dense city street grid seen from a high building: dark asphalt roads with streams of warm headlights and streetlights, small dark rooftops, glowing haze. Top-down view, no horizon. No text, no logos.',
    'city_far': 'Matte painting for a film: an extremely dense distant night skyline of an original Japanese metropolis seen from far away, thousands of tiny lit windows, hundreds of slim office towers of varied height merging into blue and violet atmospheric haze, warm gold lights low down and faint magenta and cyan neon accents, red aviation lights on a few rooftops. The buildings fill the lower 60 percent of the image, the top of the skyline is uneven. Background behind the buildings is a perfectly flat solid pure chroma green (#00FF00) with no gradient and no clouds. No text, no logos.',
    'sky_base': 'Very dark deep indigo and navy night sky over a big city, seen looking up, faint soft thin high clouds, no stars, smooth photographic gradient, slightly lighter violet haze towards the bottom of the image. Nothing but sky. No text, no logos.',
    'clouds_a': 'Photographic night clouds over a big city: large billowing cumulus cloud masses after rain, softly lit from below by city lights in dusty violet, mauve and rose, dark blue-grey shadowed tops. The clouds stand isolated on a pure solid black background with soft feathered edges, a long horizontal bank spanning the full width with gaps of black between masses. No stars, no buildings, no text.',
    'clouds_b': 'Photographic wispy torn low scud clouds at night, thin streaks and soft fragments, dull violet and slate blue, lit faintly from below by city lights, on a pure solid black background, spanning the full width of the image. No stars, no buildings, no text.',
    'concrete_albedo': f'Albedo texture of an old weathered dark grey roof concrete, coarse exposed aggregate, small pebbles, pitted cement, dark water stains, faint rust and tar marks, soot. Mid-dark value, low contrast. {TILE}',
    'concrete_height': f'Convert the attached concrete texture into a grayscale height map of the same surface: white is the highest pebbles, black is the deepest pits and pores. Keep every pebble and pit at the same position. No shading, no colour. {TILE}',
    'floor_basin': 'Grayscale height map for a large old flat rooftop slab, seen top-down: smooth broad undulations with about seven wide shallow irregular dark basins where rain water collects, organic puddle shapes of varied size with soft rounded outlines, mid grey everywhere else with gentle variation. No lines, no cracks, soft gradients only. Pure grayscale, no text.',
    'floor_cracks': 'Black and white mask of cracks in an old concrete slab, seen top-down: pure white background with thin irregular branching black fracture lines forming large broken polygon slabs, some lines wider, jagged and wandering, small side branches, varied thickness from hairline to wide. No shading, no grey fill. Seamlessly tileable on all four edges. No text.',
    'wall_concrete': f'Weathered wet concrete wall texture, dark grey cast concrete with long vertical black rain streaks and water stains, efflorescence, form tie holes, algae. {WALL}',
    'rust_tank': f'Texture of an old galvanized steel water tank plate, dull grey metal with heavy orange-brown rust streaks running down, peeling paint, dirty water stains. {WALL}',
    'steel_paint': f'Texture of old dark painted structural steel, chipped dark brown-black paint with rust spots, scratches and flaking, orange rust patches. {WALL}',
    'ac_panel': f'Texture of a dirty off-white powder coated sheet metal outdoor air conditioner casing, beige-grey paint, grime streaks, scratches, small dents, slight rust at the edges. {WALL} No vents, no labels.',
    'pipe_metal': f'Texture of a dull weathered galvanized steel pipe surface, grey metal with oxidation mottling, dirty streaks and small rust stains. {WALL}',
}
d = Path(__file__).parent / 'prompts'
d.mkdir(exist_ok=True)
for k, v in P.items():
    (d / f'{k}.txt').write_text(v + '\n', encoding='utf-8')
print(len(P))
