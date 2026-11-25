# FAQ and troubleshooting

## General

**Is it free?**
Yes. CthulHue is free software under the AGPL-3.0 license.

**Are my models uploaded anywhere?**
No. Everything runs on your device. Models and images never leave it, and the app doesn't track you. Your palette, theme and printer choice are saved in your browser only.

**Do I need an iPad?**
No. It's designed for iPad and Apple Pencil, but works in a desktop browser with a mouse. Without a Pencil on a tablet, turn on **Fingers paint**.

**Does it work offline?**
Once the page has loaded, painting and exporting don't need the internet. **Try a sample** and the swatch tile download do.

**Is there a night mode?**
Yes: the sun/moon switch next to the logo at the top left.

## Opening models

**Which files can I open?**
STL, and 3MF projects from Bambu Studio. Convert other formats (OBJ, STEP) to STL or 3MF in your slicer first.

**My 3MF opened without some of its parts.**
Modifier parts (the ones that change print settings in an area) are left out on purpose. Only printable parts are painted.

**Painting is slow on a big model.**
Very detailed models (millions of triangles) are heavy for a tablet browser. Try simplifying the model in your modeling program or slicer first.

**The color edges look blocky.**
The model has big triangles. Use **Refine mesh** at the bottom of the Tools panel, or **Smooth edges** after painting.

## Painting

**My fingers turn the model instead of painting.**
That's the default, so you can paint with the Pencil and turn with your fingers. Turn on **Fingers paint** to paint with a finger.

**Fill colored more (or less) than I expected.**
Fill spreads over one color only. To stop at a fold in the surface, turn on **Also stop at sharp edges**. To fill a color together with its shading, turn on **Shading counts as one color**. Or make a selection first; fill stays inside it.

**I can't paint outside an area.**
Something is selected. Tap **Done** on the bar at the bottom of the screen.

**My palette is full of shade mixes.**
Use **Remove N unused shades** on each shading group in the Filaments panel. Fewer **Shade steps** make fewer mixes.

**"Bambu Studio allows 64 mixes and this would go over."**
Remove unused mixes, or use fewer shade steps.

## Exporting and printing

**The file opens in Bambu Studio but the mixes are plain filaments.**
Make sure the file came straight from CthulHue's **Export 3MF** and wasn't re-saved by another program. Slicers only load mixes from their own kind of project.

**My mixed colors look different from the screen.**
Mix colors are predictions. Filament brand, layer height and lighting all change the result, and mixes look best on walls (see [Tips and known limits](Tips-and-limits)). Print the [swatch tiles](Filaments-and-mixes#swatch-tiles) to see the real colors.

**Can I upload a model with mixes to MakerWorld?**
Not yet; MakerWorld doesn't accept files with mixed filaments.

**Export asks me to set up 4 toolheads.**
In Toolchanger mode your palette can only have 4 real filaments, one per head. Pick the 4 to load and CthulHue swaps any other colors for the closest mix. See [Toolchangers](Toolchangers).

**The download is a .3mf.zip.**
That only happens in the copy that runs inside Claude. Rename the file to end in `.3mf`. See [Exporting](Exporting#exporting-from-inside-claude).

## Still stuck?

[Open an issue](https://github.com/LabcraftStudio/CthulHue/issues) with your device, browser, what you tried, and the model if you can share it.
