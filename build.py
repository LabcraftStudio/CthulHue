#!/usr/bin/env python3
"""Build index.html, the whole app as one page, from the files in src/.

Usage:  python3 build.py

The app is plain JavaScript with no build tools: this script only pastes the
source files into src/app.html where its <!--CORE-->, <!--TEMPLATE--> and
<!--APP--> markers are. Libraries load from ./lib, so the page makes no
requests to other sites. Serve the folder with any static web server, e.g.
`python3 -m http.server`, and open http://localhost:8000/.
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def read(*parts):
    with open(os.path.join(ROOT, 'src', *parts), encoding='utf-8') as f:
        return f.read()


page = read('app.html')
core = read('js', 'core.js')
app = read('js', 'app.js')
mixer = read('js', 'mixer.js') + '\n' + read('js', 'sample.js')
data = read('data', 'bambu-measured-mixes.js') + '\n' + read('data', 'swatch-tiles.js')
catalog = read('data', 'catalog-polymaker.js') + '\n' + read('data', 'catalog-bambu.js')
templates = read('data', 'template-bambu.js') + '\n' + read('data', 'template-snorca.js')

# A literal "</script" inside a script would end the inlined <script> tag early.
for name, s in [('core', core), ('app', app), ('mixer', mixer), ('data', data), ('catalog', catalog), ('templates', templates)]:
    assert '</script' not in s.lower(), name

page = (page
        .replace('<!--CORE-->', '<script id="coreSrc">\n' + core + '\n</script>\n<script>\n' + data + '</script>\n<script>\n' + catalog + '</script>\n<script>\n' + mixer + '\n</script>')
        .replace('<!--TEMPLATE-->', '<script>\n' + templates + '</script>')
        .replace('<!--APP-->', '<script type="module">\n' + app + '\n</script>'))

# src/ is written for the Claude-hosted copy, which loads libraries from CDNs and
# large files from artifact storage (/_blob/...). The public site serves its own copies.
LOCAL = {
    'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js': './lib/three/three.module.min.js',
    'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/': './lib/three/addons/',
    'https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.8.3/build/index.module.js': './lib/three-mesh-bvh/index.module.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js': './lib/jszip/jszip.min.js',
    "['/_blob/fc0e6c54b04e1c9bef016373001a4fb5', 'swatches/CthulHue-swatch-prints.zip']": "['swatches/CthulHue-swatch-prints.zip']",
    "['/_blob/220e57c94cc6b0ca291e464433ece6c5', 'samples/octopus.zip']": "['samples/octopus.zip']",
}
for cdn, local in LOCAL.items():
    assert cdn in page, cdn
    page = page.replace(cdn, local)
assert 'cdn.jsdelivr' not in page and 'cdnjs' not in page and '/_blob/' not in page

with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(page)
print('index.html', len(page), 'characters')
