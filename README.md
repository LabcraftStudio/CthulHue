# CthulHue

**Paint 3D models for multicolor printing, right in your browser.**
Open a model, paint it with your filaments and color mixes, and export a project that opens already painted in your slicer.

**Use it here: https://labcraftstudio.github.io/CthulHue/**

Made for iPad and Apple Pencil, and works with a mouse on a computer too. By Sarah at Labcraft Studio.

## What it does

- **Paint** with a hard or soft brush (Apple Pencil pressure supported), fill whole areas, or select a shape and paint inside it.
- **Mix colors.** Make new colors from your filaments, the way Bambu Studio and Full Spectrum print them: thin alternating layers. Start from Bambu's measured mixes or from predicted mixes of your own filaments.
- **Shade.** Soft brush and gradient fills turn into printable shading made of mixes.
- **Project images** onto the model and turn them into your filament colors.
- **Export** a ready-to-print project for:
  - **Bambu Studio** (AMS printers like the H2C and H3C), with Bambu's mixed filaments
  - **Snapmaker Orca** 2.3.3 or newer (Snapmaker U1) with Full Spectrum mixed filaments. The file also opens in the [Full Spectrum fork](https://github.com/ratdoux/OrcaSlicer-FullSpectrum), for other toolchangers like the Flashforge Creator 5.
- **Swatch tiles:** printable, numbered tiles for all 290 Bambu PLA Palette (CMYKW) mixes, with frames. In the app: New mix → "Print these as swatch tiles".

## Your files stay with you

Everything runs on your device. Models and images are never uploaded, and the app doesn't track you. Settings (your palette, theme and printer) are saved in your browser only.

## Quick start

1. **Open a model:** an STL, or a Bambu Studio 3MF (its paint and filaments come with it). Or tap *Try a sample*.
2. **Choose your printer** at the bottom of the Filaments panel: *Bambu AMS* or *Toolchanger*.
3. **Set your filaments.** *+ Add filament* has Bambu PLA and Polymaker Panchroma colors, or any custom color. *+ New mix* makes a mixed color.
4. **Paint.** Pick a color in the Filaments panel, then use Brush, Fill, Image or Select. Pencil paints; fingers turn and zoom. The view cube in the corner snaps to front, side and top views.
5. **Export 3MF** and open the file in your slicer. Set your real filament presets there before printing.

Tips:
- Mixed colors look best on walls and slopes. On flat tops and undersides you mostly see the outermost layer.
- For toolchangers, thin layers (0.08–0.12 mm) and translucent filaments blend best.
- Mix colors are predictions. Print the swatch tiles to see the real thing.

## Built on

- [three.js](https://threejs.org) (MIT), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) by Garrett Johnson (MIT), [JSZip](https://stuk.github.io/jszip/) (MIT). Copies are in `lib/` with their licenses.
- [Bambu Studio](https://github.com/bambulab/BambuStudio) by Bambu Lab (AGPL-3.0): measured mix colors, Bambu filament names and colors, the mixed-filament 3MF format.
- FilamentMixer color mixing by Justin Hayes (MIT), as included in Bambu Studio and Snapmaker Orca.
- Polymaker Panchroma colors as published by Polymaker.
- The sample octopus (`samples/octopus.zip`) was modeled by Sarah at Labcraft Studio.

Not affiliated with or endorsed by Bambu Lab, Snapmaker, Flashforge or Polymaker. Product names are their owners' trademarks.

Designed by Sarah at Labcraft Studio. Built with Claude, an AI model made by Anthropic.

## For developers

CthulHue is plain JavaScript with no framework and no package manager. The page in the repository
root, `index.html`, is generated: edit the files in `src/`, then run

```
python3 build.py
python3 -m http.server   # then open http://localhost:8000/
```

### How the code is organized

| File | What it does |
| --- | --- |
| `src/app.html` | Page shell: markup and CSS for every panel and sheet. Night mode overrides the CSS colour variables. |
| `src/js/core.js` | No-UI functions (`LabCore`): STL/3MF import, the `paint_color` codec, mesh topology and refinement, editing filament settings, shading patterns and 3MF export. Runs in Node too. |
| `src/js/app.js` | The interface: 3D view (three.js), tools, palette and mix editor, undo, image projection, Bambu and Snapmaker export. Starts with a map of its sections. |
| `src/js/mixer.js` | Mix colour prediction (`LabMix`): Bambu's measured mixes, then the FilamentMixer formula that Bambu Studio and Snapmaker Orca also use. |
| `src/js/sample.js` | Backup "Try a sample" octopus, built procedurally if `samples/octopus.zip` can't load. |
| `src/data/` | Data, not to be edited by hand: Bambu's measured mixes, filament catalogs, swatch tile numbers and the Bambu Studio and Snapmaker Orca project templates. Each file says where it came from. |
| `lib/` | three.js, three-mesh-bvh and JSZip, with their licenses. |

### Things that are easy to get wrong

- **Slicers only load mixes from their own projects.** Bambu Studio needs the 3MF's Application
  metadata to start with `BambuStudio-`, Snapmaker Orca with `Snapmaker_Orca-`. Anything else
  silently loads mixes as plain filaments.
- **Paint is one 1-based filament slot per triangle**, written as `paint_color` codes (slot 1 = `4`,
  2 = `8`, 3+ = `<n-3>C`). Bambu requires every real spool before every mix, so adding a filament
  renumbers the paint (`remapSlots` in app.js).
- **Mixes:** Bambu stores them in the filament arrays (`filament_is_mixed`, up to 3 filaments, 64
  mixes). Snapmaker Orca stores them in `mixed_filament_definitions`, numbered after the 4 heads.
- **Shading prints as patterns of mixes**: horizontal stripes on walls and dots on flat faces
  (`shadeThreshold` in core.js), because tiny specks printed bumpy.
- **The Outline and Parts tools** are still in the code but have no toolbar buttons since v1.

Contributions are welcome under the same license. Please open an issue first for big changes.

## Problems and ideas

Please [open an issue](https://github.com/LabcraftStudio/CthulHue/issues).

## License

CthulHue is free software under the [GNU Affero General Public License v3.0](LICENSE). You may use, study, change and share it. If you share a changed version, including running it as a website, you must share its source code under the same license.

The app is a single page, `index.html`. The swatch tile files are in `swatches/`.
