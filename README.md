# Game Jam Starter — Phaser 3 + Vite

Lightweight starter to ship a browser game during a jam.

## Stack
- **Phaser 3.90+** — game engine
- **Vite 7** — dev server + bundler with HMR
- Pure ESM, no TypeScript (swap in if you want — Vite handles it)

## Run
```bash
npm install
npm run dev      # http://localhost:3333
npm run build    # production build → dist/
npm run preview  # preview built bundle on :3333
```

The dev server runs on **port 3333** with strict-port + auto-open.
HMR triggers a full page reload on any source change (Phaser scenes don't survive module swap cleanly, so a full reload is the safe default).

### Multiple instances / changing the port
Pick whichever feels best — all three work:
```bash
PORT=3334 npm run dev                # env var (one-shot)
npm run dev -- --port 3335           # vite CLI flag (one-shot)
echo "PORT=3336" > .env.local        # persistent for this clone (gitignored)
```
`strictPort` is on, so Vite errors out if the port is taken instead of silently jumping. The same `PORT` value also drives `npm run preview`.

## Layout
```
src/
  main.js           game bootstrap + Phaser config
  config.js         dimensions, colors, key bindings
  input.js          input helper (axes, justPressed, isDown)
  debug-panel.js    HTML dev inspector (dev-only)
  scenes/
    Boot.js         empty boot scene
    Preloader.js    asset loading + progress bar
    MainMenu.js     title screen
    Game.js         placeholder gameplay (move + jump)
public/
  assets/           drop sprites/audio here, load from Preloader
```

## Dev Inspector

When running `npm run dev`, an HTML panel mounts beside the canvas showing:
- Live FPS, delta, scene, renderer, JS heap
- Pressed/held keys + last pressed
- Cookies, localStorage, sessionStorage entries with sizes
- Bundle: total transfer, request count, breakdown by type, top 6 by weight
- Loaded Phaser textures and audio
- Environment (mode, viewport, DPR, online status)

It only mounts when `import.meta.env.DEV` is true, so production builds ship without it.

## Adding assets
1. Drop files into `public/assets/`
2. Load them in `src/scenes/Preloader.js`:
   ```js
   this.load.image('player', 'assets/player.png');
   this.load.spritesheet('hero', 'assets/hero.png', { frameWidth: 32, frameHeight: 32 });
   this.load.audio('hit', 'assets/hit.wav');
   ```
3. Use them in scenes via `this.add.image(x, y, 'player')` etc.

## Controls (default)
- Move: WASD / arrows
- Jump / Confirm: SPACE / J / ENTER
- Back to menu: ESC

Tweak `KEYS` in `src/config.js`.
