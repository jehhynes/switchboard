# /// script
# dependencies = ["pillow==12.3.0", "resvg-py==0.5.0"]
# ///
"""Export the app and extension icons with uv run assets/brand/export-icons.py."""
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image
from resvg_py import svg_to_bytes

brand = Path(__file__).resolve().parent
root = brand.parents[1]
web = root / "packages/web/src"
extension = root / "extensions/chrome/assets"
large = (brand / "switchboard.svg").read_text(encoding="utf-8")
small = (brand / "switchboard-small.svg").read_text(encoding="utf-8")


def render(svg, size):
    pixels = svg_to_bytes(svg_string=svg, width=size * 4, height=size * 4)
    image = Image.open(BytesIO(pixels)).convert("RGBA")
    return image.resize((size, size), Image.Resampling.LANCZOS)


frames = []
for size in (16, 24, 32, 48, 64, 128, 256):
    frame = render(small if size <= 32 else large, size)
    frames.append(frame)
    if size in (16, 32, 48, 128, 256):
        frame.save(extension / f"icon-{size}.png")
frames[-1].save(extension / "switchboard.ico", sizes=[f.size for f in frames], append_images=frames[:-1])

for size in (192, 512):
    render(large, size).save(web / f"icon-{size}.png")

# The tile fills the mask. Scale the sockets and cord into its central safe circle.
ElementTree.register_namespace("", "http://www.w3.org/2000/svg")
mask = ElementTree.fromstring(large)
mask.find("{*}rect").set("rx", "0")
mask.find("./*[@id='panel']").set("transform", "translate(2.24 2.24) scale(.72)")
masked = ElementTree.tostring(mask, encoding="unicode")
for size, filename in [(180, "apple-touch-icon.png"), (512, "icon-maskable-512.png")]:
    render(masked, size).convert("RGB").save(web / filename)
