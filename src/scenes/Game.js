import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';
import { MAP, TIME, FARMING } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_IDS, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { EVENT_TYPES } from '../data/eventTypes.js';
import { TUTORIAL_STEPS } from '../data/tutorialSteps.js';
import {
  createInitialState, initAIFarmers, tilePrice, pushLog, pushFx, persistTutorial,
} from '../state/GameState.js';
import { tickClock, setSpeed, formatDate } from '../systems/Clock.js';
import {
  tickMarket, priceTrend, tickCountriesYearly,
  sellFromInventory, buyFromGlobal, inventoryOf,
  elasticityFor, elasticityTargetFor,
  populationSpend, marketInventoryOf,
  offMarketInventoryFor,
} from '../systems/Market.js';
import { tickFiscalCrisis } from '../systems/FiscalCrisis.js';
import { seedIndustries } from '../systems/WorldSeed.js';
import {
  tickFarming, buyTile, plowTile, plantTile, harvestTile,
  tileFinanceQuote, expectedYield, effectiveQualityFor,
  lockTypeForCategory, uprootTile,
} from '../systems/Farming.js';
import {
  effectiveHarvestCost, effectiveSetupCost,
  effectivePlowCost, effectiveSalary,
} from '../systems/Inflation.js';
import { tickLaborMarket, wageRateFor } from '../systems/Labor.js';
import { tickStorageCost, storageBillFor } from '../systems/Storage.js';
import { OFFERS } from '../data/tunables.js';
import {
  acceptOffer, rejectOffer, counterOffer, makePurchaseOffer,
  buyStartingAmount, buyAcceptProbability, counterAcceptProbability,
} from '../systems/Trade.js';
import {
  tickLoans, applyForLoan, eligibleProducts, quoteLoan, totalDebt, totalMonthlyPayment,
  loansOf,
} from '../systems/Bank.js';
import { tickAI, tickAIWeekly, tickAIMonthly } from '../systems/AI.js';
import { tickEvents } from '../systems/Events.js';
import { LOAN_PRODUCTS, LOAN_PRODUCT_LIST, resolveMaxPrincipal } from '../data/loanProducts.js';
import { startMusic, toggleMute, isMusicMuted } from '../systems/Music.js';
import { play as playSfx } from '../systems/Sfx.js';
import { downloadCSV } from '../util/csv.js';
import { AutoplayController } from '../agent/Autoplay.js';

const MAP_OFFSET_X = 10;
const MAP_OFFSET_Y = 50;
const PANEL_X = MAP_OFFSET_X + MAP.cols * MAP.tilePx + 12;
const PANEL_W = GAME_WIDTH - PANEL_X - 8;

const TILE_COLORS = {
  wild: 0x3b5a3a,
  fallow: 0x6b4a2a,
  plowed: 0x4a3220,
  planted: 0x6e8a3e,
  mature: 0x4cae3a,
  cosechado: 0x6e5a2a,
  lot: 0xbababa,
  player_outline: 0xffd166,
  hover_outline: 0xffffff,
  selected_outline: 0x66ccff,
};

const STATE_LABEL = {
  fallow: 'fallow',
  plowed: 'plowed',
  planted: 'planted',
  mature: 'mature',
  cosechado: 'resting',
  dead: 'dead',
  lot: 'developed',
  industry: 'industry',
};

