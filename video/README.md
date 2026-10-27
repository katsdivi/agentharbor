# AgentHarbor product film: composition source

[Remotion](https://www.remotion.dev/) 4 project that renders [`docs/demo/agentharbor-product-film.mp4`](../docs/demo/agentharbor-product-film.mp4) and its poster. It is separate from the plugin: its own `package.json` and its own `node_modules`. Nothing here is imported by the plugin.

| File | Purpose |
|---|---|
| `src/theme.ts` | Palette, fonts (Inter, Inter Tight, Barlow Condensed via `@remotion/google-fonts`), the two easing curves |
| `src/components.tsx` | Reusable parts: `FocusIn`/`Headline` (focus-pull reveal), `BrowserFrame`, `Footage` (crop/zoom into the 1920×1080 source), `ToolChip`, `Sticker`, `HiddenNote`, `ContextBar`, `Sweep` and `whip` transitions |
| `src/Film.tsx` | The timeline: six scenes, frame numbers at 30 fps, source timestamps of every footage clip |
| `src/Soundtrack.tsx` | Voice-over placement, music ducking and sound effects (frame numbers at 30 fps) |
| `public/audio/` | ElevenLabs voice-over, music and effects used by `Soundtrack.tsx` (see [docs/demo/README.md](../docs/demo/README.md#product-film) · Audio) |
| `src/Poster.tsx` | README poster |
| `scripts/prepare-footage.sh` | Builds the redacted footage masters and stills into `public/footage/` (gitignored) |
| `scripts/master-audio.sh` | Two-pass loudness normalisation to −16 LUFS / −1.5 dBTP, video copied untouched, faststart |

## Render

```bash
cd video
npm install
scripts/prepare-footage.sh <worker1.webm> <worker2.webm>   # raw recordings: private, never committed
npm run preview      # 960x540 motion check -> out/preview.mp4
npm run render       # 1920x1080, H.264 CRF 14, 30 fps, AAC audio -> out/agentharbor-product-film.mp4
npm run master       # -16 LUFS, faststart -> out/agentharbor-product-film-mastered.mp4 (the published file)
npm run poster       # -> out/agentharbor-product-film-poster.png
npm run studio       # interactive timeline
```

The raw worker recordings come from a run with `RBA_LOCAL_RECORD_VIDEO_DIR` set (see [docs/demo/README.md](../docs/demo/README.md)). They contain the disposable inbox address, so the composition never reads them directly. It reads only the redacted masters that `prepare-footage.sh` produces and checks.

Fonts are fetched from Google Fonts at render time (network needed). Remotion is free for individuals and companies of up to three people; larger companies need a [company license](https://www.remotion.dev/license).
