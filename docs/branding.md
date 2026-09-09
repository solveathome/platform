# Branding assets

The approved identity is the two-piece charcoal S with the lowercase solveathome wordmark.
Keep the generated originals as the source artwork. The splash page uses the original
transparent logo and displays it in a light color with CSS when dark mode is active.

## Ready-to-use files

| File | Size | Use |
| --- | --- | --- |
| [Transparent logo](../public/brand/solveathome-logo.png) | 2146 × 733 | Wordmark for websites and documents |
| [Square icon master](../public/brand/solveathome-icon-master.png) | 1254 × 1254 | Source for all icon exports |
| [GitHub avatar](../public/brand/github-avatar-512.png) | 512 × 512 | Recommended organization/profile upload |
| [Large avatar](../public/brand/github-avatar-1024.png) | 1024 × 1024 | Other services and larger placements |
| [Small avatar](../public/brand/github-avatar-256.png) | 256 × 256 | Smaller upload requirements |
| [Favicon ICO](../public/icons/favicon.ico) | 16, 32, 48 | Multi-resolution browser favicon |
| [Favicon 16](../public/icons/favicon-16.png) / [32](../public/icons/favicon-32.png) / [48](../public/icons/favicon-48.png) | 16 / 32 / 48 | PNG browser icons |
| [Apple touch icon](../public/icons/apple-touch-icon.png) | 180 × 180 | iPhone and iPad home screen |
| [App icon 192](../public/icons/icon-192.png) / [512](../public/icons/icon-512.png) | 192 / 512 | Web manifest icons |
| [Maskable icon](../public/icons/icon-maskable-512.png) | 512 × 512 | Platform-shaped app icons |

Square exports include a light background and generous space around the symbol so it
remains visible on dark interfaces and survives circular avatar crops. Upload a square
avatar file as-is; do not add a circular crop or rounded corners to the file itself.

The page links `/favicon.ico`, `/apple-touch-icon.png`, and `/site.webmanifest`.
The Express splash middleware serves these aliases and the `/brand/` and `/icons/`
directories on splash and app hosts, while keeping app routes closed on splash hosts.

## Regenerate exports

Install ImageMagick, then run `npm run build:icons` from the repository root. This only
resizes and encodes the saved icon master; it does not need an image-generation
service, API key, or a new design pass. Generated exports are included with the source
so production builds do not need ImageMagick.

Both original artworks were created with the built-in image generation tool. Prompts:
[logo](branding/solveathome-logo.prompt.md) and
[icon](branding/solveathome-icon.prompt.md). Keep design prompts in `docs/`, outside
the web-served `public/` directory: they contain project details that are not part of
the prelaunch splash page.
