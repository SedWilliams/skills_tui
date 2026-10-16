# Contributing

Bug reports, skills the scanner misses, and new agent targets are all welcome. Open an issue or a pull request.

## Getting set up

```sh
git clone https://github.com/SedWilliams/skills_tui.git
cd skills_tui
npm install
npm test
```

## Before you open a pull request

```sh
npm test           # the suite must be green
npm run typecheck  # tsc with no output
npm run build      # compiles src/ to dist/
```

If your change alters a screen, regenerate the README images and commit them with it:

```sh
npm run assets
```

This needs Node 22, Google Chrome, and Python 3 on macOS or Linux. Set `CHROME=/path/to/chrome` if Chrome lives somewhere unusual. The first run downloads fonts, Pillow, and ffmpeg into `marketing/tools/.cache`. The demo skills live in `marketing/tools/demo-data.mjs`, and the scripted session lives in `marketing/tools/capture.mjs`.

## Directory layout

| | |
|---|---|
| `src/*.ts`, `src/*.tsx` | the app and its vitest tests |
| `marketing/tools/` | asset capture for the README, not part of the app |
| `docs/assets/` | the images the README shows, written by `npm run assets` |

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