export class Game extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  // Modal speed-pause manager. Multiple modals can stack; we only save the
  // pre-pause speed on the FIRST entry and only restore on the LAST exit.
  // Avoids the clobber where modal-B saves speed=0 (already paused by A) and
  // then closing A first restores to 0 instead of the user's real speed.
  enterModal() {
    const s = this.state;
    s.ui.modalCount = (s.ui.modalCount || 0) + 1;
    if (s.ui.modalCount === 1) {
      s.ui.savedSpeedIdx = s.time.speedIdx;
      setSpeed(s, 0);
    }
  }
  exitModal() {
    const s = this.state;
    s.ui.modalCount = Math.max(0, (s.ui.modalCount || 0) - 1);
    if (s.ui.modalCount === 0) {
      setSpeed(s, s.ui.savedSpeedIdx ?? 1);
    }
  }

  create() {
    this.state = createInitialState();
    initAIFarmers(this.state);
    seedIndustries(this.state);

    // Bot que puede tomar el control con la tecla A.
    this.autoplay = new AutoplayController();

    this.cameras.main.setBackgroundColor('#0f1923');
    this.tileRects = [];
    this.cityGfx = this.add.graphics();
    this.hoverId = null;

    this.buildMap();
    this.buildTopBar();
    this.buildPanel();
    this.buildBankModal();
    this.buildCountryChart();
    this.buildOfferModal();
    this.buildMarketModal();
    this.buildPriceChartModal();
    this.buildStockChartModal();
    this.buildEventsModal();
    this.buildCompaniesModal();
    this.buildTutorialOverlay();
    this.offerMarkers = [];

    // Music starts on first user gesture (browser policy).
    this.input.once('pointerdown', () => startMusic());

    this.input.keyboard.on('keydown-SPACE', () => {
      this.state.time.paused = !this.state.time.paused;
    });
    this.input.keyboard.on('keydown-A', () => {
      this.autoplay.toggle(this.state);
      this.refreshTopBar();
    });
    // Number-key shortcuts auto-bind to whatever speeds are registered (1..N).
    const numberKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    for (let i = 1; i < TIME.speedLabels.length && i - 1 < numberKeys.length; i++) {
      const idx = i;
      this.input.keyboard.on(`keydown-${numberKeys[i - 1]}`, () => setSpeed(this.state, idx));
    }
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.state.ui.offerOpen) { this.closeOfferModal(); return; }
      if (this.state.ui.priceChartOpen) { this.togglePriceChart(false); return; }
      if (this.state.ui.stockChartOpen) { this.toggleStockChart(false); return; }
      if (this.state.ui.marketOpen) { this.toggleMarket(false); return; }
      if (this.state.ui.eventsOpen) { this.toggleEvents(false); return; }
      if (this.state.ui.companiesOpen) { this.toggleCompanies(false); return; }
      if (this.state.ui.countryChartOpen) { this.closeCountryChart(); return; }
      if (this.state.ui.bankOpen) { this.toggleBank(false); return; }
      this.state.selection.tileId = null;
      this.refreshPanel();
    });

    this.refreshAll();
  }

  // -----------------------------------------------------------------------
  // MAP
  // -----------------------------------------------------------------------
  // Returns the map currently being rendered (home by default; switches via Visit).
  currentMap() {
    return this.state.maps[this.state.ui.currentMap] || this.state.maps.home;
  }

  currentCity() {
    return this.state.cities[this.state.ui.currentMap] || this.state.cities.home;
  }

  buildMap() {
    const { tilePx } = MAP;
    const map = this.currentMap();
    for (let i = 0; i < map.tiles.length; i++) {
      const tile = map.tiles[i];
      const x = MAP_OFFSET_X + tile.x * tilePx;
      const y = MAP_OFFSET_Y + tile.y * tilePx;
      const rect = this.add
        .rectangle(x, y, tilePx - 1, tilePx - 1, TILE_COLORS.wild)
        .setOrigin(0, 0)
        .setStrokeStyle(1, 0x000000, 0.4)
        .setInteractive({ useHandCursor: true });
      rect.on('pointerover', () => { this.hoverId = tile.id; this.refreshPanel(); this.refreshTiles(); });
      rect.on('pointerout', () => { if (this.hoverId === tile.id) this.hoverId = null; this.refreshPanel(); this.refreshTiles(); });
      rect.on('pointerdown', () => {
        if (this.state.ui.bankOpen) return;
        this.state.selection.tileId = tile.id;
        this.state.selection.countryId = tile.countryId;
        this.refreshPanel();
        this.refreshTiles();
      });
      this.tileRects.push(rect);
    }
  }

  // Tear down tile graphics and rebuild for a different country's map.
  switchMap(countryId) {
    if (!this.state.maps[countryId]) return;
    this.state.ui.currentMap = countryId;
    this.state.selection.tileId = null;
    this.state.selection.countryId = countryId;
    this.hoverId = null;
    for (const rect of this.tileRects) rect.destroy();
    this.tileRects = [];
    this.buildMap();
    this.refreshAll();
  }

  refreshCity() {
    const c = this.currentCity();
    const cx = MAP_OFFSET_X + c.x * MAP.tilePx + MAP.tilePx / 2;
    const cy = MAP_OFFSET_Y + c.y * MAP.tilePx + MAP.tilePx / 2;

    this.cityGfx.clear();
    this.cityGfx.fillStyle(0x9aa4ad, 1);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bx = cx + dx * (MAP.tilePx * 0.4) - MAP.tilePx * 0.18;
        const by = cy + dy * (MAP.tilePx * 0.4) - MAP.tilePx * 0.18;
        this.cityGfx.fillRect(bx, by, MAP.tilePx * 0.36, MAP.tilePx * 0.36);
      }
    }
    if (this.cityLabel) this.cityLabel.destroy();
    const countryLabel = (COUNTRIES[this.state.ui.currentMap]?.name) || 'City';
    this.cityLabel = this.add.text(cx, cy + MAP.tilePx * 1.6, `${countryLabel}\n${c.population.toLocaleString()} pop`, {
      fontFamily: 'monospace', fontSize: '10px', color: '#cdd6df', align: 'center',
    }).setOrigin(0.5, 0);
  }

  refreshOfferMarkers() {
    if (!this.offerMarkers) this.offerMarkers = [];
    for (const m of this.offerMarkers) m.destroy();
    this.offerMarkers = [];
    const map = this.currentMap();
    for (const tile of map.tiles) {
      if (!tile.pendingOffer) continue;
      const cx = MAP_OFFSET_X + tile.x * MAP.tilePx + MAP.tilePx / 2;
      const cy = MAP_OFFSET_Y + tile.y * MAP.tilePx;
      const fromPlayer = tile.pendingOffer.fromId === 'player';
      const label = `$${tile.pendingOffer.amount}`;
      const t = this.add.text(cx, cy - 2, label, {
        fontFamily: 'monospace', fontSize: '10px', color: '#0f1923',
        backgroundColor: fromPlayer ? '#ffb347' : '#6ee7b7',
        padding: { x: 3, y: 1 }, fontStyle: 'bold',
      }).setOrigin(0.5, 1).setDepth(3);
      this.offerMarkers.push(t);
    }
  }

  refreshTiles() {
    const s = this.state;
    const map = this.currentMap();
    for (let i = 0; i < map.tiles.length; i++) {
      const tile = map.tiles[i];
      const rect = this.tileRects[i];
      if (!rect) continue;
      let color = TILE_COLORS.wild;
      let strokeColor = 0x000000;
      let strokeAlpha = 0.4;
      let strokeWidth = 1;

      if (tile.state === 'lot') {
        color = TILE_COLORS.lot;
      } else if (tile.owner === 'player' || tile.owner?.includes?.('_ai')) {
        if (tile.state === 'fallow') color = TILE_COLORS.fallow;
        else if (tile.state === 'plowed') color = TILE_COLORS.plowed;
        else if (tile.state === 'planted') {
          const def = tile.crop ? PRODUCIBLES[tile.crop] : null;
          if (def) {
            const baseColor = 0x6b4a2a;
            const interp = Phaser.Display.Color.Interpolate.ColorWithColor(
              Phaser.Display.Color.IntegerToColor(baseColor),
              Phaser.Display.Color.IntegerToColor(def.color),
              100,
              Math.floor(tile.growth * 100),
            );
            color = Phaser.Display.Color.GetColor(interp.r, interp.g, interp.b);
          } else color = TILE_COLORS.planted;
        } else if (tile.state === 'mature') {
          const def = tile.crop ? PRODUCIBLES[tile.crop] : null;
          color = def ? def.color : TILE_COLORS.mature;
        } else if (tile.state === 'cosechado') color = TILE_COLORS.cosechado;
      } else {
        const c0 = Phaser.Display.Color.IntegerToColor(0x3b5a3a);
        const shade = 0.6 + tile.quality * 0.6;
        color = Phaser.Display.Color.GetColor(
          Math.min(255, c0.r * shade),
          Math.min(255, c0.g * shade),
          Math.min(255, c0.b * shade),
        );
      }
      rect.setFillStyle(color);

      if (s.selection.tileId === tile.id) {
        strokeColor = TILE_COLORS.selected_outline; strokeAlpha = 1; strokeWidth = 2;
      } else if (this.hoverId === tile.id) {
        strokeColor = TILE_COLORS.hover_outline; strokeAlpha = 0.85; strokeWidth = 2;
      } else if (tile.owner === 'player') {
        strokeColor = TILE_COLORS.player_outline; strokeAlpha = 0.95; strokeWidth = 2;
      } else if (tile.owner?.includes?.('_ai')) {
        const ai = s.aiFarmers.find(a => a.id === tile.owner);
        if (ai) { strokeColor = ai.color; strokeAlpha = 0.9; strokeWidth = 2; }
      }
      rect.setStrokeStyle(strokeWidth, strokeColor, strokeAlpha);
    }
    // Surveyed tiles: render small mineral dots in the corner
    this.refreshTileOverlays();
  }

  refreshTileOverlays() {
    if (!this.mineralDots) this.mineralDots = this.add.graphics().setDepth(2);
    this.mineralDots.clear();
    const { tilePx } = MAP;
    const map = this.currentMap();
    for (const tile of map.tiles) {
      const x0 = MAP_OFFSET_X + tile.x * tilePx;
      const y0 = MAP_OFFSET_Y + tile.y * tilePx;

      // Loop indicator — small green ↻ glyph in the top-right corner of looped tiles
      if (tile.autoReplant && tile.crop) {
        this.mineralDots.lineStyle(2, 0x6ee7b7, 0.95);
        this.mineralDots.strokeCircle(x0 + tilePx - 6, y0 + 5, 3);
        // Tiny tick on the circle to suggest motion
        this.mineralDots.fillStyle(0x6ee7b7, 1);
        this.mineralDots.fillCircle(x0 + tilePx - 4, y0 + 3, 1.2);
      }
    }
  }

  // -----------------------------------------------------------------------
  // TOP BAR
  // -----------------------------------------------------------------------
  // Builds a single icon-style button at position x with width w. `accent` is
  // the resting fill, `hover` is the hover fill. Returns { bg, txt }.
  makeIconButton(x, w, label, accent, hover, onClick, tooltip) {
    const bg = this.add.rectangle(x, 8, w, 28, accent).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    const txt = this.add.text(x + w / 2, 22, label, {
      fontFamily: 'monospace', fontSize: '12px', color: '#0f1923', fontStyle: 'bold',
    }).setOrigin(0.5);
    bg.on('pointerover', () => { bg.setFillStyle(hover); if (tooltip) this.showTopTooltip(x + w / 2, tooltip); });
    bg.on('pointerout', () => { bg.setFillStyle(accent); this.hideTopTooltip(); });
    bg.on('pointerdown', onClick);
    return { bg, txt };
  }

  showTopTooltip(cx, text) {
    if (!this.topTooltip) {
      this.topTooltipBg = this.add.rectangle(0, 0, 10, 18, 0x0f1923, 0.95).setOrigin(0.5, 0).setDepth(99);
      this.topTooltip = this.add.text(0, 0, '', {
        fontFamily: 'monospace', fontSize: '10px', color: '#e8edf3',
      }).setOrigin(0.5, 0).setDepth(100);
    }
    this.topTooltip.setText(text).setVisible(true);
    this.topTooltipBg.width = this.topTooltip.width + 10;
    this.topTooltipBg.x = cx;
    this.topTooltipBg.y = 38;
    this.topTooltip.x = cx;
    this.topTooltip.y = 40;
    this.topTooltipBg.setVisible(true);
  }
  hideTopTooltip() {
    if (this.topTooltip) { this.topTooltip.setVisible(false); this.topTooltipBg.setVisible(false); }
  }

  buildTopBar() {
    this.topBg = this.add.rectangle(0, 0, GAME_WIDTH, 44, 0x131e2b).setOrigin(0, 0);
    this.topText = this.add.text(12, 12, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3',
    });

    // Right-aligned button row. Layout right-to-left:
    // [speed buttons] [BANK] [MARKET] [WORLD] [EVENTS] [COMPANIES] [music]
    const speedCount = TIME.speedLabels.length;
    let cursor = GAME_WIDTH - speedCount * 38 - 8;          // left edge of speed group
    const ICON_W = 36;
    const GAP = 4;

    const place = (w) => { cursor -= (w + GAP); return cursor; };

    // BANK
    const bankX = place(ICON_W);
    this.bankBtn = this.makeIconButton(bankX, ICON_W, '🏦', 0x6ee7b7, 0x9af0d2,
      () => this.toggleBank(true), 'Bank');

    // MARKET
    const marketX = place(ICON_W);
    this.marketBtn = this.makeIconButton(marketX, ICON_W, '📈', 0xffb347, 0xffc878,
      () => this.toggleMarket(true), 'Market');

    // EVENTS
    const eventsX = place(ICON_W);
    this.eventsBtn = this.makeIconButton(eventsX, ICON_W, '⚡', 0xf7c948, 0xfbd970,
      () => this.toggleEvents(true), 'Events history');

    // COMPANIES
    const companiesX = place(ICON_W);
    this.companiesBtn = this.makeIconButton(companiesX, ICON_W, '🏭', 0xc792ea, 0xd9b3f0,
      () => this.toggleCompanies(true), 'Companies');

    // AUTOPLAY — clickable toggle (off → BOT → CLAUDE → off)
    const autoX = place(ICON_W);
    this.autoplayBtn = this.makeIconButton(autoX, ICON_W, '🤖', 0xa78bfa, 0xc4b5fd,
      () => { this.autoplay.toggle(this.state); this.refreshTopBar(); },
      'Autoplay (cycle off/BOT/CLAUDE)');

    // Music — small grey icon at the leftmost slot
    const musicX = place(28);
    this.musicBtnBg = this.add.rectangle(musicX, 8, 28, 28, 0x243345).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.musicBtnTxt = this.add.text(musicX + 14, 22, isMusicMuted() ? '🔇' : '♪', {
      fontFamily: 'monospace', fontSize: '14px', color: '#cdd6df',
    }).setOrigin(0.5);
    this.musicBtnBg.on('pointerover', () => this.musicBtnBg.setFillStyle(0x3a4d63));
    this.musicBtnBg.on('pointerout', () => this.musicBtnBg.setFillStyle(0x243345));
    this.musicBtnBg.on('pointerdown', () => {
      const muted = toggleMute();
      this.musicBtnTxt.setText(muted ? '🔇' : '♪');
      startMusic();
    });

    this.speedButtons = [];
    TIME.speedLabels.forEach((label, idx) => {
      const x = GAME_WIDTH - (TIME.speedLabels.length - idx) * 38 - 8;
      const bg = this.add.rectangle(x, 8, 32, 28, 0x243345).setOrigin(0, 0).setInteractive({ useHandCursor: true });
      const txt = this.add.text(x + 16, 22, label, {
        fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
      }).setOrigin(0.5);
      bg.on('pointerdown', () => setSpeed(this.state, idx));
      this.speedButtons.push({ bg, txt, idx });
    });
  }

  refreshTopBar() {
    const s = this.state;
    const debt = totalDebt(s, 'player');
    const cuota = totalMonthlyPayment(s, 'player');
    const loans = loansOf(s, 'player').length;
    const here = COUNTRIES[s.ui.currentMap]?.name ?? s.ui.currentMap;
    const storage = storageBillFor(s, 'player', PLAYER_COUNTRY_ID);
    const storageStr = storage > 0 ? `   📦 $${storage}/mo` : '';
    this.topText.setText(
      `📅 ${formatDate(s)}   💰 $${Math.round(s.player.cash)}   🏦 $${Math.round(debt)} (${loans})   ` +
      `mo $${Math.round(cuota)}${storageStr}   📍 ${here}`,
    );
    // Indicador de autoplay vive abajo-derecha (out of the way de los iconos).
    if (!this.autoplayBadge) {
      this.autoplayBadge = this.add.text(GAME_WIDTH - 8, GAME_HEIGHT - 8, '', {
        fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3',
        backgroundColor: '#1a2433', padding: { x: 6, y: 3 },
      }).setOrigin(1, 1).setDepth(80);
    }
    const tag = this.autoplay?.mode === 'heuristic' ? '🤖 BOT'
              : this.autoplay?.mode === 'claude' ? '🧠 CLAUDE'
              : '';
    this.autoplayBadge.setText(tag).setVisible(!!tag);
    for (const b of this.speedButtons) {
      const active = b.idx === s.time.speedIdx;
      b.bg.setFillStyle(active ? 0xffb347 : 0x243345);
      b.txt.setColor(active ? '#1a1a1a' : '#e8edf3');
    }
  }

  // -----------------------------------------------------------------------
  // RIGHT PANEL
  // -----------------------------------------------------------------------
  buildPanel() {
    this.panelBg = this.add.rectangle(PANEL_X - 4, MAP_OFFSET_Y, PANEL_W + 4, GAME_HEIGHT - MAP_OFFSET_Y - 4, 0x131e2b).setOrigin(0, 0);
    this.panelText = this.add.text(PANEL_X + 6, MAP_OFFSET_Y + 8, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3', wordWrap: { width: PANEL_W - 12 },
    });
    this.actionButtons = [];
    // Countries / market / events / log used to live here. They moved to their
    // dedicated modals (🌍 World, 📈 Market, ⚡ Events). The freed vertical
    // space goes to tile info and tile actions.
  }

  clearActionButtons() {
    for (const b of this.actionButtons) {
      b.bg.destroy();
      b.txt.destroy();
      if (b.hint) b.hint.destroy();
      if (b.knob) b.knob.destroy();
    }
    this.actionButtons = [];
  }

  // Toggle switch widget — visually distinct from action buttons. Pill-shape
  // with a knob that slides left/right based on `on`. Used for persistent
  // settings (Auto-manage) rather than one-shot actions (Plow, Plant).
  addToggleSwitch(label, y, on, onClick, hint = '') {
    const w = PANEL_W - 16;
    const h = 30;
    const trackColor = on ? 0x2a8a5a : 0x3a4d63;
    const bg = this.add.rectangle(PANEL_X + 6, y, w, h, trackColor)
      .setOrigin(0, 0)
      .setStrokeStyle(1, on ? 0x6ee7b7 : 0x566370)
      .setInteractive({ useHandCursor: true });
    const knobX = on ? (PANEL_X + 6 + w - 20) : (PANEL_X + 6 + 4);
    const knob = this.add.rectangle(knobX, y + 4, 16, h - 8,
      on ? 0xe8edf3 : 0xcdd6df).setOrigin(0, 0);
    const labelTxt = this.add.text(PANEL_X + 28, y + 4, label, {
      fontFamily: 'monospace', fontSize: '10px',
      color: '#e8edf3', fontStyle: 'bold',
    }).setOrigin(0, 0);
    const hintTxt = hint ? this.add.text(PANEL_X + 28, y + 17, hint, {
      fontFamily: 'monospace', fontSize: '8px', color: '#cdd6df',
      wordWrap: { width: w - 50 },
    }).setOrigin(0, 0) : null;
    bg.on('pointerover', () => bg.setFillStyle(on ? 0x3aaa6a : 0x4a5f7a));
    bg.on('pointerout', () => bg.setFillStyle(trackColor));
    bg.on('pointerdown', onClick);
    this.actionButtons.push({ bg, txt: labelTxt, hint: hintTxt, knob });
    return y + h + 4;
  }

  addActionButton(label, y, enabled, onClick, hint = '', color = 0x2a4a6a) {
    const w = PANEL_W - 16;
    const innerW = w - 12;
    const h = hint ? 32 : 22;
    const bg = this.add.rectangle(PANEL_X + 6, y, w, h, enabled ? color : 0x1d2a3a)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: enabled });
    const labelTxt = this.add.text(PANEL_X + 12, y + 4, label, {
      fontFamily: 'monospace', fontSize: '10px',
      color: enabled ? '#e8edf3' : '#566370',
      fontStyle: 'bold',
      wordWrap: { width: innerW },
    });
    const nodes = [bg, labelTxt];
    let hintTxt = null;
    if (hint) {
      hintTxt = this.add.text(PANEL_X + 12, y + 18, hint, {
        fontFamily: 'monospace', fontSize: '9px',
        color: enabled ? '#9aa4ad' : '#3d4854',
        wordWrap: { width: innerW },
      });
      nodes.push(hintTxt);
    }
    if (enabled) {
      bg.on('pointerover', () => bg.setFillStyle(0x3a6090));
      bg.on('pointerout', () => bg.setFillStyle(color));
      bg.on('pointerdown', onClick);
    }
    // Track all nodes so clearActionButtons cleans them up.
    this.actionButtons.push({ bg, txt: labelTxt, hint: hintTxt });
    return y + h + 3;
  }

  refreshPanel() {
    this.clearActionButtons();
    const s = this.state;
    const map = this.currentMap();
    const focusId = s.selection.tileId ?? this.hoverId;
    const tile = focusId != null ? map.tiles[focusId] : null;
    const isHomeView = s.ui.currentMap === 'home';

    if (!tile) {
      this.panelText.setText('Hover or click a tile.\n\nClick once to select and see actions.\n\nKeys: 1/2/3 speed, SPACE pause, ESC deselect.');
    } else {
      const stateText = STATE_LABEL[tile.state] || tile.state;
      const lines = [
        `Tile (${tile.x},${tile.y})`,
        `Owner: ${this.ownerLabel(tile)}`,
        `Quality: ${(tile.quality * 100).toFixed(0)}%`,
        `State: ${stateText}`,
      ];
      if (tile.crop) {
        const def = PRODUCIBLES[tile.crop];
        lines.push(`Crop: ${def.name}`);
        if (tile.state === 'planted') lines.push(`Growth: ${(tile.growth * 100).toFixed(0)}%`);
        // Estimated harvest economics — visible BEFORE harvesting so the player isn't surprised.
        const yieldEst = expectedYield(def, effectiveQualityFor(def, tile));
        const priceNow = Math.round(s.market.prices?.[tile.countryId]?.[def.id] || 0);
        const revEst = priceNow * yieldEst;
        const labor = effectiveHarvestCost(s, tile.countryId, def);
        const auto = tile.autoMode === true || tile.owner !== 'player';
        const laborText = auto ? `−$${labor} (auto)` : `−$0 (manual)`;
        const net = revEst - (auto ? labor : 0);
        const netColor = net >= 0 ? '🟢' : '🔴';
        lines.push(`Est. revenue: $${revEst} (${yieldEst}u × $${priceNow})`);
        lines.push(`Harvest labor: ${laborText}`);
        lines.push(`Net (est.): ${netColor} $${net}`);
        // Grace-period warning + skip indicator on mature tiles.
        if (tile.state === 'mature' && tile.matureSinceDay != null) {
          const sinceMature = s.time.totalDays - tile.matureSinceDay;
          const daysToRot = FARMING.harvestGraceDays - sinceMature;
          if ((tile.skipStreak || 0) > 0) {
            lines.push(`⏸ Auto-skipped × ${tile.skipStreak} (price too low for labor)`);
          }
          if (daysToRot <= 10) {
            const verb = def.perennial ? 'fruit lost' : 'rots to fallow';
            lines.push(`⏱ ${verb} in ${Math.max(0, daysToRot)}d if not harvested`);
          }
        }
      }
      if (tile.lockType) {
        lines.push(`🔒 Locked to 🌾 ${tile.lockType}`);
      }
      if (tile.owner === 'wild') lines.push(`Price: $${tilePrice(tile, s)}`);
      this.panelText.setText(lines.join('\n'));

      // Use the actual rendered height of the wrapped text instead of guessing
      // `lines.length * 13` — wrapped lines (e.g. long "Locked to..." labels)
      // would otherwise overlap the action buttons.
      let y = this.panelText.y + this.panelText.height + 10;

      // Foreign maps are read-only (player only operates in home).
      if (!isHomeView) {
        y = this.addActionButton(
          `View only — ${COUNTRIES[s.ui.currentMap]?.name ?? s.ui.currentMap}`,
          y, false, () => {}, 'visit Home to act', 0x2a2a32,
        );
      }

      if (isHomeView && tile.owner === 'wild' && s.selection.tileId === tile.id) {
        const cost = tilePrice(tile, s);
        y = this.addActionButton(`Buy cash`, y, s.player.cash >= cost, () => {
          const r = buyTile(s, tile, { mode: 'cash' });
          if (!r.ok && r.reason) pushLog(s, r.reason);
          this.refreshAll();
        }, `$${cost}`);
        const q = tileFinanceQuote(s, tile);
        const enable = q != null && s.player.cash >= q.downPayment;
        const hint = q
          ? `$${q.downPayment} down · $${Math.round(q.monthlyPayment)}/mo × ${q.termMonths}mo @ ${(q.rate * 100).toFixed(1)}%`
          : 'unavailable';
        y = this.addActionButton(`Finance`, y, enable, () => {
          const r = buyTile(s, tile, { mode: 'finance' });
          if (!r.ok && r.reason) pushLog(s, r.reason);
          this.refreshAll();
        }, hint, 0x6a4cb2);
      }

      // === AI tile: offer to buy (home only) ================================
      if (isHomeView && tile.owner?.includes?.('_ai') && tile.countryId === 'home'
          && s.selection.tileId === tile.id) {
        const ai = s.aiFarmers.find(a => a.id === tile.owner);
        const market = tilePrice(tile, s);
        const startAmount = buyStartingAmount(tile, s);
        if (tile.pendingOffer && tile.pendingOffer.fromId === 'player') {
          y = this.addActionButton(
            `Offer pending: $${tile.pendingOffer.amount}`, y, false, () => {}, '', 0x4a4a32,
          );
        } else {
          y = this.addActionButton(
            `Offer to buy ${ai?.name ?? tile.owner}`,
            y, true,
            () => this.openOfferModal({ tile, mode: 'initiate' }),
            `from $${startAmount} (market $${market})`,
            0x6a4cb2,
          );
        }
      }

      // === Player tile with incoming offer (home only) ======================
      if (isHomeView && tile.owner === 'player' && tile.pendingOffer && tile.pendingOffer.fromId !== 'player'
          && s.selection.tileId === tile.id) {
        const ai = s.aiFarmers.find(a => a.id === tile.pendingOffer.fromId);
        const market = tilePrice(tile, s);
        const markup = ((tile.pendingOffer.amount - market) / market) * 100;
        const sign = markup >= 0 ? '+' : '';
        y = this.addActionButton(
          `Offer from ${ai?.name ?? tile.pendingOffer.fromId}: $${tile.pendingOffer.amount}`,
          y, false, () => {}, `vs market $${market} (${sign}${markup.toFixed(0)}%)`, 0x244d3a,
        );
        y = this.addActionButton(`Accept`, y, true, () => {
          const r = acceptOffer(s, tile);
          if (!r.ok && r.reason) pushLog(s, r.reason);
          this.refreshAll();
        }, `+$${tile.pendingOffer.amount}`, 0x2a8a5a);
        y = this.addActionButton(`Reject`, y, true, () => {
          rejectOffer(s, tile);
          this.refreshAll();
        }, '', 0x8a3a3a);
        y = this.addActionButton(`Counter offer…`, y, true, () => {
          this.openOfferModal({ tile, mode: 'counter' });
        }, '', 0x6a4cb2);
      }

      if (isHomeView && tile.owner === 'player' && s.selection.tileId === tile.id) {
        // Plow only makes sense for crops.
        if (tile.state === 'fallow' && (tile.lockType == null || tile.lockType === 'crop')) {
          const plowEffective = effectivePlowCost(s, tile.countryId);
          y = this.addActionButton(`Plow`, y, s.player.cash >= plowEffective, () => {
            const r = plowTile(s, tile); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll();
          }, `$${plowEffective}`);
        }
        // Plowed tile → crops that need plowing.
        if (tile.state === 'plowed') {
          for (const def of PRODUCIBLE_LIST) {
            if (def.category === 'processed') continue;        // industry-only outputs
            if (def.requiresPlow === false) continue;
            const wantLock = lockTypeForCategory(def.category);
            if (tile.lockType && wantLock && tile.lockType !== wantLock) continue;
            const setupEff = effectiveSetupCost(s, tile.countryId, def);
            y = this.addActionButton(
              `${def.actionVerb || 'Plant'} ${def.name}`,
              y,
              s.player.cash >= setupEff,
              () => { const r = plantTile(s, tile, def.id); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll(); },
              `$${setupEff} · ${def.growthDays}d`,
            );
          }
        }
        // Manual harvest button — only shown when tile is mature AND owner is in
        // manual mode (autoMode off). Clicking it = the player did the harvest
        // themselves, so NO labor cost is charged. Auto-mode tiles harvest on their
        // own and pay harvestCost via autoHarvest.
        if (tile.state === 'mature' && tile.crop && tile.autoMode !== true) {
          const def = PRODUCIBLES[tile.crop];
          const yieldEst = expectedYield(def, effectiveQualityFor(def, tile));
          const priceNow = Math.round(s.market.prices?.[tile.countryId]?.[def.id] || 0);
          y = this.addActionButton(
            `🌾 Harvest ${def.name}`,
            y, true,
            () => { harvestTile(s, tile); this.refreshAll(); },
            `+$${yieldEst * priceNow} · no labor cost`,
            0x2a8a5a,
          );
        }

        // Auto-manage switch — when ON, the tile hires labor: auto-harvests
        // (paying harvestCost) AND auto-replants annuals (paying setup again).
        // Manual mode = player clicks Harvest themselves for $0 labor.
        if (tile.crop && tile.owner === 'player') {
          const def = PRODUCIBLES[tile.crop];
          const isAuto = tile.autoMode === true;
          const labor = effectiveHarvestCost(s, tile.countryId, def);
          const plow = def.requiresPlow ? effectivePlowCost(s, tile.countryId) : 0;
          const setup = effectiveSetupCost(s, tile.countryId, def) + plow;
          const hint = isAuto
            ? `auto-harvest $${labor} + replants ($${setup}/cycle)`
            : 'click harvest yourself · no labor cost';
          y = this.addToggleSwitch(
            '🤖 Auto-manage', y, isAuto,
            () => { tile.autoMode = !tile.autoMode; this.refreshAll(); },
            hint,
          );
        }

        // Uproot button — works on any crop venture. Tile returns to fallow but lockType is preserved.
        if (tile.crop && tile.owner === 'player') {
          y = this.addActionButton(
            '🪓 Uproot',
            y, true,
            () => { uprootTile(s, tile); this.refreshAll(); },
            'clears venture · tile category lock stays',
            0x8a3a3a,
          );
        }

      }
    }

    // Countries / market / events / log used to render here. They live in their
    // dedicated modals now (🌍 World, 📈 Market, ⚡ Events).
  }

  ownerLabel(tile) {
    if (tile.owner === 'player') return 'YOU';
    if (tile.owner === 'wild') return 'free';
    if (tile.owner === 'developer') return 'developer';
    if (tile.owner === 'city') return 'city';
    if (tile.owner?.includes('_ai') || tile.owner?.startsWith('ai')) {
      const ai = this.state.aiFarmers.find(a => a.id === tile.owner);
      return ai ? ai.name : tile.owner;
    }
    return tile.owner;
  }

  // -----------------------------------------------------------------------
  // BANK MODAL
  // -----------------------------------------------------------------------
  buildBankModal() {
    this.bankGroup = this.add.container(0, 0).setVisible(false).setDepth(50);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.65)
      .setOrigin(0, 0).setInteractive();
    this.bankGroup.add(backdrop);

    const cardW = 540, cardH = 460;
    const cardX = (GAME_WIDTH - cardW) / 2, cardY = (GAME_HEIGHT - cardH) / 2;
    const card = this.add.rectangle(cardX, cardY, cardW, cardH, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0x6ee7b7);
    this.bankGroup.add(card);

    const title = this.add.text(cardX + 18, cardY + 14, '🏦  BANK', {
      fontFamily: 'monospace', fontSize: '20px', color: '#6ee7b7', fontStyle: 'bold',
    });
    this.bankGroup.add(title);

    const closeBtn = this.add.rectangle(cardX + cardW - 36, cardY + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(cardX + cardW - 24, cardY + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerdown', () => this.toggleBank(false));
    this.bankGroup.add(closeBtn);
    this.bankGroup.add(closeTxt);

    this.bankActiveTitle = this.add.text(cardX + 18, cardY + 56, 'ACTIVE LOANS', {
      fontFamily: 'monospace', fontSize: '11px', color: '#7a8694',
    });
    this.bankActiveText = this.add.text(cardX + 18, cardY + 74, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3', wordWrap: { width: cardW - 36 },
    });
    this.bankGroup.add(this.bankActiveTitle);
    this.bankGroup.add(this.bankActiveText);

    this.bankApplyTitle = this.add.text(cardX + 18, cardY + 200, 'APPLY FOR A LOAN', {
      fontFamily: 'monospace', fontSize: '11px', color: '#7a8694',
    });
    this.bankGroup.add(this.bankApplyTitle);

    this.bankCard = { x: cardX, y: cardY, w: cardW, h: cardH };
    this.bankApplyButtons = [];

    this.buildInfoPopover();
  }

  // Info popover — shown above the bank modal when an "i" icon is clicked.
  buildInfoPopover() {
    this.infoGroup = this.add.container(0, 0).setVisible(false).setDepth(60);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.55)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.infoGroup.setVisible(false));
    this.infoGroup.add(backdrop);

    const w = 460, h = 280;
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xffb347).setInteractive();
    this.infoGroup.add(card);

    this.infoText = this.add.text(x + 18, y + 18, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
      wordWrap: { width: w - 36 }, lineSpacing: 3,
    });
    this.infoGroup.add(this.infoText);

    const closeBtn = this.add.rectangle(x + w - 36, y + 12, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 24, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerdown', () => this.infoGroup.setVisible(false));
    this.infoGroup.add(closeBtn);
    this.infoGroup.add(closeTxt);
  }

  showInfo(text) {
    this.infoText.setText(text);
    this.infoGroup.setVisible(true);
  }

  // Compact [i] icon. Click → opens the global info popover with `text`.
  // Returns the two gameobjects (bg, txt) so callers can track them for
  // cleanup. `parentGroup` is the container the icon belongs to (so it
  // inherits visibility / depth). `x,y` is the top-left of the icon.
  addInfoIcon(parentGroup, trackArr, x, y, text, depth = 58) {
    const size = 12;
    const bg = this.add.rectangle(x, y, size, size, 0x243345)
      .setOrigin(0, 0).setStrokeStyle(1, 0x6ee7b7)
      .setInteractive({ useHandCursor: true }).setDepth(depth);
    const txt = this.add.text(x + size / 2, y + size / 2, 'i', {
      fontFamily: 'monospace', fontSize: '9px', color: '#6ee7b7', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(depth + 1);
    bg.on('pointerover', () => bg.setFillStyle(0x3a4d63));
    bg.on('pointerout', () => bg.setFillStyle(0x243345));
    bg.on('pointerdown', () => this.showInfo(text));
    parentGroup.add(bg); parentGroup.add(txt);
    trackArr.push(bg, txt);
    return { bg, txt };
  }

  // -----------------------------------------------------------------------
  // COUNTRY CHART MODAL
  // -----------------------------------------------------------------------
  buildCountryChart() {
    this.chartGroup = this.add.container(0, 0).setVisible(false).setDepth(55);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.65)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.closeCountryChart());
    this.chartGroup.add(backdrop);

    // Fixed-height card: title bar at top, country info block, market table
    // (scrollable). Body adapts but card stays fixed so scroll is meaningful.
    const w = 600;
    const h = Math.min(GAME_HEIGHT - 16, 560);
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xcdd6df).setInteractive();
    this.chartGroup.add(card);

    this.chartTitle = this.add.text(x + 18, y + 14, '', {
      fontFamily: 'monospace', fontSize: '18px', color: '#e8edf3', fontStyle: 'bold',
    });
    this.chartGroup.add(this.chartTitle);

    const closeBtn = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerover', () => closeBtn.setFillStyle(0x3a6090));
    closeBtn.on('pointerout', () => closeBtn.setFillStyle(0x2a4a6a));
    closeBtn.on('pointerdown', () => this.closeCountryChart());
    this.chartGroup.add(closeBtn);
    this.chartGroup.add(closeTxt);

    // Vertical anchors. Country info block sits between title and the
    // scrollable market table. New layout adds a window selector and a food
    // basket strip between demographics and the per-producible flow rows.
    const infoTop = y + 46;
    const windowSelY = y + 196;            // demographics uses ~150px
    const basketTop = y + 222;             // 26px for window selector
    const marketTop = y + 304;             // 82px for basket
    const marketBottom = y + h - 24;       // 24px for legend at bottom

    this.chartCard = { x, y, w, h, infoTop, windowSelY, basketTop, marketTop, marketBottom };
    this.chartGfx = this.add.graphics().setDepth(56);
    this.chartGroup.add(this.chartGfx);
    this.chartLabels = [];
    // Interactive window-selector buttons. Lazy-built on first openCountryChart
    // so the geometry uses the chartCard layout already computed.
    this.windowBtns = null;

    // Wheel scroll for the market table body.
    this.bindWheelScroll(card, 'countryChart',
      () => this.computeCountryChartMaxScroll(),
      () => this.refreshCountryChart());
  }

  // Window-selector buttons (1d / 7d / 30d / 90d). Switching re-renders.
  ensureWindowButtons() {
    if (this.windowBtns) return;
    const { x, w, windowSelY } = this.chartCard;
    const opts = [
      { label: '1d', days: 1 },
      { label: '7d', days: 7 },
      { label: '30d', days: 30 },
      { label: '90d', days: 90 },
    ];
    const btnW = 44, btnH = 20, gap = 6;
    const totalW = opts.length * btnW + (opts.length - 1) * gap;
    let cx = x + w - totalW - 18;
    this.windowBtns = [];
    for (const opt of opts) {
      const bg = this.add.rectangle(cx, windowSelY, btnW, btnH, 0x243345)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(57);
      const txt = this.add.text(cx + btnW / 2, windowSelY + btnH / 2, opt.label, {
        fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df',
      }).setOrigin(0.5).setDepth(58);
      bg.on('pointerdown', () => {
        this.state.ui.countryChartWindow = opt.days;
        this.refreshCountryChart();
      });
      this.chartGroup.add(bg); this.chartGroup.add(txt);
      this.windowBtns.push({ bg, txt, days: opt.days });
      cx += btnW + gap;
    }
    // Label "Window:" to the left of the buttons
    const lbl = this.add.text(x + w - totalW - 18 - 8, windowSelY + btnH / 2,
      'Window:', { fontFamily: 'monospace', fontSize: '10px', color: '#7a8694' })
      .setOrigin(1, 0.5).setDepth(58);
    this.chartGroup.add(lbl);
  }

  computeCountryChartMaxScroll() {
    const rowH = 36;
    const visibleH = this.chartCard.marketBottom - this.chartCard.marketTop - 30; // minus header
    return Math.max(0, (PRODUCIBLE_LIST?.length ?? 8) * rowH - visibleH);
  }

  openCountryChart(countryId) {
    this.chartCountryId = countryId;
    if (!this.state.ui.countryChartOpen) {
      this.enterModal();
    }
    if (this.state.ui.countryChartWindow == null) this.state.ui.countryChartWindow = 7;
    this.state.ui.countryChartOpen = true;
    this.chartGroup.setVisible(true);
    this.ensureWindowButtons();
    this.refreshCountryChart();
    this.refreshTopBar();
  }

  // Lazily build a Visit button on the country-chart card. Re-uses one button across opens.
  // Positioned in the title bar (right side, left of the close button) so it
  // doesn't overlap the demographics/economy info block below.
  ensureVisitButton(countryId) {
    if (!this.chartCard) return;
    const { x, y, w } = this.chartCard;
    const labelTxt = `Visit ${COUNTRIES[countryId]?.name ?? countryId} →`;
    const btnW = 140;
    const btnH = 24;
    const btnX = x + w - 36 - btnW - 6;        // 36px close button + 6px gap
    const btnY = y + 14;
    if (!this.visitBtnBg) {
      this.visitBtnBg = this.add.rectangle(btnX, btnY, btnW, btnH, 0xffb347)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(57);
      this.visitTxt = this.add.text(btnX + btnW / 2, btnY + btnH / 2, labelTxt, {
        fontFamily: 'monospace', fontSize: '11px', color: '#0f1923', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(58);
      this.visitBtnBg.on('pointerover', () => this.visitBtnBg.setFillStyle(0xffc878));
      this.visitBtnBg.on('pointerout', () => this.visitBtnBg.setFillStyle(0xffb347));
      this.visitBtnBg.on('pointerdown', () => {
        const target = this.chartCountryId;
        this.closeCountryChart();
        this.switchMap(target);
      });
      this.chartGroup.add(this.visitBtnBg);
      this.chartGroup.add(this.visitTxt);
    } else {
      this.visitBtnBg.setPosition(btnX, btnY);
      this.visitTxt.setPosition(btnX + btnW / 2, btnY + btnH / 2);
      this.visitTxt.setText(labelTxt);
    }
  }

  closeCountryChart() {
    if (this.state.ui.countryChartOpen) {
      this.exitModal();
    }
    this.state.ui.countryChartOpen = false;
    this.chartGroup.setVisible(false);
    this.refreshTopBar();
  }

  refreshCountryChart() {
    const s = this.state;
    const countryId = this.chartCountryId;
    if (!countryId) return;
    const reg = COUNTRIES[countryId];
    const run = s.countries[countryId];
    if (!reg || !run) return;

    this.chartTitle.setText(reg.name);
    this.chartTitle.setColor(`#${reg.flagColor.toString(16).padStart(6, '0')}`);
    this.ensureVisitButton(countryId);

    // Clear old labels.
    for (const node of this.chartLabels) node.destroy();
    this.chartLabels = [];
    this.chartGfx.clear();

    const { x, y, w, infoTop, marketTop, marketBottom } = this.chartCard;

    // ============================================================
    // INFO BLOCK — country snapshot
    // ============================================================
    // Count crop ventures owned by AI farmers/player in this country.
    let nCropActive = 0, nCropFallow = 0;
    const map = s.maps?.[countryId];
    if (map) {
      for (const tile of map.tiles) {
        if (!tile.crop) continue;
        if (tile.owner === 'wild' || tile.owner === 'developer' || tile.owner === 'city') continue;
        const def = PRODUCIBLES[tile.crop];
        if (!def || def.category === 'processed') continue;
        if (tile.state === 'fallow' || tile.state === 'plowed') nCropFallow++;
        else nCropActive++;
      }
    }

    const wf = Math.round(run.wageFund || 0);
    const tr = Math.round(run.treasury || 0);
    const mp = Math.round(run.marketPool || 0);
    const pi = (run.priceIndex || 1).toFixed(2);
    const piPct = Math.round(((run.priceIndex || 1) - 1) * 100);
    const piSign = piPct >= 0 ? '+' : '';
    const wage = Math.round(wageRateFor(s, countryId));
    const demand = Math.round(run.laborDemand || 0);
    const supply = (run.laborSupply || 0).toFixed(1);
    const tightnessVal = run.laborSupply > 0 ? (run.laborDemand / run.laborSupply) : 0;
    const tightnessStr = Math.sqrt(Math.max(0, tightnessVal)).toFixed(2);
    const crisis = run.fiscalCrisis?.active ? '  🚨 CRISIS' : '';

    // Two-column layout for readability.
    const colA = x + 18, colB = x + w / 2 + 8;
    const lineH = 14;
    const ls = (cx, cy, str, color = '#cdd6df', size = '11px') => {
      const t = this.add.text(cx, cy, str, {
        fontFamily: 'monospace', fontSize: size, color,
      }).setDepth(57);
      this.chartGroup.add(t); this.chartLabels.push(t);
    };

    // Section header
    ls(colA, infoTop, '── DEMOGRAPHICS ──', '#7a8694', '10px');

    // Row helper: prints the label text and an [i] icon to its right with the
    // given explanation. Keeps the demographics/economy block readable and
    // teaches the player what each economic knob actually does.
    const colWidth = w / 2 - 26;
    const iconGap = 4;
    const rowWithInfo = (cx, cy, str, color, infoText) => {
      const t = this.add.text(cx, cy, str, {
        fontFamily: 'monospace', fontSize: '11px', color: color ?? '#cdd6df',
      }).setDepth(57);
      this.chartGroup.add(t); this.chartLabels.push(t);
      const iconX = cx + colWidth - 12 - iconGap;
      this.addInfoIcon(this.chartGroup, this.chartLabels, iconX, cy + 1, infoText, 57);
    };

    rowWithInfo(colA, infoTop + lineH * 1,
      `Population: ${Math.round(run.population)} people`, '#cdd6df',
      'POPULATION\n\n' +
      'How many people live in this town. Grows each year at the region\'s rate (with noise).\n\n' +
      'Affects:\n' +
      '• Labor supply (= population × 0.5)\n' +
      '• Daily food consumption (consumption × pop ratio)\n' +
      '• Tax base (more buyers = more sale tax)\n\n' +
      'Affected by: yearly growth and events that scale population.');

    rowWithInfo(colA, infoTop + lineH * 2,
      `Labor supply: ${supply}`, '#9aa4ad',
      'LABOR SUPPLY\n\n' +
      'Workers available in this town.\n\n' +
      'Formula: population × WAGES.workersPerPopUnit (0.5).\n\n' +
      'The "supply side" of the labor market — together with labor demand it sets the tightness, and tightness drives the wage.\n\n' +
      'Affected by: population changes (yearly growth, events).');

    rowWithInfo(colA, infoTop + lineH * 3,
      `Labor demand: ${demand}`, '#9aa4ad',
      'LABOR DEMAND\n\n' +
      'Active jobs in this town.\n\n' +
      'Sum of:\n' +
      '• 1 worker per crop tile in cultivation (any crop, same cost)\n\n' +
      'Goes up when crop tiles go active. Drops when they go fallow.');

    rowWithInfo(colA, infoTop + lineH * 4,
      `Wage: $${wage}/mo·worker  (×${tightnessStr})`,
      tightnessVal > 1.5 ? '#ff8c8c' : tightnessVal < 0.5 ? '#8cffaa' : '#cdd6df',
      'WAGE (market wage)\n\n' +
      'Emergent wage from the town\'s labor market. Cost of 1 worker per month.\n\n' +
      'Formula: target = WAGES.baseWage (50) × √(demand / supply).\n' +
      'actual wage = 60-day EMA of target (smooths spikes).\n\n' +
      '×tightness is the current pressure = √(demand/supply). >1 = tight market (wage rising). <1 = labor surplus (wage falling).\n\n' +
      'Affects EVERY labor cost:\n' +
      '• Crop harvest cost (harvestLabor × wage)\n' +
      '• Plow / storage costs\n\n' +
      'NOT multiplied by priceIndex — wage is independent of cost-of-living.');

    ls(colB, infoTop, '── ECONOMY ──', '#7a8694', '10px');

    rowWithInfo(colB, infoTop + lineH * 1,
      `Wage fund: $${wf.toLocaleString()}`, '#cdd6df',
      'WAGE FUND\n\n' +
      'The town\'s accumulated wage pot. This is the cash population has available to spend on food.\n\n' +
      'Money flows in from:\n' +
      '• Harvest cost / plow / storage cost\n' +
      '• Welfare top-up from treasury when it falls below floor\n\n' +
      'Money flows out to:\n' +
      '• Population buying food daily (goes to marketPool)\n\n' +
      'If it drops under the floor (10 days × nutritional demand), treasury refills the gap.');

    rowWithInfo(colB, infoTop + lineH * 2,
      `Treasury: $${tr.toLocaleString()}${crisis}`, tr < 0 ? '#ff7a7a' : '#cdd6df',
      'TREASURY\n\n' +
      'The town government\'s cash reserves.\n\n' +
      'Money flows in from:\n' +
      '• Sale tax (population buying)\n' +
      '• B2B tax (company-to-company purchases)\n' +
      '• Import tax (cross-country purchases)\n\n' +
      'Money flows out to:\n' +
      '• Welfare top-up to wageFund when needed\n' +
      '• Subsidies during fiscal crisis\n\n' +
      'If it stays deeply negative → fiscal crisis (wage haircut on salary deposits, preference crush on premium foods).');

    rowWithInfo(colB, infoTop + lineH * 3,
      `Market pool: $${mp.toLocaleString()}`, '#cdd6df',
      'MARKET POOL\n\n' +
      'Cash pool of the town\'s wholesale market. Acts as the invisible middleman between producers and consumers.\n\n' +
      'Money flows in from:\n' +
      '• Population buying from market\n\n' +
      'Money flows out to:\n' +
      '• Player / AI selling into market\n\n' +
      'If it dries up: sales into this pool fail.');

    rowWithInfo(colB, infoTop + lineH * 4,
      `priceIndex: ${pi} (${piSign}${piPct}%)`, Math.abs(piPct) > 30 ? '#ff8c8c' : '#cdd6df',
      'PRICE INDEX (cost-of-living)\n\n' +
      'Index of the town\'s average basket price vs its base level. 1.00 = baseline. 1.20 = 20% more expensive than start.\n\n' +
      'Computed as: EMA of current basket prices / base basket prices.\n\n' +
      'Affects:\n' +
      '• Industry build cost\n' +
      '• tilePrice (buying land)\n' +
      '• Plow / setup cost (the commodity portion)\n\n' +
      'Does NOT affect wage (which comes from the labor market, not the basket).');

    // Ventures row
    const venturesY = infoTop + lineH * 6;
    ls(colA, venturesY, '── VENTURES ──', '#7a8694', '10px');

    rowWithInfo(colA, venturesY + lineH * 1,
      `🌾 Crop tiles: ${nCropActive} growing · ${nCropFallow} fallow/plowed`, '#cdd6df',
      'CROP TILES\n\n' +
      '• growing: planted or mature, in mid-cycle. Add 1 worker to labor demand.\n' +
      '• fallow / plowed: no active crop. No labor cost but may retain a "crop" lockType if previously cultivated.\n\n' +
      'Plant setup cost = setupLabor × wage + 0.1 × product market price (seed).\n' +
      'Harvest cost = harvestLabor × wage. Yield depends on tile.quality.');

    // ============================================================
    // WINDOW SELECTOR — visual highlight del activo
    // ============================================================
    const windowDays = s.ui.countryChartWindow ?? 7;
    ls(x + 18, s.ui.countryChartWindow ? this.chartCard.windowSelY + 4 : this.chartCard.windowSelY + 4,
      '── REAL FLOW (last) ──', '#7a8694', '10px');
    if (this.windowBtns) {
      for (const b of this.windowBtns) {
        const active = b.days === windowDays;
        b.bg.setFillStyle(active ? 0xffb347 : 0x243345);
        b.txt.setColor(active ? '#1a1a1a' : '#cdd6df');
      }
    }

    // Aggregations: sum over last `windowDays` of consumptionHistory / supplyHistory.
    // Reused helper — same path both sections.
    const aggSum = (arr) => {
      if (!arr || arr.length === 0) return 0;
      const slice = arr.slice(-windowDays);
      let s = 0;
      for (const v of slice) s += v || 0;
      return s;
    };

    // ============================================================
    // SECTION A — FOOD BASKET (lo que compró la población realmente)
    // Stacked horizontal bar mostrando share por food de la canasta total.
    // Datos: consumptionHistory[pid] para isFood(pid) sumado sobre ventana.
    // ============================================================
    const basketY = this.chartCard.basketTop;
    ls(x + 18, basketY, '── FOOD BASKET ──', '#7a8694', '10px');

    const foodBasket = [];
    let basketTotal = 0;
    for (const def of PRODUCIBLE_LIST) {
      if (def.commodityType !== 'food') continue;
      const units = aggSum(run.consumptionHistory?.[def.id]);
      if (units <= 0) continue;
      foodBasket.push({ def, units });
      basketTotal += units;
    }
    foodBasket.sort((a, b) => b.units - a.units);

    if (basketTotal <= 0) {
      ls(x + 18, basketY + 16, '(no food purchases recorded in this window)', '#566370', '10px');
    } else {
      // Stacked horizontal bar
      const barX = x + 18;
      const barY = basketY + 18;
      const barW = w - 36;
      const barH = 18;
      let cursor = barX;
      for (const item of foodBasket) {
        const segW = (item.units / basketTotal) * barW;
        this.chartGfx.fillStyle(item.def.color, 0.92);
        this.chartGfx.fillRect(cursor, barY, segW, barH);
        cursor += segW;
      }
      this.chartGfx.lineStyle(1, 0x3a4d63, 1);
      this.chartGfx.strokeRect(barX, barY, barW, barH);

      // Legend below bar: name pct unit, two columns if many items
      const legendY = barY + barH + 4;
      const colHalf = w / 2 - 12;
      foodBasket.forEach((item, i) => {
        const col = i < 4 ? 0 : 1;
        const row = i % 4;
        const cx = x + 18 + col * (colHalf + 4);
        const cy = legendY + row * 10;
        const pct = (item.units / basketTotal * 100).toFixed(0);
        const colHex = '#' + item.def.color.toString(16).padStart(6, '0');
        // Small color square
        const sq = this.add.rectangle(cx, cy + 4, 8, 8, item.def.color)
          .setOrigin(0, 0.5).setDepth(57);
        this.chartGroup.add(sq); this.chartLabels.push(sq);
        const lbl = this.add.text(cx + 12, cy,
          `${item.def.name} ${pct}% (${item.units.toFixed(0)}u)`, {
          fontFamily: 'monospace', fontSize: '9px', color: colHex,
        }).setDepth(57);
        this.chartGroup.add(lbl); this.chartLabels.push(lbl);
      });
    }

    // ============================================================
    // SECTION B — SUPPLY / DEMAND POR PRODUCIBLE (real flow, scrollable)
    // Reemplaza la tradeBalance vieja. Una fila por producible con dos barras
    // paralelas: supply (verde) y demand (rojo). Net explícito al lado.
    // Datos: supplyHistory / consumptionHistory sumados sobre ventana.
    // ============================================================
    const headerY = marketTop;
    ls(colA, headerY, '── SUPPLY vs DEMAND ──', '#7a8694', '10px');

    const rowsTop = marketTop + 16;
    const rowH = 36;
    const scrollY = (this.scrollState?.countryChart) || 0;

    const rows = PRODUCIBLE_LIST;
    const labelW = 90;
    const valueW = 80;
    const barAreaX = x + 20 + labelW;
    const barAreaW = w - 40 - labelW - valueW;

    const rowsAgg = rows.map(def => {
      const supply = aggSum(run.supplyHistory?.[def.id]);
      const demand = aggSum(run.consumptionHistory?.[def.id]);
      return { def, supply, demand };
    });
    let maxFlow = 1;
    for (const r of rowsAgg) {
      if (r.supply > maxFlow) maxFlow = r.supply;
      if (r.demand > maxFlow) maxFlow = r.demand;
    }

    rowsAgg.forEach((agg, i) => {
      const cy = rowsTop + i * rowH - scrollY;
      const midY = cy + rowH / 2;
      if (cy + rowH < rowsTop || cy > marketBottom) return;

      const def = agg.def;
      const nameTxt = this.add.text(x + 20, midY, def.name, {
        fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
      }).setOrigin(0, 0.5).setDepth(57);
      this.chartGroup.add(nameTxt); this.chartLabels.push(nameTxt);

      const barH = 9;
      const sLen = (agg.supply / maxFlow) * barAreaW;
      const dLen = (agg.demand / maxFlow) * barAreaW;
      // Supply bar (arriba)
      this.chartGfx.fillStyle(0x6ee79a, 0.9);
      this.chartGfx.fillRect(barAreaX, midY - barH - 1, sLen, barH);
      // Demand bar (abajo)
      this.chartGfx.fillStyle(0xff6b6b, 0.9);
      this.chartGfx.fillRect(barAreaX, midY + 1, dLen, barH);
      // Axis line
      this.chartGfx.lineStyle(1, 0x3a4d63, 0.6);
      this.chartGfx.lineBetween(barAreaX, midY + barH + 2, barAreaX + barAreaW, midY + barH + 2);

      const net = agg.supply - agg.demand;
      const netColor = net > 0.5 ? '#8cffaa' : net < -0.5 ? '#ff8c8c' : '#7a8694';
      const netSign = net > 0 ? '+' : '';
      const netTxt = this.add.text(barAreaX + barAreaW + 6, midY,
        `${netSign}${net.toFixed(0)}`, {
        fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold', color: netColor,
      }).setOrigin(0, 0.5).setDepth(57);
      this.chartGroup.add(netTxt); this.chartLabels.push(netTxt);
    });

    // Scroll indicator on right edge if there's overflow.
    const maxScroll = this.computeCountryChartMaxScroll();
    if (maxScroll > 0) {
      const trackH = marketBottom - rowsTop;
      const thumbH = Math.max(20, trackH * (trackH / (trackH + maxScroll)));
      const thumbY = rowsTop + (scrollY / maxScroll) * (trackH - thumbH);
      const thumb = this.add.rectangle(x + w - 10, thumbY, 4, thumbH, 0xcdd6df, 0.6)
        .setOrigin(0, 0).setDepth(57);
      this.chartGroup.add(thumb); this.chartLabels.push(thumb);
    }
  }

  toggleBank(open) {
    const s = this.state;
    if (open && !s.ui.bankOpen) {
      this.enterModal();
      s.tutorial.bankOpened = true;
    } else if (!open && s.ui.bankOpen) {
      this.exitModal();
    }
    s.ui.bankOpen = open;
    persistTutorial(s);
    this.bankGroup.setVisible(open);
    if (open) this.refreshBankModal();
    this.refreshTopBar();
  }

  refreshBankModal() {
    const s = this.state;

    // Active loans
    const active = loansOf(s, 'player');
    if (active.length === 0) {
      this.bankActiveText.setText('No active loans.');
    } else {
      this.bankActiveText.setText(active.map(l => {
        const def = LOAN_PRODUCTS[l.productId];
        return `${def.name.padEnd(20)} bal $${Math.round(l.balance).toString().padStart(6)}  ` +
               `cuota $${Math.round(l.monthlyPayment).toString().padStart(5)}  ` +
               `${l.monthsRemaining} mo  ${(l.rate * 100).toFixed(1)}%`;
      }).join('\n'));
    }

    // Clear & rebuild rows
    for (const node of this.bankApplyButtons) node.destroy();
    this.bankApplyButtons = [];

    // Iterate the registry. Each product decides via `showInBankMenu` whether it
    // appears in the standalone bank list. Ineligible-but-listed products render
    // greyed out with the gating reason — adding a new product is still a single
    // entry in loanProducts.js with no UI changes.
    const products = LOAN_PRODUCT_LIST.filter(p => p.showInBankMenu !== false);

    let y = this.bankCard.y + 226;
    for (const product of products) {
      const elig = product.eligibility(s, { borrowerId: 'player' });
      const max = resolveMaxPrincipal(product, s, { borrowerId: 'player' });
      const min = product.minPrincipal;
      const step = product.step ?? 1000;
      if (s.ui.bankApply[product.id] == null) s.ui.bankApply[product.id] = min;
      let principal = Math.max(min, Math.min(max, s.ui.bankApply[product.id]));
      principal = Math.round(principal / step) * step;
      principal = Math.max(min, Math.min(max, principal));
      s.ui.bankApply[product.id] = principal;

      this.renderLoanRow(product, principal, min, max, step, y, elig);
      y += 38;
    }
  }

  renderLoanRow(product, principal, min, max, step, y, elig = { ok: true }) {
    const s = this.state;
    const x0 = this.bankCard.x + 18;
    const rowW = this.bankCard.w - 36;
    const enabled = elig.ok;

    // Stepper: [-]  $1,000  [+]
    const stepW = 30, amountW = 78;
    const stepperW = stepW * 2 + amountW + 8;
    const infoW = 24, gap = 6;
    const stepperFill = enabled ? 0x2a4a6a : 0x1d2a3a;
    const stepperTextColor = enabled ? '#e8edf3' : '#566370';

    const minusBg = this.add.rectangle(x0, y, stepW, 28, stepperFill)
      .setOrigin(0, 0).setDepth(51);
    if (enabled) minusBg.setInteractive({ useHandCursor: true });
    const minusTxt = this.add.text(x0 + stepW / 2, y + 14, '−', {
      fontFamily: 'monospace', fontSize: '15px', color: stepperTextColor, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(52);

    const amountTxt = this.add.text(x0 + stepW + 4 + amountW / 2, y + 14, `$${principal.toLocaleString()}`, {
      fontFamily: 'monospace', fontSize: '12px', color: enabled ? '#ffb347' : '#7a8694', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(52);

    const plusBg = this.add.rectangle(x0 + stepW + amountW + 8, y, stepW, 28, stepperFill)
      .setOrigin(0, 0).setDepth(51);
    if (enabled) plusBg.setInteractive({ useHandCursor: true });
    const plusTxt = this.add.text(x0 + stepW + amountW + 8 + stepW / 2, y + 14, '+', {
      fontFamily: 'monospace', fontSize: '15px', color: stepperTextColor, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(52);

    if (enabled) {
      const setAmount = (next) => {
        const clamped = Math.max(min, Math.min(max, next));
        s.ui.bankApply[product.id] = Math.round(clamped / step) * step;
        this.refreshBankModal();
      };
      minusBg.on('pointerdown', () => setAmount(principal - step));
      plusBg.on('pointerdown', () => setAmount(principal + step));
      minusBg.on('pointerover', () => minusBg.setFillStyle(0x3a6090));
      minusBg.on('pointerout', () => minusBg.setFillStyle(stepperFill));
      plusBg.on('pointerover', () => plusBg.setFillStyle(0x3a6090));
      plusBg.on('pointerout', () => plusBg.setFillStyle(stepperFill));
    }

    // Apply button (or disabled state with reason)
    const applyX = x0 + stepperW + gap;
    const applyW = rowW - stepperW - gap - infoW - gap;
    const q = enabled ? quoteLoan(s, product.id, principal, { borrowerId: 'player' }) : null;
    const monthly = q ? Math.round(q.monthlyPayment) : 0;
    const label = enabled
      ? `Apply ${product.name} · ${(product.annualRate * 100).toFixed(0)}% · ${product.termMonths}mo · $${monthly}/mo   (max $${max.toLocaleString()})`
      : `${product.name} · ${(product.annualRate * 100).toFixed(0)}% · ${product.termMonths}mo  —  locked: ${elig.reason}`;
    const applyFill = enabled ? 0x6a4cb2 : 0x1d2a3a;
    const applyBg = this.add.rectangle(applyX, y, applyW, 28, applyFill)
      .setOrigin(0, 0).setDepth(51);
    if (enabled) applyBg.setInteractive({ useHandCursor: true });
    const applyTxt = this.add.text(applyX + 10, y + 14, label, {
      fontFamily: 'monospace', fontSize: '10px', color: enabled ? '#e8edf3' : '#7a8694',
    }).setOrigin(0, 0.5).setDepth(52);
    if (enabled) {
      applyBg.on('pointerover', () => applyBg.setFillStyle(0x8a6cd2));
      applyBg.on('pointerout', () => applyBg.setFillStyle(applyFill));
      applyBg.on('pointerdown', () => {
        const r = applyForLoan(s, product.id, principal, { borrowerId: 'player' });
        if (!r.ok) pushLog(s, r.reason);
        this.refreshAll();
      });
    }

    // Info button — opens popover with product.description
    const infoX = applyX + applyW + gap;
    const infoBg = this.add.rectangle(infoX, y, infoW, 28, 0x243345)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(51).setStrokeStyle(1, 0x6ee7b7);
    const infoTxt = this.add.text(infoX + infoW / 2, y + 14, 'i', {
      fontFamily: 'monospace', fontSize: '13px', color: '#6ee7b7', fontStyle: 'italic',
    }).setOrigin(0.5).setDepth(52);
    infoBg.on('pointerover', () => infoBg.setFillStyle(0x3a4d63));
    infoBg.on('pointerout', () => infoBg.setFillStyle(0x243345));
    infoBg.on('pointerdown', () => this.showInfo(product.description ?? product.name));

    for (const node of [minusBg, minusTxt, amountTxt, plusBg, plusTxt, applyBg, applyTxt, infoBg, infoTxt]) {
      this.bankGroup.add(node);
      this.bankApplyButtons.push(node);
    }
  }

  // -----------------------------------------------------------------------
  // TUTORIAL OVERLAY
  // -----------------------------------------------------------------------
  buildTutorialOverlay() {
    this.tutorialGroup = this.add.container(0, 0).setVisible(false).setDepth(40);

    const w = 580, h = 110;
    const x = (GAME_WIDTH - w) / 2, y = GAME_HEIGHT - h - 14;
    const bg = this.add.rectangle(x, y, w, h, 0x131e2b).setOrigin(0, 0).setStrokeStyle(2, 0xffb347);
    this.tutorialGroup.add(bg);

    this.tutorialTitle = this.add.text(x + 14, y + 10, '', {
      fontFamily: 'monospace', fontSize: '13px', color: '#ffb347', fontStyle: 'bold',
    });
    this.tutorialBody = this.add.text(x + 14, y + 32, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df', wordWrap: { width: w - 140 },
    });
    this.tutorialGroup.add(this.tutorialTitle);
    this.tutorialGroup.add(this.tutorialBody);

    const btnW = 100;
    const nextBg = this.add.rectangle(x + w - btnW - 14, y + h - 36, btnW, 24, 0xffb347)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const nextTxt = this.add.text(x + w - btnW / 2 - 14, y + h - 24, 'Next →', {
      fontFamily: 'monospace', fontSize: '11px', color: '#1a1a1a', fontStyle: 'bold',
    }).setOrigin(0.5);
    nextBg.on('pointerdown', () => this.tutorialAdvance());
    this.tutorialGroup.add(nextBg);
    this.tutorialGroup.add(nextTxt);

    const skipBg = this.add.rectangle(x + w - btnW - 14 - 90, y + h - 36, 84, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const skipTxt = this.add.text(x + w - btnW - 14 - 48, y + h - 24, 'Skip', {
      fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
    }).setOrigin(0.5);
    skipBg.on('pointerdown', () => this.tutorialSkip());
    this.tutorialGroup.add(skipBg);
    this.tutorialGroup.add(skipTxt);
  }

  refreshTutorial() {
    const s = this.state;
    if (s.tutorial.dismissed || s.tutorial.stepIdx >= TUTORIAL_STEPS.length) {
      this.tutorialGroup.setVisible(false);
      return;
    }
    const step = TUTORIAL_STEPS[s.tutorial.stepIdx];
    this.tutorialGroup.setVisible(true);
    this.tutorialTitle.setText(`Step ${s.tutorial.stepIdx + 1}/${TUTORIAL_STEPS.length} · ${step.title}`);
    this.tutorialBody.setText(step.body);

    // Auto-advance if gate satisfied
    if (step.gate(s)) this.tutorialAdvance();
  }

  tutorialAdvance() {
    this.state.tutorial.stepIdx += 1;
    if (this.state.tutorial.stepIdx >= TUTORIAL_STEPS.length) {
      this.state.tutorial.dismissed = true;
    }
    persistTutorial(this.state);
    this.refreshTutorial();
  }

  tutorialSkip() {
    this.state.tutorial.dismissed = true;
    persistTutorial(this.state);
    this.refreshTutorial();
  }

  // -----------------------------------------------------------------------
  // MAIN LOOP
  // -----------------------------------------------------------------------
  refreshAll() {
    this.refreshCity();
    this.refreshTiles();
    this.refreshOfferMarkers();
    this.refreshTopBar();
    this.refreshPanel();
    if (this.state.ui.bankOpen) this.refreshBankModal();
    if (this.state.ui.countryChartOpen) this.refreshCountryChart();
    if (this.state.ui.offerOpen) this.refreshOfferModal();
    if (this.state.ui.marketOpen) this.refreshMarketModal();
    if (this.state.ui.priceChartOpen) this.refreshPriceChartModal();
    if (this.state.ui.stockChartOpen) this.refreshStockChartModal();
    if (this.state.ui.eventsOpen) this.refreshEventsModal();
    if (this.state.ui.companiesOpen) this.refreshCompaniesModal();
    this.refreshTutorial();
  }

  update(_time, delta) {
    const events = tickClock(this.state, delta);
    // Canonical daily/monthly/yearly tick order (per plan section 7c):
    if (events.day) {
      // Bot toma decisiones ANTES de que avancen los sistemas — equivalente
      // a un humano que mira el state al final del día y clickea cosas para
      // el día siguiente.
      this.autoplay?.tickDay(this.state);
      tickEvents(this.state);
      tickFarming(this.state);          // 2: harvests → owner inventory
      tickMarket(this.state);           // 3: per-country supply/demand + cross-country trade + prices
      populationSpend(this.state);      // 5: country wage funds buy food (via executeTransaction)
      tickAI(this.state);               // 7: AI daily decisions (tickWages welfare baked into populationSpend)
      // Weekly cadence: AI vuelca inventario al market 1×/semana (antes 1×/mes).
      if (this.state.time.totalDays % 7 === 0) tickAIWeekly(this.state);
    }
    if (events.month) {
      tickStorageCost(this.state);      // 8c: warehouse labor for held inventory
      tickLaborMarket(this.state);      // 8d: update country wageRate via EMA
      tickLoans(this.state);            // 9: bank charges
      tickFiscalCrisis(this.state);     // 10: crisis state machine
      tickAIMonthly(this.state);        // 11: AI close, reopen, sell inventory
    }
    if (events.year) {
      tickCountriesYearly(this.state);
    }
    if (events.day) {
      this.refreshAll();
    } else {
      this.refreshTopBar();
      // Light refresh of tutorial only — gates may flip via UI clicks already handled.
    }

    // Drain visual FX queue every frame
    this.drainFxQueue();

    if (this.state.player.bankrupt) {
      this.scene.start('MainMenu', { bankrupt: true });
    }
  }

  // -----------------------------------------------------------------------
  // MARKET MODAL — view prices/charts per country, buy/sell from inventory.
  // Country tabs above the table; rows are scrollable so all producibles fit.
  // -----------------------------------------------------------------------
  buildMarketModal() {
    this.marketGroup = this.add.container(0, 0).setVisible(false).setDepth(56);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.7)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.toggleMarket(false));
    this.marketGroup.add(backdrop);

    // Fixed-height modal — body scrolls.
    const w = 760;
    const h = Math.min(GAME_HEIGHT - 12, 540);
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xffb347).setInteractive();
    this.marketGroup.add(card);

    const title = this.add.text(x + 18, y + 14, '📈  MARKET', {
      fontFamily: 'monospace', fontSize: '18px', color: '#ffb347', fontStyle: 'bold',
    });
    this.marketGroup.add(title);

    const closeBtn = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerover', () => closeBtn.setFillStyle(0x3a6090));
    closeBtn.on('pointerout', () => closeBtn.setFillStyle(0x2a4a6a));
    closeBtn.on('pointerdown', () => this.toggleMarket(false));
    this.marketGroup.add(closeBtn);
    this.marketGroup.add(closeTxt);

    // CSV export — dumps every (day × country × product) snapshot the
    // simulation has recorded so the user can hand the file back for AI
    // debugging. Lives next to the close button (static title bar).
    const csvW = 96;
    const csvBg = this.add.rectangle(x + w - 36 - csvW - 6, y + 14, csvW, 24, 0x2a4a30)
      .setOrigin(0, 0).setStrokeStyle(1, 0x6ee7b7)
      .setInteractive({ useHandCursor: true });
    const csvTxt = this.add.text(x + w - 36 - csvW - 6 + csvW / 2, y + 14 + 12,
      '⬇ Market CSV', {
        fontFamily: 'monospace', fontSize: '11px', color: '#6ee7b7', fontStyle: 'bold',
      }).setOrigin(0.5);
    csvBg.on('pointerover', () => csvBg.setFillStyle(0x3a6a40));
    csvBg.on('pointerout', () => csvBg.setFillStyle(0x2a4a30));
    csvBg.on('pointerdown', () => this.exportMarketHistoryCSV());
    this.marketGroup.add(csvBg);
    this.marketGroup.add(csvTxt);

    // Vertical layout anchors:
    //   y+44   country tabs row (28h)
    //   y+78   header columns (16h)
    //   y+96   scrollable body
    //   y+h-8  bottom padding
    const tabsY = y + 44;
    const headerY = y + 78;
    const rowsTop = y + 96;
    const rowsBottom = y + h - 8;

    this.marketSparkGfx = this.add.graphics().setDepth(57);
    this.marketGroup.add(this.marketSparkGfx);
    this.marketCard = { x, y, w, h, tabsY, headerY, rowsTop, rowsBottom };
    this.marketDynamicNodes = [];
    if (!this.state.ui.marketQty) this.state.ui.marketQty = {};

    // Wheel scroll on the card
    this.bindWheelScroll(card, 'market',
      () => this.computeMarketMaxScroll(),
      () => this.refreshMarketModal());
  }

  computeMarketMaxScroll() {
    const rowH = 44;
    const visibleH = this.marketCard.rowsBottom - this.marketCard.rowsTop;
    return Math.max(0, PRODUCIBLE_LIST.length * rowH - visibleH);
  }

  toggleMarket(open) {
    const s = this.state;
    if (open && !s.ui.marketOpen) {
      this.enterModal();
    } else if (!open && s.ui.marketOpen) {
      this.exitModal();
    }
    s.ui.marketOpen = open;
    this.marketGroup.setVisible(open);
    if (open) this.refreshMarketModal();
    this.refreshTopBar();
  }

  // Off-market stock held in `cid` by AI farmers (everyone except the player —
  // that column is rendered separately as "You"). Built on top of the shared
  // `offMarketInventoryFor` in Market.js to keep one source of truth: market
  // snapshot CSV and UI count the same wallets.
  offMarketInventoryFor(state, cid, pid) {
    const total = offMarketInventoryFor(state, cid, pid);
    const player = state.player?.inventoryByCountry?.[cid]?.[pid] ?? 0;
    return Math.round(total - player);
  }

  refreshMarketModal() {
    const s = this.state;
    if (!s.ui.marketQty) s.ui.marketQty = {};
    const cid = PLAYER_COUNTRY_ID;

    for (const node of this.marketDynamicNodes) node.destroy();
    this.marketDynamicNodes = [];
    this.marketSparkGfx.clear();

    const { x, w, tabsY, headerY, rowsTop, rowsBottom } = this.marketCard;
    const rowH = 44;

    // ---- Header columns ----
    const colHeaders = [
      { x: x + 18,  text: 'Commodity' },
      { x: x + 110, text: 'Price' },
      { x: x + 175, text: 'Trend (90d)' },
      { x: x + 295, text: 'Mkt' },        // tradeable stock in market
      { x: x + 340, text: 'Off' },        // hoarded by AIs (off-market)
      { x: x + 385, text: 'You' },        // player inventory
      { x: x + 420, text: 'Qty' },
      { x: x + 540, text: 'Sell' },
      { x: x + 620, text: 'Buy' },
    ];
    for (const c of colHeaders) {
      const t = this.add.text(c.x, headerY, c.text, {
        fontFamily: 'monospace', fontSize: '10px', color: '#7a8694', fontStyle: 'bold',
      }).setDepth(57);
      this.marketGroup.add(t); this.marketDynamicNodes.push(t);
    }

    // ---- Scrollable rows ----
    const scrollY = (this.scrollState?.market) || 0;

    PRODUCIBLE_LIST.forEach((def, i) => {
      const ry = rowsTop + i * rowH - scrollY;
      const midY = ry + rowH / 2;
      // Clip rows outside the visible body.
      if (ry + rowH < rowsTop || ry > rowsBottom) return;

      const swatch = this.add.rectangle(x + 18, midY, 10, 10, def.color).setOrigin(0, 0.5).setDepth(57);
      const nameTxt = this.add.text(x + 34, midY, def.name, {
        fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3', fontStyle: 'bold',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(swatch); this.marketGroup.add(nameTxt);
      this.marketDynamicNodes.push(swatch, nameTxt);

      // Price + trend (in selected country)
      const price = Math.round(s.market.prices?.[cid]?.[def.id] || 0);
      const trend = priceTrend(s, def.id, cid, 7);
      const priceTxt = this.add.text(x + 110, midY, `$${price}`, {
        fontFamily: 'monospace', fontSize: '13px',
        color: trend > 0.02 ? '#6ee79a' : trend < -0.02 ? '#ff7a7a' : '#e8edf3',
        fontStyle: 'bold',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(priceTxt);
      this.marketDynamicNodes.push(priceTxt);

      // Sparkline — only draw when row is visible. Clickable hot-zone opens
      // the big price chart modal for this producible × country.
      const sparkX = x + 175, sparkY = ry + 8, sparkW = 120, sparkH = rowH - 16;
      this.drawSparkline(this.marketSparkGfx, sparkX, sparkY, sparkW, sparkH,
        s.market.history?.[cid]?.[def.id], trend, def);
      const sparkHit = this.add.rectangle(sparkX, sparkY, sparkW, sparkH, 0x000000, 0.01)
        .setOrigin(0, 0).setDepth(58).setInteractive({ useHandCursor: true });
      sparkHit.on('pointerover', () => sparkHit.setFillStyle(0xffffff, 0.08));
      sparkHit.on('pointerout', () => sparkHit.setFillStyle(0x000000, 0.01));
      sparkHit.on('pointerdown', () => this.openPriceChartFor(def.id, cid));
      this.marketGroup.add(sparkHit);
      this.marketDynamicNodes.push(sparkHit);

      // 📦 stock chart icon — small overlay at the top-right corner of the
      // sparkline. Sits above sparkHit so its click opens the stock view
      // without triggering the price chart.
      const stockIconW = 20, stockIconH = 16;
      const stockIconX = sparkX + sparkW - stockIconW - 2;
      const stockIconY = sparkY + 2;
      const stockIconBg = this.add.rectangle(stockIconX, stockIconY, stockIconW, stockIconH, 0x1a2530, 0.85)
        .setOrigin(0, 0).setDepth(59).setInteractive({ useHandCursor: true });
      const stockIconTxt = this.add.text(stockIconX + stockIconW / 2, stockIconY + stockIconH / 2, '📦', {
        fontFamily: 'monospace', fontSize: '11px',
      }).setOrigin(0.5).setDepth(60);
      stockIconBg.on('pointerover', () => stockIconBg.setFillStyle(0x6ee7b7, 0.4));
      stockIconBg.on('pointerout', () => stockIconBg.setFillStyle(0x1a2530, 0.85));
      stockIconBg.on('pointerdown', (pointer, lx, ly, evt) => {
        if (evt) evt.stopPropagation();
        this.openStockChartFor(def.id, cid);
      });
      this.marketGroup.add(stockIconBg); this.marketGroup.add(stockIconTxt);
      this.marketDynamicNodes.push(stockIconBg, stockIconTxt);

      const stock = Math.round(s.market.inventory?.[cid]?.[def.id] || 0);
      const offMkt = this.offMarketInventoryFor(s, cid, def.id);
      // Per-country inventory: player only sees what they hold IN THIS town.
      // Per-country inventory: player only sees what they hold IN THIS town.
      const yours = Math.round(inventoryOf(s, 'player', def.id, cid));
      const stockTxt = this.add.text(x + 295, midY, `${stock}u`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#9aa4ad',
      }).setOrigin(0, 0.5).setDepth(57);
      const offTxt = this.add.text(x + 340, midY, `${offMkt}u`, {
        fontFamily: 'monospace', fontSize: '11px',
        color: offMkt > 0 ? '#e8a060' : '#566370',
      }).setOrigin(0, 0.5).setDepth(57);
      const yoursTxt = this.add.text(x + 385, midY, `${yours}u`, {
        fontFamily: 'monospace', fontSize: '11px',
        color: yours > 0 ? '#ffd166' : '#9aa4ad', fontStyle: yours > 0 ? 'bold' : 'normal',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(stockTxt); this.marketGroup.add(offTxt); this.marketGroup.add(yoursTxt);
      this.marketDynamicNodes.push(stockTxt, offTxt, yoursTxt);

      // Qty stepper
      if (s.ui.marketQty[def.id] == null) s.ui.marketQty[def.id] = 1;
      const qty = Math.max(1, s.ui.marketQty[def.id]);
      s.ui.marketQty[def.id] = qty;

      const stepW = 18, qx = x + 420;
      const qMinus = this.add.rectangle(qx, midY - 10, stepW, 20, 0x2a4a6a)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(57);
      const qMinusTxt = this.add.text(qx + stepW / 2, midY, '−', {
        fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
      }).setOrigin(0.5).setDepth(58);
      const qTxt = this.add.text(qx + stepW + 30, midY, `${qty}`, {
        fontFamily: 'monospace', fontSize: '12px', color: '#ffd166', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(58);
      const qPlus = this.add.rectangle(qx + stepW + 60 - stepW, midY - 10, stepW, 20, 0x2a4a6a)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(57);
      const qPlusTxt = this.add.text(qx + stepW + 60 - stepW / 2, midY, '+', {
        fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
      }).setOrigin(0.5).setDepth(58);

      const setQty = (next) => {
        s.ui.marketQty[def.id] = Math.max(1, next);
        this.refreshMarketModal();
      };
      qMinus.on('pointerdown', () => setQty(qty - 1));
      qPlus.on('pointerdown', () => setQty(qty + 1));
      qMinus.on('pointerover', () => qMinus.setFillStyle(0x3a6090));
      qMinus.on('pointerout', () => qMinus.setFillStyle(0x2a4a6a));
      qPlus.on('pointerover', () => qPlus.setFillStyle(0x3a6090));
      qPlus.on('pointerout', () => qPlus.setFillStyle(0x2a4a6a));
      this.marketGroup.add(qMinus); this.marketGroup.add(qMinusTxt);
      this.marketGroup.add(qTxt);
      this.marketGroup.add(qPlus); this.marketGroup.add(qPlusTxt);
      this.marketDynamicNodes.push(qMinus, qMinusTxt, qTxt, qPlus, qPlusTxt);

      // Sell — sells into the selected country's market.
      const sellEnabled = yours >= qty && price > 0;
      const sellBg = this.add.rectangle(x + 540, midY - 13, 70, 26,
        sellEnabled ? 0x2a8a5a : 0x1d2a3a).setOrigin(0, 0).setDepth(57);
      if (sellEnabled) sellBg.setInteractive({ useHandCursor: true });
      const sellTxt = this.add.text(x + 575, midY, `Sell\n+$${price * qty}`, {
        fontFamily: 'monospace', fontSize: '10px',
        color: sellEnabled ? '#e8edf3' : '#566370', align: 'center',
      }).setOrigin(0.5).setDepth(58);
      if (sellEnabled) {
        sellBg.on('pointerover', () => sellBg.setFillStyle(0x3aaa6a));
        sellBg.on('pointerout', () => sellBg.setFillStyle(0x2a8a5a));
        sellBg.on('pointerdown', () => {
          const r = sellFromInventory(s, 'player', def.id, qty, cid);
          if (r.ok) {
            pushLog(s, `Sold ${r.units}u ${def.name} → $${r.revenue} (${cid})`);
            pushFx(s, { type: 'sfx', kind: 'coin' });
          } else if (r.reason) pushLog(s, r.reason);
          this.refreshMarketModal();
          this.refreshTopBar();
        });
      }
      this.marketGroup.add(sellBg); this.marketGroup.add(sellTxt);
      this.marketDynamicNodes.push(sellBg, sellTxt);

      // Buy
      const buyCost = price * qty;
      const buyEnabled = stock >= qty && s.player.cash >= buyCost && price > 0;
      const buyBg = this.add.rectangle(x + 620, midY - 13, 70, 26,
        buyEnabled ? 0x6a4cb2 : 0x1d2a3a).setOrigin(0, 0).setDepth(57);
      if (buyEnabled) buyBg.setInteractive({ useHandCursor: true });
      const buyTxt = this.add.text(x + 655, midY, `Buy\n−$${buyCost}`, {
        fontFamily: 'monospace', fontSize: '10px',
        color: buyEnabled ? '#e8edf3' : '#566370', align: 'center',
      }).setOrigin(0.5).setDepth(58);
      if (buyEnabled) {
        buyBg.on('pointerover', () => buyBg.setFillStyle(0x8a6cd2));
        buyBg.on('pointerout', () => buyBg.setFillStyle(0x6a4cb2));
        buyBg.on('pointerdown', () => {
          const r = buyFromGlobal(s, 'player', def.id, qty, cid);
          if (r.ok) {
            pushLog(s, `Bought ${r.units}u ${def.name} → -$${r.cost} (${cid})`);
            pushFx(s, { type: 'sfx', kind: 'coinNeg' });
          } else if (r.reason) pushLog(s, r.reason);
          this.refreshMarketModal();
          this.refreshTopBar();
        });
      }
      this.marketGroup.add(buyBg); this.marketGroup.add(buyTxt);
      this.marketDynamicNodes.push(buyBg, buyTxt);
    });

    // Scroll indicator (right edge)
    const maxScroll = this.computeMarketMaxScroll();
    if (maxScroll > 0) {
      const trackH = rowsBottom - rowsTop;
      const thumbH = Math.max(20, trackH * (trackH / (trackH + maxScroll)));
      const thumbY = rowsTop + (scrollY / maxScroll) * (trackH - thumbH);
      const thumb = this.add.rectangle(x + w - 10, thumbY, 4, thumbH, 0xffb347, 0.6)
        .setOrigin(0, 0).setDepth(58);
      this.marketGroup.add(thumb); this.marketDynamicNodes.push(thumb);
    }
  }

  drawSparkline(gfx, x, y, w, h, history, trend, def = null) {
    if (!history || history.length < 2) return;
    const samples = history.slice(-90);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const range = (max - min) || 1;
    const color = trend > 0.02 ? 0x6ee79a : trend < -0.02 ? 0xff7a7a : 0xcdd6df;
    gfx.lineStyle(1.5, color, 1);
    gfx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const px = x + (i / (samples.length - 1)) * w;
      const py = y + h - ((samples[i] - min) / range) * h;
      if (i === 0) gfx.moveTo(px, py);
      else gfx.lineTo(px, py);
    }
    gfx.strokePath();
    // Dotted baseline at basePrice when caller provided the def.
    if (def) {
      const base = def.market?.basePrice ?? min;
      if (base >= min && base <= max) {
        const by = y + h - ((base - min) / range) * h;
        gfx.lineStyle(1, 0x566370, 0.5);
        for (let dx = 0; dx < w; dx += 4) gfx.lineBetween(x + dx, by, x + dx + 2, by);
      }
    }
  }

  // -----------------------------------------------------------------------
  // MODAL FRAME HELPER + GENERIC SCROLL LIST
  // -----------------------------------------------------------------------
  // Creates a centered modal card with a title bar and an [X] close button.
  // Backdrop click + the close button both call `onClose`. Returns the frame
  // metadata for the caller to populate the body region.
  makeModalFrame({ w, h, title, color, onClose, depth = 56 }) {
    const group = this.add.container(0, 0).setVisible(false).setDepth(depth);
    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.7)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', onClose);
    group.add(backdrop);

    const x = (GAME_WIDTH - w) / 2;
    const y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, color).setInteractive();
    group.add(card);

    const titleTxt = this.add.text(x + 18, y + 14, title, {
      fontFamily: 'monospace', fontSize: '16px', color: '#e8edf3', fontStyle: 'bold',
    });
    titleTxt.setColor('#' + color.toString(16).padStart(6, '0'));
    group.add(titleTxt);

    const closeBg = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBg.on('pointerover', () => closeBg.setFillStyle(0x3a6090));
    closeBg.on('pointerout', () => closeBg.setFillStyle(0x2a4a6a));
    closeBg.on('pointerdown', onClose);
    group.add(closeBg); group.add(closeTxt);

    return { group, x, y, w, h, contentTop: y + 50, contentBottom: y + h - 12 };
  }

  // Manage scroll state for a modal. Wheel events on the card area scroll the
  // body. State is stored on `this.scrollState[key]`.
  bindWheelScroll(card, key, getMaxScroll, onScroll) {
    if (!this.scrollState) this.scrollState = {};
    if (this.scrollState[key] == null) this.scrollState[key] = 0;
    card.on('wheel', (_pointer, _dx, dy) => {
      const max = getMaxScroll();
      this.scrollState[key] = Math.max(0, Math.min(max, this.scrollState[key] + dy));
      onScroll();
    });
  }

  // -----------------------------------------------------------------------
  // PRICE CHART MODAL — full-size historical price chart with date filter
  // -----------------------------------------------------------------------
  buildPriceChartModal() {
    const frame = this.makeModalFrame({
      w: 720, h: 500, title: '📊  PRICE CHART', color: 0xffb347,
      onClose: () => this.togglePriceChart(false),
      depth: 62,                                  // above Market modal
    });
    this.priceChartFrame = frame;
    this.priceChartGfx = this.add.graphics().setDepth(63);
    frame.group.add(this.priceChartGfx);
    this.priceChartDynamic = [];
  }

  // Called from the Market modal sparkline. Locks producible+country and opens
  // the chart. Doesn't close the Market modal — uses higher depth so it overlays.
  openPriceChartFor(pid, cid) {
    const s = this.state;
    s.ui.priceChartPid = pid;
    s.ui.priceChartCid = cid;
    if (!s.ui.priceChartDays) s.ui.priceChartDays = 90;     // default: 3 months
    this.togglePriceChart(true);
  }

  togglePriceChart(open) {
    const s = this.state;
    if (open && !s.ui.priceChartOpen) this.enterModal();
    else if (!open && s.ui.priceChartOpen) this.exitModal();
    s.ui.priceChartOpen = open;
    this.priceChartFrame.group.setVisible(open);
    if (open) this.refreshPriceChartModal();
    this.refreshTopBar();
  }

  refreshPriceChartModal() {
    const s = this.state;
    const pid = s.ui.priceChartPid;
    const cid = s.ui.priceChartCid;
    if (!pid || !cid) return;
    const def = PRODUCIBLES[pid];
    if (!def) return;
    const history = s.market.history?.[cid]?.[pid] || [];

    for (const n of this.priceChartDynamic) n.destroy();
    this.priceChartDynamic = [];
    this.priceChartGfx.clear();

    const { x, y, w, h, contentTop, contentBottom } = this.priceChartFrame;

    // Update title text to include producible + country.
    this.priceChartFrame.group.list[2].setText(
      `📊  ${def.name} — ${COUNTRIES[cid]?.name ?? cid}`,
    );

    // ---- Date filter pills ----
    const days = s.ui.priceChartDays || 90;
    const ranges = [
      { label: '1M',  days: 30 },
      { label: '3M',  days: 90 },
      { label: '6M',  days: 180 },
      { label: '1Y',  days: 365 },
      { label: '3Y',  days: 365 * 3 },
      { label: '5Y',  days: 365 * 5 },
      { label: 'All', days: Infinity },
    ];
    const pillsY = contentTop;
    let pillX = x + 18;
    for (const r of ranges) {
      const active = days === r.days;
      const bg = this.add.rectangle(pillX, pillsY, 50, 22,
        active ? 0xffb347 : 0x243345).setOrigin(0, 0).setDepth(63)
        .setInteractive({ useHandCursor: true });
      const txt = this.add.text(pillX + 25, pillsY + 11, r.label, {
        fontFamily: 'monospace', fontSize: '11px',
        color: active ? '#0f1923' : '#cdd6df',
        fontStyle: active ? 'bold' : 'normal',
      }).setOrigin(0.5).setDepth(64);
      bg.on('pointerover', () => { if (!active) bg.setFillStyle(0x3a4d63); });
      bg.on('pointerout', () => { if (!active) bg.setFillStyle(0x243345); });
      bg.on('pointerdown', () => {
        s.ui.priceChartDays = r.days;
        this.refreshPriceChartModal();
      });
      this.priceChartFrame.group.add(bg); this.priceChartFrame.group.add(txt);
      this.priceChartDynamic.push(bg, txt);
      pillX += 56;
    }

    // ---- Window of samples ----
    const samples = days === Infinity ? history.slice() : history.slice(-days);
    if (samples.length < 2) {
      const empty = this.add.text(x + w / 2, (contentTop + contentBottom) / 2,
        'Not enough history yet — let some days pass.', {
        fontFamily: 'monospace', fontSize: '12px', color: '#7a8694',
      }).setOrigin(0.5).setDepth(63);
      this.priceChartFrame.group.add(empty); this.priceChartDynamic.push(empty);
      return;
    }

    // Stats
    const minV = Math.min(...samples);
    const maxV = Math.max(...samples);
    const first = samples[0];
    const last = samples[samples.length - 1];
    const pct = first > 0 ? ((last - first) / first) * 100 : 0;
    const pctStr = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    const pctColor = pct > 1 ? '#6ee79a' : pct < -1 ? '#ff7a7a' : '#cdd6df';

    const statsY = pillsY + 30;
    const statsTxt = this.add.text(x + 18, statsY,
      `Current $${last.toFixed(2)}   ·   Window min $${minV.toFixed(2)}   ·   max $${maxV.toFixed(2)}   ·   ${samples.length}d`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df',
      }).setDepth(63);
    this.priceChartFrame.group.add(statsTxt); this.priceChartDynamic.push(statsTxt);

    const pctTxt = this.add.text(x + w - 18, statsY, `Δ ${pctStr}`, {
      fontFamily: 'monospace', fontSize: '13px', color: pctColor, fontStyle: 'bold',
    }).setOrigin(1, 0).setDepth(63);
    this.priceChartFrame.group.add(pctTxt); this.priceChartDynamic.push(pctTxt);

    // ---- Plot area ----
    const plotLeft = x + 60;
    const plotRight = x + w - 24;
    const plotTop = statsY + 28;
    const plotBottom = contentBottom - 24;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    // Y axis grid: 4 horizontal lines
    const range = (maxV - minV) || 1;
    const yPad = range * 0.08;
    const yMin = Math.max(0, minV - yPad);
    const yMax = maxV + yPad;
    const yRange = (yMax - yMin) || 1;
    for (let g = 0; g <= 4; g++) {
      const yVal = yMin + (yRange * g) / 4;
      const py = plotBottom - ((yVal - yMin) / yRange) * plotH;
      this.priceChartGfx.lineStyle(1, 0x3a4d63, 0.5);
      this.priceChartGfx.lineBetween(plotLeft, py, plotRight, py);
      const lab = this.add.text(plotLeft - 6, py, `$${yVal.toFixed(0)}`, {
        fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
      }).setOrigin(1, 0.5).setDepth(63);
      this.priceChartFrame.group.add(lab); this.priceChartDynamic.push(lab);
    }

    // X axis: start / end day labels
    const daysSpan = samples.length - 1;
    const totalDays = s.time.totalDays;
    const startDay = totalDays - daysSpan;
    const xStartLab = this.add.text(plotLeft, plotBottom + 6,
      `day ${startDay}`, {
        fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
      }).setDepth(63);
    const xEndLab = this.add.text(plotRight, plotBottom + 6,
      `day ${totalDays}`, {
        fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
      }).setOrigin(1, 0).setDepth(63);
    this.priceChartFrame.group.add(xStartLab); this.priceChartFrame.group.add(xEndLab);
    this.priceChartDynamic.push(xStartLab, xEndLab);

    // basePrice dashed reference line
    const base = def.market?.basePrice ?? 0;
    if (base >= yMin && base <= yMax) {
      const by = plotBottom - ((base - yMin) / yRange) * plotH;
      this.priceChartGfx.lineStyle(1, 0x566370, 0.7);
      for (let dx = 0; dx < plotW; dx += 6) {
        this.priceChartGfx.lineBetween(plotLeft + dx, by, plotLeft + dx + 3, by);
      }
      const baseLab = this.add.text(plotRight + 2, by, `base $${base}`, {
        fontFamily: 'monospace', fontSize: '8px', color: '#566370',
      }).setOrigin(0, 0.5).setDepth(63);
      this.priceChartFrame.group.add(baseLab); this.priceChartDynamic.push(baseLab);
    }

    // Main line — use producible color
    this.priceChartGfx.lineStyle(2, def.color, 1);
    this.priceChartGfx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const px = plotLeft + (i / (samples.length - 1)) * plotW;
      const py = plotBottom - ((samples[i] - yMin) / yRange) * plotH;
      if (i === 0) this.priceChartGfx.moveTo(px, py);
      else this.priceChartGfx.lineTo(px, py);
    }
    this.priceChartGfx.strokePath();

    // Min / max markers (small dots)
    const markIdx = (target) => {
      let bestI = 0;
      for (let i = 1; i < samples.length; i++) {
        if ((target === 'min' && samples[i] < samples[bestI])
            || (target === 'max' && samples[i] > samples[bestI])) bestI = i;
      }
      return bestI;
    };
    for (const which of ['min', 'max']) {
      const i = markIdx(which);
      const px = plotLeft + (i / (samples.length - 1)) * plotW;
      const py = plotBottom - ((samples[i] - yMin) / yRange) * plotH;
      const color = which === 'min' ? 0xff7a7a : 0x6ee79a;
      this.priceChartGfx.fillStyle(color, 1);
      this.priceChartGfx.fillCircle(px, py, 3);
    }
  }

  // -----------------------------------------------------------------------
  // STOCK CHART MODAL — clon estructural del PRICE CHART pero leyendo
  // state.market.snapshot. Dos modos vía toggle: "Stocks" (marketStock vs
  // offMarketStock) y "Flows" (supplyDay vs consumptionDay). Cada par tiene
  // escalas naturalmente compatibles entre sí.
  // -----------------------------------------------------------------------
  buildStockChartModal() {
    const frame = this.makeModalFrame({
      w: 720, h: 500, title: '📦  STOCK CHART', color: 0x6ee7b7,
      onClose: () => this.toggleStockChart(false),
      depth: 62,                                  // above Market modal
    });
    this.stockChartFrame = frame;
    this.stockChartGfx = this.add.graphics().setDepth(63);
    frame.group.add(this.stockChartGfx);
    this.stockChartDynamic = [];
  }

  openStockChartFor(pid, cid) {
    const s = this.state;
    s.ui.stockChartPid = pid;
    s.ui.stockChartCid = cid;
    if (!s.ui.stockChartDays) s.ui.stockChartDays = 90;
    if (!s.ui.stockChartMode) s.ui.stockChartMode = 'stocks';
    this.toggleStockChart(true);
  }

  toggleStockChart(open) {
    const s = this.state;
    if (open && !s.ui.stockChartOpen) this.enterModal();
    else if (!open && s.ui.stockChartOpen) this.exitModal();
    s.ui.stockChartOpen = open;
    this.stockChartFrame.group.setVisible(open);
    if (open) this.refreshStockChartModal();
    this.refreshTopBar();
  }

  refreshStockChartModal() {
    const s = this.state;
    const pid = s.ui.stockChartPid;
    const cid = s.ui.stockChartCid;
    if (!pid || !cid) return;
    const def = PRODUCIBLES[pid];
    if (!def) return;
    const snapshot = s.market.snapshot?.[cid]?.[pid] || [];

    for (const n of this.stockChartDynamic) n.destroy();
    this.stockChartDynamic = [];
    this.stockChartGfx.clear();

    const { x, y, w, h, contentTop, contentBottom } = this.stockChartFrame;

    this.stockChartFrame.group.list[2].setText(
      `📦  ${def.name} — ${COUNTRIES[cid]?.name ?? cid}`,
    );

    const mode = s.ui.stockChartMode || 'stocks';
    const seriesByMode = {
      stocks: [
        { key: 'marketStock',    label: 'Market',     color: 0x6ee7b7 },
        { key: 'offMarketStock', label: 'Off-market', color: 0x7a8694 },
      ],
      flows: [
        { key: 'supplyDay',      label: 'Supply',      color: 0x60b3ff },
        { key: 'consumptionDay', label: 'Consumption', color: 0xff6b6b },
      ],
    };
    const series = seriesByMode[mode];

    // ---- Toggle Stocks / Flows ----
    const toggleY = contentTop;
    const toggleOpts = [
      { id: 'stocks', label: 'Stocks' },
      { id: 'flows',  label: 'Flows' },
    ];
    let tgX = x + 18;
    for (const opt of toggleOpts) {
      const active = mode === opt.id;
      const bg = this.add.rectangle(tgX, toggleY, 70, 22,
        active ? 0x6ee7b7 : 0x243345).setOrigin(0, 0).setDepth(63)
        .setInteractive({ useHandCursor: true });
      const txt = this.add.text(tgX + 35, toggleY + 11, opt.label, {
        fontFamily: 'monospace', fontSize: '11px',
        color: active ? '#0f1923' : '#cdd6df',
        fontStyle: active ? 'bold' : 'normal',
      }).setOrigin(0.5).setDepth(64);
      bg.on('pointerover', () => { if (!active) bg.setFillStyle(0x3a4d63); });
      bg.on('pointerout', () => { if (!active) bg.setFillStyle(0x243345); });
      bg.on('pointerdown', () => {
        s.ui.stockChartMode = opt.id;
        this.refreshStockChartModal();
      });
      this.stockChartFrame.group.add(bg); this.stockChartFrame.group.add(txt);
      this.stockChartDynamic.push(bg, txt);
      tgX += 76;
    }

    // ---- Date filter pills (right side of toggle row) ----
    const days = s.ui.stockChartDays || 90;
    const ranges = [
      { label: '1M',  days: 30 },
      { label: '3M',  days: 90 },
      { label: '6M',  days: 180 },
      { label: '1Y',  days: 365 },
      { label: '3Y',  days: 365 * 3 },
      { label: '5Y',  days: 365 * 5 },
      { label: 'All', days: Infinity },
    ];
    let pillX = tgX + 16;
    for (const r of ranges) {
      const active = days === r.days;
      const bg = this.add.rectangle(pillX, toggleY, 48, 22,
        active ? 0xffb347 : 0x243345).setOrigin(0, 0).setDepth(63)
        .setInteractive({ useHandCursor: true });
      const txt = this.add.text(pillX + 24, toggleY + 11, r.label, {
        fontFamily: 'monospace', fontSize: '10px',
        color: active ? '#0f1923' : '#cdd6df',
        fontStyle: active ? 'bold' : 'normal',
      }).setOrigin(0.5).setDepth(64);
      bg.on('pointerover', () => { if (!active) bg.setFillStyle(0x3a4d63); });
      bg.on('pointerout', () => { if (!active) bg.setFillStyle(0x243345); });
      bg.on('pointerdown', () => {
        s.ui.stockChartDays = r.days;
        this.refreshStockChartModal();
      });
      this.stockChartFrame.group.add(bg); this.stockChartFrame.group.add(txt);
      this.stockChartDynamic.push(bg, txt);
      pillX += 52;
    }

    // ---- Window of samples ----
    const samples = days === Infinity ? snapshot.slice() : snapshot.slice(-days);
    if (samples.length < 2) {
      const empty = this.add.text(x + w / 2, (contentTop + contentBottom) / 2,
        'Not enough history yet — let some days pass.', {
        fontFamily: 'monospace', fontSize: '12px', color: '#7a8694',
      }).setOrigin(0.5).setDepth(63);
      this.stockChartFrame.group.add(empty); this.stockChartDynamic.push(empty);
      return;
    }

    // ---- Stats row (depende del mode) ----
    const lastRec = samples[samples.length - 1];
    const statsY = toggleY + 30;
    let statsLine;
    if (mode === 'stocks') {
      const mk = lastRec.marketStock || 0;
      const off = lastRec.offMarketStock || 0;
      const tot = mk + off;
      const pct = tot > 0 ? Math.round((mk / tot) * 100) : 0;
      statsLine = `Market ${mk}u   ·   Off-market ${off}u   ·   In-góndola ratio ${pct}%   ·   ${samples.length}d`;
    } else {
      const last30 = samples.slice(-30);
      const sumSup = last30.reduce((s, r) => s + (r.supplyDay || 0), 0);
      const sumCons = last30.reduce((s, r) => s + (r.consumptionDay || 0), 0);
      const net = sumSup - sumCons;
      const netStr = `${net >= 0 ? '+' : ''}${net}u`;
      statsLine = `30d supply ${sumSup}u   ·   30d consumption ${sumCons}u   ·   Net ${netStr}   ·   ${samples.length}d`;
    }
    const statsTxt = this.add.text(x + 18, statsY, statsLine, {
      fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df',
    }).setDepth(63);
    this.stockChartFrame.group.add(statsTxt); this.stockChartDynamic.push(statsTxt);

    // ---- Plot area ----
    const plotLeft = x + 60;
    const plotRight = x + w - 24;
    const plotTop = statsY + 28;
    const plotBottom = contentBottom - 24;
    const plotW = plotRight - plotLeft;
    const plotH = plotBottom - plotTop;

    // Calcular min/max sobre AMBAS series del modo activo (escala compartida)
    let minV = Infinity, maxV = -Infinity;
    for (const rec of samples) {
      for (const ser of series) {
        const v = rec[ser.key] || 0;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    if (!isFinite(minV)) { minV = 0; maxV = 1; }
    if (maxV === minV) maxV = minV + 1;

    // Y axis grid + labels
    const range = (maxV - minV) || 1;
    const yPad = range * 0.08;
    const yMin = Math.max(0, minV - yPad);
    const yMax = maxV + yPad;
    const yRange = (yMax - yMin) || 1;
    for (let g = 0; g <= 4; g++) {
      const yVal = yMin + (yRange * g) / 4;
      const py = plotBottom - ((yVal - yMin) / yRange) * plotH;
      this.stockChartGfx.lineStyle(1, 0x3a4d63, 0.5);
      this.stockChartGfx.lineBetween(plotLeft, py, plotRight, py);
      const lab = this.add.text(plotLeft - 6, py, `${Math.round(yVal)}u`, {
        fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
      }).setOrigin(1, 0.5).setDepth(63);
      this.stockChartFrame.group.add(lab); this.stockChartDynamic.push(lab);
    }

    // X axis labels
    const startDay = samples[0].day;
    const endDay = samples[samples.length - 1].day;
    const xStartLab = this.add.text(plotLeft, plotBottom + 6, `day ${startDay}`, {
      fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
    }).setDepth(63);
    const xEndLab = this.add.text(plotRight, plotBottom + 6, `day ${endDay}`, {
      fontFamily: 'monospace', fontSize: '9px', color: '#7a8694',
    }).setOrigin(1, 0).setDepth(63);
    this.stockChartFrame.group.add(xStartLab); this.stockChartFrame.group.add(xEndLab);
    this.stockChartDynamic.push(xStartLab, xEndLab);

    // Líneas de las 2 series + legend
    let legendX = plotRight - 10;
    for (let sIdx = series.length - 1; sIdx >= 0; sIdx--) {
      const ser = series[sIdx];
      this.stockChartGfx.lineStyle(2, ser.color, 1);
      this.stockChartGfx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const px = plotLeft + (i / (samples.length - 1)) * plotW;
        const py = plotBottom - (((samples[i][ser.key] || 0) - yMin) / yRange) * plotH;
        if (i === 0) this.stockChartGfx.moveTo(px, py);
        else this.stockChartGfx.lineTo(px, py);
      }
      this.stockChartGfx.strokePath();
      // Legend entry (right-aligned, top)
      const labW = ser.label.length * 7 + 16;
      const sq = this.add.rectangle(legendX - labW, plotTop + 4, 8, 8, ser.color)
        .setOrigin(1, 0).setDepth(63);
      const lab = this.add.text(legendX - labW + 4, plotTop + 4, ser.label, {
        fontFamily: 'monospace', fontSize: '10px',
        color: '#' + ser.color.toString(16).padStart(6, '0'),
      }).setOrigin(0, 0).setDepth(63);
      this.stockChartFrame.group.add(sq); this.stockChartFrame.group.add(lab);
      this.stockChartDynamic.push(sq, lab);
      legendX -= (labW + 14);
    }

    // Min/max markers — solo en mode 'stocks' (flows son ruidosos)
    if (mode === 'stocks') {
      for (const ser of series) {
        let minI = 0, maxI = 0;
        for (let i = 1; i < samples.length; i++) {
          if ((samples[i][ser.key] || 0) < (samples[minI][ser.key] || 0)) minI = i;
          if ((samples[i][ser.key] || 0) > (samples[maxI][ser.key] || 0)) maxI = i;
        }
        for (const [idx, color] of [[minI, 0xff7a7a], [maxI, 0x6ee79a]]) {
          const px = plotLeft + (idx / (samples.length - 1)) * plotW;
          const py = plotBottom - (((samples[idx][ser.key] || 0) - yMin) / yRange) * plotH;
          this.stockChartGfx.fillStyle(color, 1);
          this.stockChartGfx.fillCircle(px, py, 3);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // EVENTS MODAL — tiered history with filters and CSV export (Sprint D)
  // -----------------------------------------------------------------------
  buildEventsModal() {
    const frame = this.makeModalFrame({
      w: 760, h: 540, title: '⚡  EVENTS HISTORY', color: 0xf7c948,
      onClose: () => this.toggleEvents(false),
    });
    this.eventsFrame = frame;
    this.eventsDynamicNodes = [];

    const card = frame.group.list[1];
    this.bindWheelScroll(card, 'events',
      () => this.computeEventsMaxScroll(),
      () => this.refreshEventsModal());
  }

  // Apply current UI filters and return the filtered slice (newest first).
  filteredEvents() {
    const s = this.state;
    if (!s.ui.eventsTiers) s.ui.eventsTiers = new Set([1, 2]);
    const tiers = s.ui.eventsTiers;
    const cid = s.ui.eventsCountryFilter || null;
    const hist = s.eventHistory || [];
    const out = [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const e = hist[i];
      if (!tiers.has(e.tier)) continue;
      if (cid && e.countryId && e.countryId !== cid) continue;
      if (cid && !e.countryId) continue;
      out.push(e);
    }
    return out;
  }

  computeEventsMaxScroll() {
    const rows = this.filteredEvents().length;
    const rowH = 36;
    const visibleH = this.eventsFrame.contentBottom - this.eventsFrame.contentTop - 90;
    return Math.max(0, rows * rowH - visibleH);
  }

  toggleEvents(open) {
    const s = this.state;
    if (open && !s.ui.eventsOpen) this.enterModal();
    else if (!open && s.ui.eventsOpen) this.exitModal();
    s.ui.eventsOpen = open;
    this.eventsFrame.group.setVisible(open);
    if (open) this.refreshEventsModal();
    else {
      // Phaser 3 quirk: setVisible(false) on a container does NOT disable
      // input on its children. Tear down the dynamic interactive nodes so
      // hidden tier pills / CSV button / country cycle don't eat clicks
      // aimed at other modals (e.g. World country circles).
      for (const n of this.eventsDynamicNodes) n.destroy();
      this.eventsDynamicNodes = [];
    }
    this.refreshTopBar();
  }

  // Dump the full per-day market snapshot for every (country, product) into
  // a CSV. Designed for AI debugging: the user plays for a while, exports,
  // and hands the file off. Joins cleanly with events-day*.csv on the `day`
  // column when cross-referencing AI decisions against price/inventory state.
  exportMarketHistoryCSV() {
    const s = this.state;
    const snapshot = s.market?.snapshot;
    if (!snapshot) {
      pushLog(s, 'No market snapshots recorded yet.');
      return;
    }
    const rows = [];
    for (const cid of COUNTRY_IDS) {
      const series = snapshot[cid];
      if (!series) continue;
      const townName = COUNTRIES[cid]?.name ?? cid;
      for (const pid of Object.keys(series)) {
        const productName = PRODUCIBLES[pid]?.name ?? pid;
        for (const rec of series[pid]) {
          rows.push([
            rec.day, townName, productName,
            rec.price, rec.priceMA30,
            rec.marketStock, rec.offMarketStock,
            rec.supplyDay, rec.consumptionDay,
            rec.priceIndex, rec.wageRate,
          ]);
        }
      }
    }
    downloadCSV(
      `market-history-day${s.time.totalDays}.csv`,
      ['day', 'country', 'product',
        'price', 'priceMA30',
        'marketStock', 'offMarketStock',
        'supplyDay', 'consumptionDay',
        'priceIndex', 'wageRate'],
      rows,
    );
    pushLog(s, `Exported ${rows.length} market rows to CSV`);
  }

  // Trigger a browser download of the currently-filtered event history.
  // All CSV downloads in this scene route through the shared downloadCSV util
  // — same escape rules, same Blob/anchor lifecycle, same future bug fixes.
  exportEventsCSV() {
    const rows = this.filteredEvents().map(e => [
      e.day, e.tier, e.countryId ?? '', e.actorName ?? '',
      e.category ?? '', e.summary ?? '', e.reason ?? '', e.amount ?? '',
    ]);
    downloadCSV(
      `events-day${this.state.time.totalDays}.csv`,
      ['day', 'tier', 'country', 'actor', 'category', 'summary', 'reason', 'amount'],
      rows,
    );
    pushLog(this.state, `Exported ${rows.length} events to CSV`);
  }

  refreshEventsModal() {
    const s = this.state;
    if (!s.ui.eventsTiers) s.ui.eventsTiers = new Set([1, 2]);
    for (const n of this.eventsDynamicNodes) n.destroy();
    this.eventsDynamicNodes = [];

    const { x, w, contentTop, contentBottom } = this.eventsFrame;

    // === Row 1: tier pills ===========================================
    const pillsY = contentTop;
    const tierMeta = [
      { tier: 1, label: 'T1 World',    color: 0xf7c948 },
      { tier: 2, label: 'T2 Strategy', color: 0xc792ea },
      { tier: 3, label: 'T3 Tactical', color: 0x88c8ff },
      { tier: 4, label: 'T4 Tx',       color: 0x7a8694 },
    ];
    let pillX = x + 14;
    for (const t of tierMeta) {
      const active = s.ui.eventsTiers.has(t.tier);
      const pillW = 92;
      const bg = this.add.rectangle(pillX, pillsY, pillW, 22,
        active ? t.color : 0x243345).setOrigin(0, 0).setDepth(58)
        .setStrokeStyle(1, t.color).setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => {
        if (s.ui.eventsTiers.has(t.tier)) s.ui.eventsTiers.delete(t.tier);
        else s.ui.eventsTiers.add(t.tier);
        this.scrollState.events = 0;
        this.refreshEventsModal();
      });
      const txt = this.add.text(pillX + pillW / 2, pillsY + 11, t.label, {
        fontFamily: 'monospace', fontSize: '11px',
        color: active ? '#13181f' : '#cdd6df', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(59);
      this.eventsFrame.group.add(bg); this.eventsFrame.group.add(txt);
      this.eventsDynamicNodes.push(bg, txt);
      pillX += pillW + 4;
    }

    // === Row 1 (right): country cycle + CSV =========================
    const csvW = 70;
    const csvBg = this.add.rectangle(x + w - 14 - csvW, pillsY, csvW, 22, 0x2a4a30)
      .setOrigin(0, 0).setDepth(58).setStrokeStyle(1, 0x6ee7b7)
      .setInteractive({ useHandCursor: true });
    csvBg.on('pointerdown', () => this.exportEventsCSV());
    const csvTxt = this.add.text(x + w - 14 - csvW / 2, pillsY + 11, '⬇ CSV', {
      fontFamily: 'monospace', fontSize: '11px', color: '#6ee7b7', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(59);
    this.eventsFrame.group.add(csvBg); this.eventsFrame.group.add(csvTxt);
    this.eventsDynamicNodes.push(csvBg, csvTxt);

    const cycleW = 130;
    const cycleX = x + w - 14 - csvW - 6 - cycleW;
    const cidNow = s.ui.eventsCountryFilter || null;
    const cidLabel = cidNow ? (COUNTRIES[cidNow]?.name ?? cidNow) : 'All towns';
    const cycleBg = this.add.rectangle(cycleX, pillsY, cycleW, 22, 0x243345)
      .setOrigin(0, 0).setDepth(58).setStrokeStyle(1, 0x88c8ff)
      .setInteractive({ useHandCursor: true });
    cycleBg.on('pointerdown', () => {
      const list = [null, ...COUNTRY_IDS];
      const idx = list.indexOf(s.ui.eventsCountryFilter ?? null);
      s.ui.eventsCountryFilter = list[(idx + 1) % list.length];
      this.scrollState.events = 0;
      this.refreshEventsModal();
    });
    const cycleTxt = this.add.text(cycleX + cycleW / 2, pillsY + 11, `🌍 ${cidLabel}`, {
      fontFamily: 'monospace', fontSize: '11px', color: '#88c8ff',
    }).setOrigin(0.5).setDepth(59);
    this.eventsFrame.group.add(cycleBg); this.eventsFrame.group.add(cycleTxt);
    this.eventsDynamicNodes.push(cycleBg, cycleTxt);

    // === Row 2: summary count ========================================
    const total = (s.eventHistory?.length || 0);
    const rows = this.filteredEvents();
    const sub = this.add.text(x + 18, pillsY + 30,
      `Showing ${rows.length} / ${total} (cap ${10000}). Click pills to toggle tiers · 🌍 to filter town.`, {
        fontFamily: 'monospace', fontSize: '10px', color: '#9aa4ad',
      });
    this.eventsFrame.group.add(sub); this.eventsDynamicNodes.push(sub);

    // === Rows ========================================================
    const rowsTop = pillsY + 56;
    const rowH = 36;
    const visibleH = contentBottom - rowsTop;
    const scrollY = (this.scrollState?.events) || 0;
    const tierColor = { 1: 0xf7c948, 2: 0xc792ea, 3: 0x88c8ff, 4: 0x7a8694 };

    rows.forEach((e, i) => {
      const ry = rowsTop + i * rowH - scrollY;
      if (ry + rowH < rowsTop || ry > contentBottom) return;

      const bg = this.add.rectangle(x + 14, ry + 2, w - 28, rowH - 4, 0x1a2434)
        .setOrigin(0, 0).setDepth(57);
      this.eventsFrame.group.add(bg); this.eventsDynamicNodes.push(bg);

      const dot = this.add.rectangle(x + 22, ry + 6, 4, rowH - 12,
        tierColor[e.tier] ?? 0x566370).setOrigin(0, 0).setDepth(58);
      this.eventsFrame.group.add(dot); this.eventsDynamicNodes.push(dot);

      const headBits = [];
      if (e.countryId) headBits.push(COUNTRIES[e.countryId]?.name ?? e.countryId);
      if (e.actorName) headBits.push(e.actorName);
      const head = headBits.length ? `[${headBits.join(' · ')}] ` : '';
      const summary = this.add.text(x + 34, ry + 4, `${head}${e.summary ?? ''}`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
      }).setDepth(58);
      this.eventsFrame.group.add(summary); this.eventsDynamicNodes.push(summary);

      if (e.reason) {
        const reasonTxt = this.add.text(x + 34, ry + 19, `↳ ${e.reason}`, {
          fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
        }).setDepth(58);
        this.eventsFrame.group.add(reasonTxt); this.eventsDynamicNodes.push(reasonTxt);
      }

      const right = `day ${e.day}` + (e.amount != null ? `  ·  $${e.amount}` : '');
      const rightTxt = this.add.text(x + w - 22, ry + 4, right, {
        fontFamily: 'monospace', fontSize: '10px', color: '#566370',
      }).setOrigin(1, 0).setDepth(58);
      this.eventsFrame.group.add(rightTxt); this.eventsDynamicNodes.push(rightTxt);
    });

    if (rows.length === 0) {
      const empty = this.add.text(x + w / 2, rowsTop + visibleH / 2,
        'No events match the current filters.', {
          fontFamily: 'monospace', fontSize: '12px', color: '#566370',
        }).setOrigin(0.5);
      this.eventsFrame.group.add(empty); this.eventsDynamicNodes.push(empty);
    }
  }

  // -----------------------------------------------------------------------
  // COMPANIES MODAL — all companies (player + AI), debt, cash, industries
  // -----------------------------------------------------------------------
  buildCompaniesModal() {
    const frame = this.makeModalFrame({
      w: 720, h: 500, title: '🏭  COMPANIES', color: 0xc792ea,
      onClose: () => this.toggleCompanies(false),
    });
    this.companiesFrame = frame;
    this.companiesDynamicNodes = [];
    const card = frame.group.list[1];
    this.bindWheelScroll(card, 'companies',
      () => this.computeCompaniesMaxScroll(),
      () => this.refreshCompaniesModal());
  }

  computeCompaniesMaxScroll() {
    const n = 1 + (this.state.aiFarmers?.length || 0);
    const rowH = 58;
    const visibleH = this.companiesFrame.contentBottom - this.companiesFrame.contentTop - 30;
    return Math.max(0, n * rowH - visibleH);
  }

  toggleCompanies(open) {
    const s = this.state;
    if (open && !s.ui.companiesOpen) this.enterModal();
    else if (!open && s.ui.companiesOpen) this.exitModal();
    s.ui.companiesOpen = open;
    this.companiesFrame.group.setVisible(open);
    if (open) this.refreshCompaniesModal();
    else {
      for (const n of this.companiesDynamicNodes) n.destroy();
      this.companiesDynamicNodes = [];
    }
    this.refreshTopBar();
  }

  refreshCompaniesModal() {
    const s = this.state;
    for (const n of this.companiesDynamicNodes) n.destroy();
    this.companiesDynamicNodes = [];

    const { x, w, contentTop, contentBottom } = this.companiesFrame;
    const sub = this.add.text(x + 18, contentTop,
      `${1 + (s.aiFarmers?.length || 0)} companies · click to inspect`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#9aa4ad',
      });
    this.companiesFrame.group.add(sub); this.companiesDynamicNodes.push(sub);

    const rowsTop = contentTop + 26;
    const rowH = 78;
    const scrollY = (this.scrollState?.companies) || 0;

    // Build company list: player first, then AIs. Capture inventory reference
    // so we can render it inline (stock the company is HOLDING, not selling).
    // Flatten the wallet's per-country inventory into a single {pid: total}
    // dict for display purposes. Storage cost is still billed per-country —
    // this is just the off-market holdings line.
    const flatten = (byC) => {
      const out = {};
      if (!byC) return out;
      for (const c of Object.values(byC)) {
        for (const [pid, q] of Object.entries(c)) out[pid] = (out[pid] || 0) + q;
      }
      return out;
    };
    const all = [
      { id: 'player', name: 'YOU (Player)', cash: s.player.cash,
        countryId: PLAYER_COUNTRY_ID, isPlayer: true,
        inventory: flatten(s.player.inventoryByCountry) },
      ...(s.aiFarmers || []).map(a => ({
        id: a.id, name: a.name, cash: a.cash,
        countryId: a.countryId, isPlayer: false, color: a.color,
        inventory: flatten(a.inventoryByCountry),
      })),
    ];

    all.forEach((co, i) => {
      const ry = rowsTop + i * rowH - scrollY;
      if (ry + rowH < rowsTop || ry > contentBottom) return;

      const bg = this.add.rectangle(x + 14, ry + 2, w - 28, rowH - 4,
        co.isPlayer ? 0x2a3548 : 0x1a2434).setOrigin(0, 0)
        .setStrokeStyle(co.isPlayer ? 1 : 0, 0xc792ea).setDepth(57);
      this.companiesFrame.group.add(bg); this.companiesDynamicNodes.push(bg);

      // Color dot
      const dotColor = co.isPlayer ? 0xffd166 : (co.color ?? 0xc792ea);
      const dot = this.add.rectangle(x + 22, ry + 8, 8, 8, dotColor).setOrigin(0, 0).setDepth(58);
      this.companiesFrame.group.add(dot); this.companiesDynamicNodes.push(dot);

      // Name + country
      const head = `${co.name}  ·  ${COUNTRIES[co.countryId]?.name ?? co.countryId}`;
      const headTxt = this.add.text(x + 38, ry + 4, head, {
        fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3', fontStyle: 'bold',
      }).setDepth(58);
      this.companiesFrame.group.add(headTxt); this.companiesDynamicNodes.push(headTxt);

      // Stats line
      const debt = totalDebt(s, co.id);
      const ownedTiles = co.isPlayer
        ? Object.values(s.maps).reduce((n, m) => n + m.tiles.filter(t => t.owner === 'player').length, 0)
        : (s.aiFarmers.find(a => a.id === co.id)?.ownedTileIds?.length || 0);
      const stats = `💰 $${Math.round(co.cash)}    🏦 $${Math.round(debt)}    🌾 ${ownedTiles} tiles`;
      const statsTxt = this.add.text(x + 22, ry + 22, stats, {
        fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df',
      }).setDepth(58);
      this.companiesFrame.group.add(statsTxt); this.companiesDynamicNodes.push(statsTxt);

      // Inventory line — what this company is HOLDING (off-market). Empty
      // entries omitted; shows up to 6 of the biggest stockpiles.
      const inv = co.inventory || {};
      const entries = Object.entries(inv)
        .filter(([, qty]) => qty > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      if (entries.length > 0) {
        const invStr = '📦 ' + entries.map(([pid, qty]) => {
          const d = PRODUCIBLES[pid];
          return `${d?.name?.slice(0, 6) ?? pid} ${Math.round(qty)}u`;
        }).join(', ');
        const invTxt = this.add.text(x + 22, ry + 40, invStr, {
          fontFamily: 'monospace', fontSize: '10px', color: '#e8a060',
        }).setDepth(58);
        this.companiesFrame.group.add(invTxt); this.companiesDynamicNodes.push(invTxt);
      } else {
        const noInv = this.add.text(x + 22, ry + 40, '📦 (no inventory)', {
          fontFamily: 'monospace', fontSize: '10px', color: '#566370',
        }).setDepth(58);
        this.companiesFrame.group.add(noInv); this.companiesDynamicNodes.push(noInv);
      }
    });
  }

  // -----------------------------------------------------------------------
  // OFFER MODAL — counter an AI offer or initiate a purchase
  // -----------------------------------------------------------------------
  buildOfferModal() {
    this.offerGroup = this.add.container(0, 0).setVisible(false).setDepth(58);
    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.65)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.closeOfferModal());
    this.offerGroup.add(backdrop);

    const w = 460, h = 280;
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xffb347).setInteractive();
    this.offerGroup.add(card);

    this.offerTitle = this.add.text(x + 18, y + 14, '', {
      fontFamily: 'monospace', fontSize: '15px', color: '#ffb347', fontStyle: 'bold',
    });
    this.offerSubtitle = this.add.text(x + 18, y + 40, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#cdd6df',
      wordWrap: { width: w - 36 },
    });
    this.offerGroup.add(this.offerTitle);
    this.offerGroup.add(this.offerSubtitle);

    const closeBtn = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerdown', () => this.closeOfferModal());
    this.offerGroup.add(closeBtn);
    this.offerGroup.add(closeTxt);

    this.offerCard = { x, y, w, h };
    this.offerDynamicNodes = [];
  }

  openOfferModal({ tile, mode }) {
    const s = this.state;
    if (!s.ui.offerOpen) {
      this.enterModal();
    }
    s.ui.offerOpen = true;
    this.offerCtx = { tileId: tile.id, mode };

    if (mode === 'initiate') {
      // Player offering to buy AI tile. Start at minimum markup.
      const start = buyStartingAmount(tile, s);
      s.ui.offerAmount = start;
    } else if (mode === 'counter') {
      // Counter the AI's offer. Start equal to original (markup 0%).
      s.ui.offerAmount = tile.pendingOffer?.amount ?? 0;
    }

    this.offerGroup.setVisible(true);
    this.refreshOfferModal();
    this.refreshTopBar();
  }

  closeOfferModal() {
    if (this.state.ui.offerOpen) this.exitModal();
    this.state.ui.offerOpen = false;
    this.offerGroup.setVisible(false);
    this.refreshTopBar();
    this.refreshAll();
  }

  refreshOfferModal() {
    const s = this.state;
    const ctx = this.offerCtx;
    if (!ctx) return;
    const tile = s.map.tiles[ctx.tileId];
    if (!tile) { this.closeOfferModal(); return; }

    // Clear old dynamic widgets
    for (const n of this.offerDynamicNodes) n.destroy();
    this.offerDynamicNodes = [];

    const market = tilePrice(tile, s);
    const ai = ctx.mode === 'initiate'
      ? s.aiFarmers.find(a => a.id === tile.owner)
      : s.aiFarmers.find(a => a.id === tile.pendingOffer?.fromId);
    const aiName = ai?.name ?? '?';

    let amount = s.ui.offerAmount ?? market;
    let probability = 0;
    let helper = '';
    let title, subtitle;
    let stepDelta = 0;
    let minAmount = 0;
    let actionLabel = '';

    if (ctx.mode === 'initiate') {
      title = `Offer to buy from ${aiName}`;
      const markup = (amount - market) / market;
      probability = buyAcceptProbability(markup);
      const min = Math.round(market * (1 + OFFERS.buyMinMarkup));
      minAmount = min;
      stepDelta = Math.max(50, Math.round(market * OFFERS.buyStep));
      amount = Math.max(min, amount);
      s.ui.offerAmount = amount;
      subtitle =
        `Tile (${tile.x},${tile.y}) market value $${market}\n` +
        `Minimum offer: $${min} (+${(OFFERS.buyMinMarkup * 100).toFixed(0)}%)`;
      helper = `Your offer $${amount} = +${(markup * 100).toFixed(0)}% over market`;
      actionLabel = `Submit offer · ${(probability * 100).toFixed(0)}% accept`;
    } else {
      // counter
      const original = tile.pendingOffer?.amount ?? 0;
      title = `Counter ${aiName}'s offer`;
      const markup = original > 0 ? (amount - original) / original : 0;
      probability = counterAcceptProbability(markup);
      minAmount = original;
      stepDelta = Math.max(50, Math.round(original * 0.05));
      amount = Math.max(original, amount);
      s.ui.offerAmount = amount;
      subtitle =
        `${aiName} offered $${original} for tile (${tile.x},${tile.y})\n` +
        `Market value: $${market}`;
      helper = `Counter $${amount} = +${(markup * 100).toFixed(0)}% on their offer`;
      actionLabel = `Send counter · ${(probability * 100).toFixed(0)}% accept`;
    }

    this.offerTitle.setText(title);
    this.offerSubtitle.setText(subtitle);

    const { x, y, w } = this.offerCard;
    const helperTxt = this.add.text(x + 18, y + 92, helper, {
      fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3',
    }).setDepth(59);
    this.offerGroup.add(helperTxt);
    this.offerDynamicNodes.push(helperTxt);

    // Stepper
    const stepW = 36, amountW = 120;
    const sx = x + 18;
    const sy = y + 116;
    const minus = this.add.rectangle(sx, sy, stepW, 30, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(59);
    const minusTxt = this.add.text(sx + stepW / 2, sy + 15, '−', {
      fontFamily: 'monospace', fontSize: '18px', color: '#e8edf3', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(60);
    const amountTxt = this.add.text(sx + stepW + 10 + amountW / 2, sy + 15, `$${amount}`, {
      fontFamily: 'monospace', fontSize: '14px', color: '#ffd166', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(60);
    const plus = this.add.rectangle(sx + stepW + 10 + amountW + 10, sy, stepW, 30, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(59);
    const plusTxt = this.add.text(sx + stepW + 10 + amountW + 10 + stepW / 2, sy + 15, '+', {
      fontFamily: 'monospace', fontSize: '18px', color: '#e8edf3', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(60);

    const setAmount = (next) => {
      next = Math.max(minAmount, Math.round(next / 10) * 10);
      s.ui.offerAmount = next;
      this.refreshOfferModal();
    };
    minus.on('pointerdown', () => setAmount(amount - stepDelta));
    plus.on('pointerdown', () => setAmount(amount + stepDelta));
    this.offerGroup.add(minus); this.offerGroup.add(minusTxt);
    this.offerGroup.add(amountTxt);
    this.offerGroup.add(plus); this.offerGroup.add(plusTxt);
    this.offerDynamicNodes.push(minus, minusTxt, amountTxt, plus, plusTxt);

    // Probability bar
    const barW = w - 36, barX = x + 18, barY = y + 158;
    const barBg = this.add.rectangle(barX, barY, barW, 8, 0x243345).setOrigin(0, 0).setDepth(59);
    const barFill = this.add.rectangle(barX, barY, barW * probability, 8,
      probability > 0.6 ? 0x6ee79a : probability > 0.3 ? 0xffd166 : 0xff7a7a).setOrigin(0, 0).setDepth(60);
    this.offerGroup.add(barBg); this.offerGroup.add(barFill);
    this.offerDynamicNodes.push(barBg, barFill);

    // Submit button
    const subBg = this.add.rectangle(x + 18, y + 200, w - 36, 36, 0x6a4cb2)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(59);
    const subTxt = this.add.text(x + w / 2, y + 218, actionLabel, {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(60);
    subBg.on('pointerover', () => subBg.setFillStyle(0x8a6cd2));
    subBg.on('pointerout', () => subBg.setFillStyle(0x6a4cb2));
    subBg.on('pointerdown', () => this.submitOffer());
    this.offerGroup.add(subBg); this.offerGroup.add(subTxt);
    this.offerDynamicNodes.push(subBg, subTxt);
  }

  submitOffer() {
    const s = this.state;
    const ctx = this.offerCtx;
    if (!ctx) return;
    const tile = s.map.tiles[ctx.tileId];
    const amount = s.ui.offerAmount;
    let r;
    if (ctx.mode === 'initiate') {
      r = makePurchaseOffer(s, tile, amount);
    } else {
      r = counterOffer(s, tile, amount);
    }
    if (!r.ok && r.reason) pushLog(s, r.reason);
    this.closeOfferModal();
  }

  // -----------------------------------------------------------------------
  // FX layer — coins, pop text, tile bounces. Driven by state.fxQueue.
  // -----------------------------------------------------------------------
  drainFxQueue() {
    const q = this.state.fxQueue;
    if (!q || q.length === 0) return;
    while (q.length) {
      const fx = q.shift();
      this.playFx(fx);
    }
  }

  playFx(fx) {
    if (fx.type === 'sfx') {
      playSfx(fx.kind);
      return;
    }
    // Tile-specific visuals only render on the map they belong to. Player FX always
    // emerges from home; if the player is currently visiting a foreign map, skip.
    const referencesTile = fx.atTile != null
      || (fx.from && fx.from.tileId != null)
      || (fx.to && fx.to.tileId != null)
      || fx.tileId != null;
    if (referencesTile && this.state.ui.currentMap !== 'home') return;
    if (fx.type === 'coins') {
      const from = this.resolveFxPoint(fx.from);
      const to = this.resolveFxPoint(fx.to);
      const count = Math.max(1, Math.min(12, fx.count ?? 5));
      const color = fx.color ?? 0xffd166;
      for (let i = 0; i < count; i++) this.spawnCoin(from, to, i * 60, color);
      if (fx.value) this.spawnPopText(from, `${fx.value > 0 ? '+' : ''}$${fx.value}`, color);
      // Coin trail uses color to pick the right ping. Red-ish = expense, gold = income.
      const r = (color >> 16) & 0xff;
      const g = (color >> 8) & 0xff;
      const isExpense = r > g + 60;
      playSfx(isExpense ? 'coinNeg' : 'coin');
      return;
    }
    if (fx.type === 'popText') {
      const at = fx.atTile != null ? this.tileCenter(fx.atTile) : (fx.at || { x: 0, y: 0 });
      const c = fx.color
        ? (typeof fx.color === 'string'
            ? Phaser.Display.Color.HexStringToColor(fx.color).color
            : fx.color)
        : 0xffaa55;
      this.spawnPopText(at, fx.text, c, fx.duration ?? 1200, fx.rise ?? 36, fx.fontSize ?? 13);
      return;
    }
    if (fx.type === 'bounceTile') {
      this.bounceTile(fx.tileId, fx.scale ?? 1.25);
      return;
    }
  }

  resolveFxPoint(p) {
    if (p === 'cash') return this.cashIndicatorPos();
    if (p === 'bank') return this.bankBtnPos();
    if (p && p.tileId != null) return this.tileCenter(p.tileId);
    if (p && typeof p.x === 'number') return p;
    return { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
  }

  cashIndicatorPos() {
    return { x: 130, y: 22 };
  }

  bankBtnPos() {
    if (!this.bankBtnBg) return { x: GAME_WIDTH - 200, y: 22 };
    return { x: this.bankBtnBg.x + 40, y: 22 };
  }

  tileCenter(tileId) {
    const map = this.currentMap();
    const tile = map.tiles[tileId];
    if (!tile) return { x: 0, y: 0 };
    return {
      x: MAP_OFFSET_X + tile.x * MAP.tilePx + MAP.tilePx / 2,
      y: MAP_OFFSET_Y + tile.y * MAP.tilePx + MAP.tilePx / 2,
    };
  }

  spawnCoin(from, to, delay, color) {
    const coin = this.add.circle(from.x, from.y, 4, color)
      .setStrokeStyle(1, 0x000000, 0.5).setDepth(80).setAlpha(0);
    const liftY = from.y - 18 - Math.random() * 14;
    const liftX = from.x + (Math.random() - 0.5) * 24;
    this.tweens.add({
      targets: coin,
      alpha: 1,
      x: liftX,
      y: liftY,
      duration: 180,
      delay,
      ease: 'Sine.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: coin,
          x: to.x,
          y: to.y,
          duration: 520,
          ease: 'Cubic.easeIn',
          onComplete: () => {
            this.tweens.add({
              targets: coin,
              alpha: 0,
              scale: 0.6,
              duration: 120,
              onComplete: () => coin.destroy(),
            });
          },
        });
      },
    });
  }

  spawnPopText(at, text, color = 0xffd166, duration = 1200, rise = 36, fontSize = 13) {
    const colorStr = typeof color === 'number'
      ? '#' + color.toString(16).padStart(6, '0')
      : color;
    const t = this.add.text(at.x, at.y, text, {
      fontFamily: 'monospace', fontSize: `${fontSize}px`, color: colorStr, fontStyle: 'bold',
      stroke: '#000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(81);
    // Hold for the first 60% of duration before fading, so the text is readable.
    const holdMs = duration * 0.55;
    const fadeMs = duration - holdMs;
    this.tweens.add({
      targets: t, y: at.y - rise * 0.6, duration: holdMs, ease: 'Sine.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: t,
          y: at.y - rise,
          alpha: 0,
          duration: fadeMs,
          ease: 'Cubic.easeOut',
          onComplete: () => t.destroy(),
        });
      },
    });
  }

  bounceTile(tileId, peakScale = 1.25) {
    const rect = this.tileRects[tileId];
    if (!rect) return;
    // Skip if a bounce is already in flight on this tile — overlapping bounces
    // race on the origin/position restore in onComplete and cause visual jumps.
    if (rect._bouncing) return;
    rect._bouncing = true;
    const cx = rect.x + (MAP.tilePx - 1) * 0.5;
    const cy = rect.y + (MAP.tilePx - 1) * 0.5;
    rect.setOrigin(0.5, 0.5);
    rect.x = cx; rect.y = cy;
    this.tweens.add({
      targets: rect,
      scaleX: peakScale,
      scaleY: peakScale,
      duration: 160,
      yoyo: true,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        rect.setOrigin(0, 0);
        rect.x = cx - (MAP.tilePx - 1) * 0.5;
        rect.y = cy - (MAP.tilePx - 1) * 0.5;
        rect._bouncing = false;
      },
    });
  }
}
