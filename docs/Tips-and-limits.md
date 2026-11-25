# Tips and known limits

## What prints well

- **Mixed colors and shading look best on walls and slopes.** A mix is made of alternating layers, and on a wall you see the edge of every layer, so the colors blend. On a flat top or an underside you mostly see just the outermost layer, so the mix can look like one of its filaments instead.
- **Thin layers blend better.** 0.08 to 0.12 mm layers make mixes look smoother.
- **Print the swatch tiles** before a big project. Mix colors on screen are predictions; the tiles show the real thing with your filaments.
- **Simple artwork beats photos** for the Image tool. Logos and flat-color drawings come out crisp.
- **Run Check before exporting.** Cleaning up tiny color islands saves filament swaps and print time.

## Known limits

- **Mixes on downward-facing surfaces break up**, because only the bottom layer shows. The same goes for flat tops.
- **Bambu's Smooth up/down gradient** always spans the whole height of the painted area.
- **Image projection:**
  - Photos come out posterized, since every pixel has to become a filament or a mix. There's no dithering yet.
  - Surfaces that slope away from you stretch the image.
  - There's no wrap-around projection; apply from several sides instead.
- **View cube:** turntable mode can't roll the view, and a straight top view always keeps FRONT at the bottom. Turn on **Free rotate** if you need to.
- **Mesh size:** refining stops at about 3 million triangles so iPads and phones don't run out of memory.

## Ideas on the list

- Optional dithering for photos
- Wrapping an image around a cylinder

Have an idea? [Open an issue](https://github.com/LabcraftStudio/CthulHue/issues).
