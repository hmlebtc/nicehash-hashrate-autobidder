# Project assets

The app icon, used by app-store packaging (Umbrel, Start9, future
community stores) and general branding.

| File | Size | Use |
|---|---|---|
| `icon.webp` | 1024×1024 | Master / canonical source. |
| `icon-512.png` | 512×512 | Common app-store raster fallback. |
| `icon-256.png` | 256×256 | Smaller raster for compact contexts. |

The icon is an original geometric mark - three ascending amber bars
on a dark navy rounded tile - matching the dashboard's browser-tab
favicon (see `packages/daemon/src/http/nicehash-dashboard-html.ts`).
It is generated from that SVG, so the Umbrel app icon and the favicon
stay identical. (It replaces an earlier community illustration that no
longer matched the app's branding.)

To regenerate, render the favicon SVG to raster at each size. The
PNGs can also be re-derived from the webp master:

```bash
magick assets/icon.webp -resize 512x512 assets/icon-512.png
magick assets/icon.webp -resize 256x256 assets/icon-256.png
```
