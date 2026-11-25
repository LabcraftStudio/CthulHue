# CthulHue

**Paint 3D models for multicolor printing, right in your browser.**
Open a model, paint it with your filaments and color mixes, and export a project that opens already painted in your slicer.

**Use it here: https://labcraftstudio.github.io/CthulHue/**

**Help and guides: https://labcraftstudio.github.io/CthulHue/help/** (also in this repository's [wiki](https://github.com/LabcraftStudio/CthulHue/wiki))

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

More in the [Getting started guide](https://labcraftstudio.github.io/CthulHue/help/Getting-started.html).

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

CthulHue is plain JavaScript with no framework and no package manager. Edit the files in `src/`, then run

```
python3 build.py        # builds index.html, the app
python3 build_help.py   # builds help/ from the Markdown pages in docs/
python3 -m http.server  # then open http://localhost:8000/
```

How the code is organized, the parts that are easy to get wrong, and how the wiki is updated: see [For developers](https://labcraftstudio.github.io/CthulHue/help/For-developers.html) (source: `docs/For-developers.md`).

Contributions are welcome under the same license. Please open an issue first for big changes.

## Problems and ideas

Please [open an issue](https://github.com/LabcraftStudio/CthulHue/issues).

## License

CthulHue is free software under the [GNU Affero General Public License v3.0](LICENSE). You may use, study, change and share it. If you share a changed version, including running it as a website, you must share its source code under the same license.

The app is a single page, `index.html`. The help site is in `help/` (built from `docs/`), and the swatch tile files are in `swatches/`.
