"""Build the monochrome application icons. Requires fonttools: pip install fonttools."""

from pathlib import Path
import xml.etree.ElementTree as ET

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parent.parent
assets = root / "extensions/switchboard/assets"
source = (assets / "mark.svg").read_text()
pen = TTGlyphPen(None)
outline = TransformPen(Cu2QuPen(pen, 1), (40, 0, 0, -40, 32, 992))
for index, path in enumerate(ET.fromstring(source)):
    # SVG fills paths separately; font contours share one fill. Match the cable's winding to the sockets.
    parse_path(path.attrib["d"], ReverseContourPen(outline) if index == 1 else outline)

font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder([".notdef", "switchboard"])
font.setupCharacterMap({0xE001: "switchboard"})
font.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "switchboard": pen.glyph()})
font.setupHorizontalMetrics({".notdef": (1024, 0), "switchboard": (1024, 92)})
font.setupHorizontalHeader(ascent=1024, descent=0)
font.setupNameTable({"familyName": "Switchboard", "styleName": "Regular", "uniqueFontIdentifier": "Switchboard-Regular", "fullName": "Switchboard Regular", "psName": "Switchboard-Regular"})
font.setupOS2(sTypoAscender=1024, sTypoDescender=0, usWinAscent=1024, usWinDescent=0)
font.setupPost()
font.font.flavor = "woff"
font.save(assets / "switchboard.woff")

for theme, color in [("light", "#424242"), ("dark", "#cccccc")]:
    (assets.parent / "media" / f"switchboard-{theme}.svg").write_text(source.replace("currentColor", color))

paths = list(ET.fromstring(source))
dock = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 24 24">\n'
dock += '  <defs><linearGradient id="tile" x2="1" y2="1"><stop stop-color="#b56a95"/><stop offset=".5" stop-color="#9e5981"/><stop offset="1" stop-color="#87496d"/></linearGradient></defs>\n'
dock += '  <rect width="24" height="24" rx="4" fill="url(#tile)"/>\n'
dock += f'  <path fill="#f0f1f2" d="{paths[0].attrib["d"]}"/>\n'
dock += f'  <path fill="#3ce5ff" d="{paths[1].attrib["d"]}"/>\n</svg>\n'
(root / "apps/dock/src/Switchboard.Dock/Assets/dock.svg").write_text(dock)
