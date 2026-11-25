# For developers

CthulHue is plain JavaScript with no framework and no package manager. The page in the repository root, `index.html`, is generated: edit the files in `src/`, then run

```
python3 build.py
python3 -m http.server   # then open http://localhost:8000/
```

## How the code is organized

| File | What it does |
| --- | --- |
| `src/app.html` | Page shell: markup and CSS for every panel and sheet. Night mode overrides the CSS colour variables. |
| `src/js/core.js` | No-UI functions (`LabCore`): STL/3MF import, the `paint_color` codec, mesh topology and refinement, editing filament settings, shading patterns and 3MF export. Runs in Node too. |
| `src/js/app.js` | The interface: 3D view (three.js), tools, palette and mix editor, undo, image projection, Bambu and Snapmaker export. Starts with a map of its sections. |
| `src/js/mixer.js` | Mix colour prediction (`LabMix`): Bambu's measured mixes, then the FilamentMixer formula that Bambu Studio and Snapmaker Orca also use. |
| `src/js/sample.js` | Backup "Try a sample" octopus, built procedurally if `samples/octopus.zip` can't load. |
| `src/data/` | Data, not to be edited by hand: Bambu's measured mixes, filament catalogs, swatch tile numbers and the Bambu Studio and Snapmaker Orca project templates. Each file says where it came from. |
| `lib/` | three.js, three-mesh-bvh and JSZip, with their licenses. |
| `docs/` | These help pages, in Markdown. They are the source for both the help site and the GitHub wiki (see below). |

## Things that are easy to get wrong

- **Slicers only load mixes from their own projects.** Bambu Studio needs the 3MF's Application metadata to start with `BambuStudio-`, Snapmaker Orca with `Snapmaker_Orca-`. Anything else silently loads mixes as plain filaments.
- **Paint is one 1-based filament slot per triangle**, written as `paint_color` codes (slot 1 = `4`, 2 = `8`, 3+ = `<n-3>C`). Bambu requires every real spool before every mix, so adding a filament renumbers the paint (`remapSlots` in app.js).
- **Mixes:** Bambu stores them in the filament arrays (`filament_is_mixed`, up to 3 filaments, 64 mixes). Snapmaker Orca stores them in `mixed_filament_definitions`, numbered after the 4 heads.
- **Shading prints as patterns of mixes**: horizontal stripes on walls and dots on flat faces (`shadeThreshold` in core.js), because tiny specks printed bumpy.
- **The Outline and Parts tools** are still in the code but have no toolbar buttons since v1.

## The help pages

The help lives in `docs/` as Markdown, one file per page. The same files feed two places:

- **The help site** at https://labcraftstudio.github.io/CthulHue/help/. `python3 build_help.py` turns `docs/*.md` into `help/*.html` (no extra packages needed). Commit both.
- **The GitHub wiki.** The wiki is its own git repository. To update it, copy the pages over and push:

```
git clone https://github.com/LabcraftStudio/CthulHue.wiki.git
cp docs/*.md CthulHue.wiki/
mkdir -p CthulHue.wiki/images && cp docs/images/* CthulHue.wiki/images/
cd CthulHue.wiki && git add -A && git commit -m "Update help" && git push
```

Links between pages are written without an extension, like `[Toolchangers](Toolchangers)`, which works in the wiki; `build_help.py` adds `.html` for the site. `_Sidebar.md` and `_Footer.md` are only used by the wiki.

## Contributing

Contributions are welcome under the same license (AGPL-3.0). Please [open an issue](https://github.com/LabcraftStudio/CthulHue/issues) first for big changes.
