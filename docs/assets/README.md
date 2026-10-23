# Email MCP artwork

The folded envelope follows Mnemic's silver ribbon style with its own deep petrol teal icon background,
`#0C2C30`. The SVG files are the editable sources; the PNGs are rendered from them.

| Asset | Format and size | Use |
| --- | --- | --- |
| `email-mcp-icon.svg` | SVG, 512 × 512 | Editable square icon with an opaque petrol teal background |
| `email-mcp-icon.png` | PNG, 512 × 512 | README and MCP Bundles |
| `email-mcp-mark-light.svg` | SVG, 650 × 420 | Silver envelope on a transparent background, for dark surfaces |
| `email-mcp-mark-light.png` | PNG, 1300 × 840 | Transparent raster export of the light mark |
| `email-mcp-mark-dark.svg` | SVG, 650 × 420 | Slate envelope on a transparent background, for light surfaces |
| `email-mcp-mark-dark.png` | PNG, 1300 × 840 | Transparent raster export of the dark mark |

Both MCPB manifests reference `icon.png`. The per-platform, universal, and Windows signing packers copy
`email-mcp-icon.png` into the bundle root under that name, following Mnemic's packaging convention.
The Claude and Codex packages keep matching copies at `plugin/assets/icon.png` and
`plugin-codex/assets/icon.png`; update those copies when changing the square icon.

To regenerate the PNGs with Inkscape:

```bash
inkscape docs/assets/email-mcp-icon.svg --export-type=png --export-filename=docs/assets/email-mcp-icon.png --export-width=512 --export-height=512
inkscape docs/assets/email-mcp-mark-light.svg --export-type=png --export-filename=docs/assets/email-mcp-mark-light.png --export-width=1300 --export-height=840
inkscape docs/assets/email-mcp-mark-dark.svg --export-type=png --export-filename=docs/assets/email-mcp-mark-dark.png --export-width=1300 --export-height=840
```
