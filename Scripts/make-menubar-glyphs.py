#!/usr/bin/env python3
"""Cut the menu-bar glyphs out of the app icon.

The app icon and the menu-bar glyph are two artworks, not one file used twice: the icon is a
mint mark on a dark ground, the glyph must be alpha-only so macOS can tint it for light mode,
dark mode and a highlighted menu. Both come from the same nib so they read as the same product.

Three states, because the glyph is the whole status display: the split nib idle, the nib solid
while listening, the nib slashed when something is blocking dictation.

    python3 Scripts/make-menubar-glyphs.py
"""

from pathlib import Path
from PIL import Image, ImageDraw
import json

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "Apps/macOS/Assets.xcassets"
SOURCE = CATALOG / "AppIcon.appiconset/icon_512x512.png"

CANVAS = 512          # supersampled; every glyph is downsampled from here
MARK_HEIGHT = 0.88    # of the canvas, leaving the breathing room the menu bar expects
# 1x and 2x only: the mac idiom has no 3x, and a third entry is a build warning, not a
# sharper icon.
SIZES = {"": 18, "@2x": 36}


def mark_alpha() -> Image.Image:
    """The nib alone, as an alpha mask cropped to its bounding box."""
    icon = Image.open(SOURCE).convert("RGB")
    # The mark is the light half of a two-colour icon, so a luminance split separates it
    # exactly — no hand-traced polygons to drift out of sync with the artwork.
    mask = icon.convert("L").point(lambda v: 255 if v > 96 else 0)
    return mask.crop(mask.getbbox())


def place(mark: Image.Image, height: float = MARK_HEIGHT) -> Image.Image:
    """Centre the mark on a square canvas at the height a menu-bar glyph wants."""
    h = int(CANVAS * height)
    w = max(1, round(mark.width * h / mark.height))
    canvas = Image.new("L", (CANVAS, CANVAS), 0)
    canvas.paste(mark.resize((w, h), Image.LANCZOS), ((CANVAS - w) // 2, (CANVAS - h) // 2))
    return canvas


def filled(mark: Image.Image) -> Image.Image:
    """The same silhouette with the central split closed — the 'hot mic' state."""
    solid = mark.copy()
    px = solid.load()
    for y in range(solid.height):
        row = [x for x in range(solid.width) if px[x, y] > 127]
        if row:
            for x in range(row[0], row[-1] + 1):
                px[x, y] = 255
    return solid


def slashed(mark: Image.Image) -> Image.Image:
    """A diagonal bar across the nib, knocked out of it so both stay legible at 18pt.

    The nib shrinks under the bar. At full size the split, the bar and the knockout add up to
    five alternating edges inside 18 points and the whole thing turns to mush.
    """
    out = place(mark, height=0.74)
    draw = ImageDraw.Draw(out)
    a, b = (0.10 * CANVAS, 0.90 * CANVAS), (0.90 * CANVAS, 0.10 * CANVAS)
    draw.line([a, b], fill=0, width=int(0.15 * CANVAS))    # the gap around the bar
    draw.line([a, b], fill=255, width=int(0.05 * CANVAS))  # the bar itself
    return out


def write(name: str, glyph: Image.Image) -> None:
    """One imageset, three scales, tagged so macOS tints it instead of drawing it mint."""
    folder = CATALOG / f"{name}.imageset"
    folder.mkdir(parents=True, exist_ok=True)
    images = []
    for suffix, size in SIZES.items():
        filename = f"{name}{suffix}.png"
        small = glyph.resize((size, size), Image.LANCZOS)
        # Alpha only. Any colour here would survive into the menu bar and fight the theme.
        Image.merge("RGBA", (Image.new("L", small.size, 0),) * 3 + (small,)).save(folder / filename)
        images.append({
            "filename": filename,
            "idiom": "mac",
            "scale": f"{suffix.lstrip('@') or '1x'}",
        })
    (folder / "Contents.json").write_text(json.dumps({
        "images": images,
        "info": {"author": "xcode", "version": 1},
        "properties": {"template-rendering-intent": "template"},
    }, indent=2) + "\n")
    print(f"{folder.relative_to(ROOT)}")


mark = mark_alpha()
idle = place(mark)
write("MenuBarNib", idle)
write("MenuBarNibFilled", place(filled(mark)))
write("MenuBarNibSlash", slashed(mark))
