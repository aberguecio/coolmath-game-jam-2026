import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';
import { MAP, TIME } from '../data/tunables.js';
import { PRODUCIBLES, PRODUCIBLE_LIST } from '../data/producibles.js';
import { COUNTRIES, COUNTRY_LIST, PLAYER_COUNTRY_ID } from '../data/countries.js';
import { TUTORIAL_STEPS } from '../data/tutorialSteps.js';
import {
  createInitialState, initAIFarmers, tilePrice, pushLog, persistTutorial,
} from '../state/GameState.js';
import { tickClock, setSpeed, formatDate } from '../systems/Clock.js';
import {
  tickMarket, priceOf, priceTrend, tickCountriesYearly,
  sellFromInventory, buyFromGlobal, inventoryOf,
  effectiveProductionFor, elasticityFor, elasticityTargetFor,
  populationSpend, marketInventoryOf,
} from '../systems/Market.js';
import {
  tickIndustries, tickIndustrySalaries, tickFiscalCrisis, seedIndustries,
} from '../systems/Industries.js';
import { INDUSTRIES } from '../data/industries.js';
import {
  tickFarming, buyTile, plowTile, plantTile, harvestTile, loteTile,
  tileFinanceQuote, toggleAutoReplant,
} from '../systems/Farming.js';
import { surveyTile, mineralRichness, canMineHere } from '../systems/Mining.js';
import { MINERALS, OFFERS } from '../data/tunables.js';
import {
  acceptOffer, rejectOffer, counterOffer, makePurchaseOffer,
  buyStartingAmount, buyAcceptProbability, counterAcceptProbability,
} from '../systems/Trade.js';
import {
  tickLoans, applyForLoan, eligibleProducts, quoteLoan, totalDebt, totalMonthlyPayment,
  loansOf,
} from '../systems/Bank.js';
import { tickCityYearly, cityRadius, distanceToCity, isInsideHalo, lotePrice } from '../systems/City.js';
import { tickAI, tickAIMonthly } from '../systems/AI.js';
import { tickEvents, activeEventLabels } from '../systems/Events.js';
import { LOAN_PRODUCTS, LOAN_PRODUCT_LIST, resolveMaxPrincipal } from '../data/loanProducts.js';
import { startMusic, toggleMute, isMusicMuted } from '../systems/Music.js';
import { play as playSfx } from '../systems/Sfx.js';

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

  create() {
    this.state = createInitialState();
    initAIFarmers(this.state);
    seedIndustries(this.state);

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
    this.buildTutorialOverlay();
    this.offerMarkers = [];

    // Music starts on first user gesture (browser policy).
    this.input.once('pointerdown', () => startMusic());

    this.input.keyboard.on('keydown-SPACE', () => {
      this.state.time.paused = !this.state.time.paused;
    });
    // Number-key shortcuts auto-bind to whatever speeds are registered (1..N).
    const numberKeys = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE'];
    for (let i = 1; i < TIME.speedLabels.length && i - 1 < numberKeys.length; i++) {
      const idx = i;
      this.input.keyboard.on(`keydown-${numberKeys[i - 1]}`, () => setSpeed(this.state, idx));
    }
    this.input.keyboard.on('keydown-ESC', () => {
      if (this.state.ui.offerOpen) { this.closeOfferModal(); return; }
      if (this.state.ui.marketOpen) { this.toggleMarket(false); return; }
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
    const r = cityRadius(c);
    const cx = MAP_OFFSET_X + c.x * MAP.tilePx + MAP.tilePx / 2;
    const cy = MAP_OFFSET_Y + c.y * MAP.tilePx + MAP.tilePx / 2;

    this.cityGfx.clear();
    this.cityGfx.fillStyle(0x66ccff, 0.10);
    this.cityGfx.fillCircle(cx, cy, r * MAP.tilePx);
    this.cityGfx.lineStyle(1, 0x66ccff, 0.45);
    this.cityGfx.strokeCircle(cx, cy, r * MAP.tilePx);
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
            const interp = Phaser.Display.Color.Interpolate.ColorWithColor(
              Phaser.Display.Color.IntegerToColor(0x6b4a2a),
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
    this.refreshMineralDots();
  }

  refreshMineralDots() {
    if (!this.mineralDots) this.mineralDots = this.add.graphics().setDepth(2);
    this.mineralDots.clear();
    const s = this.state;
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

      // Industry indicator: small filled square in the recipe's color, top-right.
      if (tile.industryId) {
        const ind = s.industries.find(i => i.id === tile.industryId);
        if (ind) {
          const status = ind.status;
          const fillColor = status === 'building' ? 0x7a8694
                          : status === 'closed' ? 0x4a4a4a
                          : status === 'idle' ? 0xb27a3a
                          : 0xeec27a;
          this.mineralDots.fillStyle(fillColor, 0.95);
          this.mineralDots.fillRect(x0 + tilePx - 12, y0 + tilePx - 12, 9, 9);
          this.mineralDots.lineStyle(1, 0x000000, 0.6);
          this.mineralDots.strokeRect(x0 + tilePx - 12, y0 + tilePx - 12, 9, 9);
        }
      }
      if (!tile.surveyed) continue;
      const minerals = [];
      for (const def of PRODUCIBLE_LIST) {
        if (def.category !== 'mining') continue;
        const r = mineralRichness(tile, def.id);
        if (r > 0) minerals.push({ color: def.color, r });
      }
      if (minerals.length === 0) {
        this.mineralDots.lineStyle(1, 0x566370, 0.7);
        this.mineralDots.lineBetween(x0 + 3, y0 + 3, x0 + 7, y0 + 7);
        this.mineralDots.lineBetween(x0 + 7, y0 + 3, x0 + 3, y0 + 7);
        continue;
      }
      minerals.slice(0, 3).forEach((m, i) => {
        const cx = x0 + 4 + i * 6;
        const cy = y0 + 4;
        this.mineralDots.fillStyle(m.color, 1);
        this.mineralDots.fillCircle(cx, cy, 2.5);
        this.mineralDots.lineStyle(1, 0x000000, 0.7);
        this.mineralDots.strokeCircle(cx, cy, 2.5);
      });
    }
  }

  // -----------------------------------------------------------------------
  // TOP BAR
  // -----------------------------------------------------------------------
  buildTopBar() {
    this.topBg = this.add.rectangle(0, 0, GAME_WIDTH, 44, 0x131e2b).setOrigin(0, 0);
    this.topText = this.add.text(12, 12, '', {
      fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3',
    });

    const speedCount = TIME.speedLabels.length;
    const bankBtnX = GAME_WIDTH - speedCount * 38 - 8 - 90;
    this.bankBtnBg = this.add.rectangle(bankBtnX, 8, 80, 28, 0x6ee7b7).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.bankBtnTxt = this.add.text(bankBtnX + 40, 22, '🏦 BANK', {
      fontFamily: 'monospace', fontSize: '12px', color: '#0f1923', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.bankBtnBg.on('pointerover', () => this.bankBtnBg.setFillStyle(0x9af0d2));
    this.bankBtnBg.on('pointerout', () => this.bankBtnBg.setFillStyle(0x6ee7b7));
    this.bankBtnBg.on('pointerdown', () => this.toggleBank(true));

    // MARKET button — left of BANK
    const marketBtnX = bankBtnX - 88;
    this.marketBtnBg = this.add.rectangle(marketBtnX, 8, 80, 28, 0xffb347).setOrigin(0, 0)
      .setInteractive({ useHandCursor: true });
    this.marketBtnTxt = this.add.text(marketBtnX + 40, 22, '📈 MARKET', {
      fontFamily: 'monospace', fontSize: '12px', color: '#0f1923', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.marketBtnBg.on('pointerover', () => this.marketBtnBg.setFillStyle(0xffc878));
    this.marketBtnBg.on('pointerout', () => this.marketBtnBg.setFillStyle(0xffb347));
    this.marketBtnBg.on('pointerdown', () => this.toggleMarket(true));

    // Music toggle — left of MARKET
    const musicX = marketBtnX - 36;
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
    this.topText.setText(
      `📅 ${formatDate(s)}   💰 $${Math.round(s.player.cash)}   🏦 $${Math.round(debt)} (${loans})   ` +
      `mo $${Math.round(cuota)}   📍 ${here}`,
    );
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

    const yCountries = GAME_HEIGHT - 340;
    this.countriesTitle = this.add.text(PANEL_X + 6, yCountries, 'COUNTRIES (click for chart)', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
    });
    this.countriesY = yCountries + 14;
    this.countryRows = [];   // rebuilt each refresh

    const yMarket = GAME_HEIGHT - 250;
    this.marketTitle = this.add.text(PANEL_X + 6, yMarket, 'MARKET', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
    });
    this.marketText = this.add.text(PANEL_X + 6, yMarket + 12, '', {
      fontFamily: 'monospace', fontSize: '9px', color: '#e8edf3', lineSpacing: 0,
    });

    const yEvents = GAME_HEIGHT - 170;
    this.eventsTitle = this.add.text(PANEL_X + 6, yEvents, 'EVENTS', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
    });
    this.eventsText = this.add.text(PANEL_X + 6, yEvents + 14, '', {
      fontFamily: 'monospace', fontSize: '10px', color: '#ffb347', wordWrap: { width: PANEL_W - 12 },
    });

    const yLog = GAME_HEIGHT - 130;
    this.logTitle = this.add.text(PANEL_X + 6, yLog, 'LOG', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
    });
    this.logText = this.add.text(PANEL_X + 6, yLog + 14, '', {
      fontFamily: 'monospace', fontSize: '10px', color: '#9aa4ad', wordWrap: { width: PANEL_W - 12 },
    });
  }

  clearActionButtons() {
    for (const b of this.actionButtons) {
      b.bg.destroy();
      b.txt.destroy();
    }
    this.actionButtons = [];
  }

  addActionButton(label, y, enabled, onClick, hint = '', color = 0x2a4a6a) {
    const bg = this.add.rectangle(PANEL_X + 6, y, PANEL_W - 16, 24, enabled ? color : 0x1d2a3a)
      .setOrigin(0, 0)
      .setInteractive({ useHandCursor: enabled });
    const txt = this.add.text(PANEL_X + 12, y + 12, label + (hint ? `  ${hint}` : ''), {
      fontFamily: 'monospace', fontSize: '10px', color: enabled ? '#e8edf3' : '#566370',
    }).setOrigin(0, 0.5);
    if (enabled) {
      bg.on('pointerover', () => bg.setFillStyle(0x3a6090));
      bg.on('pointerout', () => bg.setFillStyle(color));
      bg.on('pointerdown', onClick);
    }
    this.actionButtons.push({ bg, txt });
    return y + 27;
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
      const lines = [
        `Tile (${tile.x},${tile.y})`,
        `Owner: ${this.ownerLabel(tile)}`,
        `Quality: ${(tile.quality * 100).toFixed(0)}%`,
        `City dist: ${distanceToCity(tile, s.city).toFixed(1)}`,
        `State: ${STATE_LABEL[tile.state] || tile.state}`,
      ];
      // Industry on this tile? Show recipe + status + monthly P&L.
      if (tile.industryId) {
        const ind = s.industries.find(i => i.id === tile.industryId);
        if (ind) {
          const recipe = INDUSTRIES[ind.recipeId];
          if (recipe) {
            const ins = Object.entries(recipe.inputs).map(([k, v]) => `${v}× ${k}`).join(' + ');
            const outs = Object.entries(recipe.outputs).map(([k, v]) => `${v}× ${k}`).join(' + ');
            lines.push(`🏭 ${recipe.name} [${ind.status}]`);
            lines.push(`   ${ins} → ${outs}`);
            lines.push(`   cycle ${recipe.cycleDays}d · salary $${recipe.monthlySalary}/mo`);
            if (ind.status === 'building') {
              const left = recipe.buildDays - (s.time.totalDays - ind.startBuildDay);
              lines.push(`   building: ${Math.max(0, left)}d left`);
            } else if (ind.status === 'idle') {
              lines.push(`   idle — waiting for inputs`);
            } else if (ind.status === 'closed') {
              lines.push(`   CLOSED — reopen costs $${recipe.buildCost}`);
            } else {
              const since = s.time.totalDays - (ind.lastCycleDay ?? s.time.totalDays);
              lines.push(`   next cycle in ${Math.max(0, recipe.cycleDays - since)}d`);
            }
          }
        }
      }
      if (tile.crop && !tile.industryId) {
        const def = PRODUCIBLES[tile.crop];
        lines.push(`Crop: ${def.name}`);
        if (tile.state === 'planted') lines.push(`Growth: ${(tile.growth * 100).toFixed(0)}%`);
      }
      if (tile.owner === 'wild') lines.push(`Price: $${tilePrice(tile, s)}`);
      if (isInsideHalo(tile, s.city)) lines.push(`City halo · lot: $${lotePrice(tile, s.city)}`);
      // Boom indicator (visible whether owned or not)
      if ((tile.boomFactor ?? 1) > 1.05) {
        lines.push(`Boom +${Math.round(((tile.boomFactor - 1) * 100))}% (nearby discovery)`);
      }
      // Survey results
      if (tile.surveyed) {
        const deposits = [];
        for (const def of PRODUCIBLE_LIST) {
          if (def.category !== 'mining') continue;
          const r = mineralRichness(tile, def.id);
          if (r > 0) deposits.push(`${def.name} ${(r * 100).toFixed(0)}%`);
        }
        lines.push(deposits.length ? `Deposits: ${deposits.join(', ')}` : 'Deposits: none');
      } else if (tile.owner === 'player') {
        lines.push('Not surveyed');
      }
      this.panelText.setText(lines.join('\n'));

      let y = MAP_OFFSET_Y + 8 + lines.length * 13 + 10;

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
        // Survey state-aware action: not surveyed → button; surveyed empty → disabled status.
        if (!tile.surveyed) {
          y = this.addActionButton(
            `Survey land`,
            y,
            s.player.cash >= MINERALS.surveyCost,
            () => {
              const r = surveyTile(s, tile);
              if (!r.ok && r.reason) pushLog(s, r.reason);
              this.refreshAll();
            },
            `$${MINERALS.surveyCost} · reveals minerals`,
            0xb27a3a,
          );
        } else {
          // Already surveyed — show a status row so the player can tell why mining isn't an option.
          const hasAny = PRODUCIBLE_LIST.some(
            d => d.category === 'mining' && (mineralRichness(tile, d.id) > 0),
          );
          if (!hasAny) {
            y = this.addActionButton(
              `✕ No minerals (surveyed)`,
              y, false, () => {}, '', 0x2a2a32,
            );
          }
        }
        if (tile.state === 'fallow') {
          y = this.addActionButton(`Plow`, y, s.player.cash >= 50, () => {
            const r = plowTile(s, tile); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll();
          }, `$50`);
        }
        // Plowed tile → producibles that need plowing
        if (tile.state === 'plowed') {
          for (const def of PRODUCIBLE_LIST) {
            if (def.requiresPlow === false) continue;
            y = this.addActionButton(
              `${def.actionVerb || 'Plant'} ${def.name}`,
              y,
              s.player.cash >= def.seedCost,
              () => { const r = plantTile(s, tile, def.id); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll(); },
              `$${def.seedCost} · ${def.growthDays}d`,
            );
          }
        }
        // Fallow tile → producibles that don't need plowing (e.g. mining).
        // Mining options only appear when the tile is surveyed and has the deposit.
        if (tile.state === 'fallow') {
          for (const def of PRODUCIBLE_LIST) {
            if (def.requiresPlow !== false) continue;
            if (def.category === 'mining' && !canMineHere(tile, def)) continue;
            const richness = mineralRichness(tile, def.id);
            const richHint = def.category === 'mining' ? ` · ${(richness * 100).toFixed(0)}% rich` : '';
            y = this.addActionButton(
              `${def.actionVerb || 'Plant'} ${def.name}`,
              y,
              s.player.cash >= def.seedCost,
              () => { const r = plantTile(s, tile, def.id); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll(); },
              `$${def.seedCost} · ${def.growthDays}d${richHint}`,
            );
          }
        }
        // Mature tiles auto-harvest in tickFarming — no manual button needed.

        // Auto-replant toggle for annual crops. Perennials regrow by themselves.
        if (tile.crop) {
          const cdef = PRODUCIBLES[tile.crop];
          if (cdef && !cdef.perennial) {
            const isOn = tile.autoReplant === true;
            const cycleCost = (cdef.requiresPlow ? 50 : 0) + cdef.seedCost;
            y = this.addActionButton(
              isOn ? `↻ Loop ON — auto-replant ${cdef.name}` : `↻ Loop OFF — manual replant`,
              y, true,
              () => { toggleAutoReplant(s, tile); this.refreshAll(); },
              isOn ? `${cycleCost}/cycle` : 'click to enable',
              isOn ? 0x2a8a5a : 0x4a3a6a,
            );
          }
        }
        if (isInsideHalo(tile, s.city) && tile.state !== 'planted' && tile.state !== 'mature' && tile.state !== 'lot') {
          const price = lotePrice(tile, s.city);
          y = this.addActionButton(`Develop & sell`, y, price > 0, () => {
            const r = loteTile(s, tile); if (!r.ok && r.reason) pushLog(s, r.reason); this.refreshAll();
          }, `+$${price}`);
        }
      }
    }

    // Countries panel — clickable rows. Each shows population + net trade balance summary.
    for (const node of this.countryRows) node.destroy();
    this.countryRows = [];
    let cy = this.countriesY;
    for (const c of COUNTRY_LIST) {
      const run = s.countries[c.id];
      const netBalance = PRODUCIBLE_LIST.reduce(
        (acc, def) => acc + (run.tradeBalanceEMA?.[def.id] ?? 0),
        0,
      );
      const isPlayer = c.id === PLAYER_COUNTRY_ID;
      const arrow = netBalance > 0.5 ? '⇧' : netBalance < -0.5 ? '⇩' : '·';
      const balColor = netBalance > 0.5 ? '#ff8c8c' : netBalance < -0.5 ? '#8cffaa' : '#cdd6df';
      const popStr = c.population >= 100
        ? `${Math.round(run.population)}M`
        : `${run.population.toFixed(1)}M`;

      const rowBg = this.add.rectangle(PANEL_X + 6, cy, PANEL_W - 16, 14, isPlayer ? 0x1a3a2a : 0x1a2633)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true });
      const nameTxt = this.add.text(PANEL_X + 10, cy + 7, `${c.name}`, {
        fontFamily: 'monospace', fontSize: '10px', color: isPlayer ? '#6ee7b7' : '#cdd6df',
      }).setOrigin(0, 0.5);
      const popTxt = this.add.text(PANEL_X + 70, cy + 7, popStr, {
        fontFamily: 'monospace', fontSize: '10px', color: '#9aa4ad',
      }).setOrigin(0, 0.5);
      const balTxt = this.add.text(PANEL_X + PANEL_W - 22, cy + 7,
        `${arrow} ${Math.round(Math.abs(netBalance))}`, {
        fontFamily: 'monospace', fontSize: '10px', color: balColor,
      }).setOrigin(1, 0.5);
      rowBg.on('pointerover', () => rowBg.setFillStyle(isPlayer ? 0x244d3a : 0x243345));
      rowBg.on('pointerout', () => rowBg.setFillStyle(isPlayer ? 0x1a3a2a : 0x1a2633));
      rowBg.on('pointerdown', () => this.openCountryChart(c.id));
      this.countryRows.push(rowBg, nameTxt, popTxt, balTxt);
      cy += 16;
    }

    // Market: name · price · stock · trend (compact for many producibles)
    const marketLines = PRODUCIBLE_LIST.map(def => {
      const p = priceOf(s, def.id);
      const stock = Math.round(s.market.inventory?.['home']?.[def.id] || 0);
      const t = priceTrend(s, def.id, 7);
      const arrow = t > 0.02 ? '▲' : t < -0.02 ? '▼' : '·';
      return `${def.name.slice(0, 7).padEnd(7)} $${String(p).padStart(5)} ${String(stock).padStart(5)} ${arrow}${(t * 100).toFixed(1)}%`;
    });
    this.marketText.setText(marketLines.join('\n'));

    // Events
    const labels = activeEventLabels(s);
    this.eventsText.setText(labels.length ? labels.join(' · ') : '—');

    // Log
    const logLines = s.log.slice(0, 4).map(l => `d${l.day}: ${l.text}`);
    this.logText.setText(logLines.join('\n'));
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

  // -----------------------------------------------------------------------
  // COUNTRY CHART MODAL
  // -----------------------------------------------------------------------
  buildCountryChart() {
    this.chartGroup = this.add.container(0, 0).setVisible(false).setDepth(55);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.65)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.closeCountryChart());
    this.chartGroup.add(backdrop);

    // Card height adapts to producible count.
    const w = 560;
    const rowH = 36;
    const headerH = 90;
    const padding = 24;
    const h = Math.min(GAME_HEIGHT - 20,
      headerH + (PRODUCIBLE_LIST?.length ?? 8) * rowH + padding);
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xcdd6df).setInteractive();
    this.chartGroup.add(card);

    this.chartTitle = this.add.text(x + 18, y + 14, '', {
      fontFamily: 'monospace', fontSize: '18px', color: '#e8edf3', fontStyle: 'bold',
    });
    this.chartGroup.add(this.chartTitle);

    this.chartSubtitle = this.add.text(x + 18, y + 40, '', {
      fontFamily: 'monospace', fontSize: '11px', color: '#9aa4ad',
    });
    this.chartGroup.add(this.chartSubtitle);

    this.chartLegend = this.add.text(x + 18, y + 58,
      '⇧ importing (buying)   ⇩ exporting (selling)', {
      fontFamily: 'monospace', fontSize: '10px', color: '#7a8694',
    });
    this.chartGroup.add(this.chartLegend);

    const closeBtn = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerdown', () => this.closeCountryChart());
    this.chartGroup.add(closeBtn);
    this.chartGroup.add(closeTxt);

    this.chartCard = { x, y, w, h };
    this.chartGfx = this.add.graphics().setDepth(56);
    this.chartGroup.add(this.chartGfx);
    this.chartLabels = [];
  }

  openCountryChart(countryId) {
    this.chartCountryId = countryId;
    if (!this.state.ui.countryChartOpen) {
      this.state.ui.savedSpeedIdx = this.state.time.speedIdx;
      setSpeed(this.state, 0);
    }
    this.state.ui.countryChartOpen = true;
    this.chartGroup.setVisible(true);
    this.refreshCountryChart();
    this.refreshTopBar();
  }

  // Lazily build a Visit button on the country-chart card. Re-uses one button across opens.
  ensureVisitButton(countryId) {
    if (!this.chartCard) return;
    const { x, y, w } = this.chartCard;
    const labelTxt = `Visit ${COUNTRIES[countryId]?.name ?? countryId} →`;
    if (!this.visitBtnBg) {
      this.visitBtnBg = this.add.rectangle(x + 18, y + 76, w - 36, 28, 0xffb347)
        .setOrigin(0, 0).setInteractive({ useHandCursor: true }).setDepth(57);
      this.visitTxt = this.add.text(x + w / 2, y + 90, labelTxt, {
        fontFamily: 'monospace', fontSize: '12px', color: '#0f1923', fontStyle: 'bold',
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
      this.visitTxt.setText(labelTxt);
    }
  }

  closeCountryChart() {
    if (this.state.ui.countryChartOpen) {
      setSpeed(this.state, this.state.ui.savedSpeedIdx ?? 1);
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
    const wf = Math.round(run.wageFund || 0);
    const tr = Math.round(run.treasury || 0);
    const mp = Math.round(run.marketPool || 0);
    const pi = (run.priceIndex || 1).toFixed(2);
    const piPct = (((run.priceIndex || 1) - 1) * 100).toFixed(0);
    const piSign = piPct >= 0 ? '+' : '';
    const crisis = run.fiscalCrisis?.active ? '  🚨 CRISIS' : '';
    const trColor = tr < 0 ? '#ff7a7a' : '#cdd6df';
    this.chartSubtitle.setText(
      `Pop ${run.population.toFixed(2)}M  ·  Wages $${wf.toLocaleString()}  ·  Treasury $${tr.toLocaleString()}\n` +
      `Market Pool $${mp.toLocaleString()}  ·  priceIndex ${pi} (${piSign}${piPct}%)${crisis}`,
    );
    this.chartSubtitle.setColor(trColor);
    this.ensureVisitButton(countryId);

    // Clear old labels
    for (const node of this.chartLabels) node.destroy();
    this.chartLabels = [];
    this.chartGfx.clear();

    const { x, y, w } = this.chartCard;
    const rows = PRODUCIBLE_LIST;
    const rowH = 36;
    const startY = y + 116;       // leave room for Visit button
    const labelW = 90;
    const valueW = 70;
    const barAreaX = x + 20 + labelW;
    const barAreaW = w - 40 - labelW - valueW;
    const axisX = barAreaX + barAreaW / 2;

    // Find max abs value across producibles to scale bars
    let maxAbs = 1;
    for (const def of rows) {
      const v = Math.abs(run.tradeBalanceEMA?.[def.id] ?? 0);
      if (v > maxAbs) maxAbs = v;
    }

    rows.forEach((def, i) => {
      const cy = startY + i * rowH;
      const midY = cy + rowH / 2;

      // Producible name
      const nameTxt = this.add.text(x + 20, midY - 5, def.name, {
        fontFamily: 'monospace', fontSize: '11px', color: '#e8edf3',
      }).setOrigin(0, 0.5).setDepth(57);
      this.chartGroup.add(nameTxt);
      this.chartLabels.push(nameTxt);

      // Per-row supply/demand breakdown beneath the name.
      // Shows what's currently producing (×scale, delayed) AND today's planting decision
      // (which will land in production growthDays from now).
      const effProd = effectiveProductionFor(s, countryId, def.id);
      const elasticity = elasticityFor(s, countryId, def.id);
      const target = elasticityTargetFor(s, countryId, def.id);
      const consDaily = run.consumption[def.id] || 0;
      const drift = target > elasticity + 0.05 ? '→' : target < elasticity - 0.05 ? '←' : '·';
      const breakdown =
        `${effProd.toFixed(1)}p ×${elasticity.toFixed(2)}${drift}planting ${target.toFixed(2)} / ${consDaily.toFixed(1)}c`;
      const breakdownTxt = this.add.text(x + 20, midY + 8, breakdown, {
        fontFamily: 'monospace', fontSize: '8px',
        color: elasticity > 1.05 ? '#8cffaa' : elasticity < 0.95 ? '#ff8c8c' : '#7a8694',
      }).setOrigin(0, 0.5).setDepth(57);
      this.chartGroup.add(breakdownTxt);
      this.chartLabels.push(breakdownTxt);

      // Bar background (axis line)
      this.chartGfx.lineStyle(1, 0x3a4d63, 1);
      this.chartGfx.lineBetween(barAreaX, midY, barAreaX + barAreaW, midY);
      this.chartGfx.lineStyle(1, 0xcdd6df, 0.7);
      this.chartGfx.lineBetween(axisX, cy + 4, axisX, cy + rowH - 4);

      const value = run.tradeBalanceEMA?.[def.id] ?? 0;
      const importing = value > 0;
      const barLen = (Math.abs(value) / maxAbs) * (barAreaW / 2 - 4);
      const barH = 14;
      const barColor = importing ? 0xff6b6b : 0x6ee79a;

      this.chartGfx.fillStyle(barColor, 0.85);
      if (importing) this.chartGfx.fillRect(axisX, midY - barH / 2, barLen, barH);
      else this.chartGfx.fillRect(axisX - barLen, midY - barH / 2, barLen, barH);

      const arrow = Math.abs(value) < 0.5 ? '·' : (importing ? '⇧' : '⇩');
      const valTxt = this.add.text(barAreaX + barAreaW + 8, midY,
        `${arrow} ${value > 0 ? '+' : ''}${value.toFixed(1)}`, {
        fontFamily: 'monospace', fontSize: '11px', fontStyle: 'bold',
        color: importing ? '#ff8c8c' : '#8cffaa',
      }).setOrigin(0, 0.5).setDepth(57);
      this.chartGroup.add(valTxt);
      this.chartLabels.push(valTxt);
    });
  }

  toggleBank(open) {
    const s = this.state;
    if (open && !s.ui.bankOpen) {
      // Save current speed and pause the simulation
      s.ui.savedSpeedIdx = s.time.speedIdx;
      setSpeed(s, 0);
      s.tutorial.bankOpened = true;
    } else if (!open && s.ui.bankOpen) {
      // Restore prior speed
      setSpeed(s, s.ui.savedSpeedIdx ?? 1);
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
    this.refreshTutorial();
  }

  update(_time, delta) {
    const events = tickClock(this.state, delta);
    // Canonical daily/monthly/yearly tick order (per plan section 7c):
    if (events.day) {
      tickEvents(this.state);
      tickFarming(this.state);          // 2: harvests → owner inventory
      tickIndustries(this.state);       // 3: industries consume inputs → produce outputs
      tickMarket(this.state);           // 4: per-country supply/demand + cross-country trade + prices
      populationSpend(this.state);      // 5: country wage funds buy food (via executeTransaction)
      tickAI(this.state);               // 7: AI daily decisions (tickWages welfare baked into populationSpend)
    }
    if (events.month) {
      tickIndustrySalaries(this.state); // 8: industries pay salaries
      tickLoans(this.state);            // 9: bank charges
      tickFiscalCrisis(this.state);     // 10: crisis state machine
      tickAIMonthly(this.state);        // 11: AI close unprofitable industries
    }
    if (events.year) {
      tickCityYearly(this.state);
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
  // GLOBAL MARKET MODAL — view prices/charts, buy/sell from inventory
  // -----------------------------------------------------------------------
  buildMarketModal() {
    this.marketGroup = this.add.container(0, 0).setVisible(false).setDepth(56);

    const backdrop = this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, 0.7)
      .setOrigin(0, 0).setInteractive();
    backdrop.on('pointerdown', () => this.toggleMarket(false));
    this.marketGroup.add(backdrop);

    // Modal sized for up to ~10 commodity rows
    const w = 760;
    const headerH = 76;
    const rowH = 44;
    const padding = 22;
    const h = Math.min(GAME_HEIGHT - 12,
      headerH + (PRODUCIBLE_LIST.length * rowH) + padding);
    const x = (GAME_WIDTH - w) / 2, y = (GAME_HEIGHT - h) / 2;
    const card = this.add.rectangle(x, y, w, h, 0x131e2b)
      .setOrigin(0, 0).setStrokeStyle(2, 0xffb347).setInteractive();
    this.marketGroup.add(card);

    const title = this.add.text(x + 18, y + 14, '📈  GLOBAL MARKET', {
      fontFamily: 'monospace', fontSize: '18px', color: '#ffb347', fontStyle: 'bold',
    });
    this.marketGroup.add(title);

    const closeBtn = this.add.rectangle(x + w - 36, y + 14, 24, 24, 0x2a4a6a)
      .setOrigin(0, 0).setInteractive({ useHandCursor: true });
    const closeTxt = this.add.text(x + w - 24, y + 26, '✕', {
      fontFamily: 'monospace', fontSize: '13px', color: '#e8edf3',
    }).setOrigin(0.5);
    closeBtn.on('pointerdown', () => this.toggleMarket(false));
    this.marketGroup.add(closeBtn);
    this.marketGroup.add(closeTxt);

    // Header columns
    const hy = y + 50;
    const colHeaders = [
      { x: x + 18,  text: 'Commodity' },
      { x: x + 110, text: 'Price' },
      { x: x + 175, text: 'Trend (90d)' },
      { x: x + 305, text: 'Stock' },
      { x: x + 360, text: 'You' },
      { x: x + 420, text: 'Qty' },
      { x: x + 540, text: 'Sell' },
      { x: x + 620, text: 'Buy' },
    ];
    for (const c of colHeaders) {
      const t = this.add.text(c.x, hy, c.text, {
        fontFamily: 'monospace', fontSize: '10px', color: '#7a8694', fontStyle: 'bold',
      });
      this.marketGroup.add(t);
    }

    this.marketSparkGfx = this.add.graphics().setDepth(57);
    this.marketGroup.add(this.marketSparkGfx);
    this.marketCard = { x, y, w, h, rowsTop: y + headerH };
    this.marketDynamicNodes = [];
    if (!this.state.ui.marketQty) this.state.ui.marketQty = {};
  }

  toggleMarket(open) {
    const s = this.state;
    if (open && !s.ui.marketOpen) {
      s.ui.savedSpeedIdx = s.time.speedIdx;
      setSpeed(s, 0);
    } else if (!open && s.ui.marketOpen) {
      setSpeed(s, s.ui.savedSpeedIdx ?? 1);
    }
    s.ui.marketOpen = open;
    this.marketGroup.setVisible(open);
    if (open) this.refreshMarketModal();
    this.refreshTopBar();
  }

  refreshMarketModal() {
    const s = this.state;
    if (!s.ui.marketQty) s.ui.marketQty = {};

    for (const node of this.marketDynamicNodes) node.destroy();
    this.marketDynamicNodes = [];
    this.marketSparkGfx.clear();

    const { x, w, rowsTop } = this.marketCard;
    const rowH = 44;

    PRODUCIBLE_LIST.forEach((def, i) => {
      const ry = rowsTop + i * rowH;
      const midY = ry + rowH / 2;

      // Color swatch + name
      const swatch = this.add.rectangle(x + 18, midY, 10, 10, def.color).setOrigin(0, 0.5).setDepth(57);
      const nameTxt = this.add.text(x + 34, midY, def.name, {
        fontFamily: 'monospace', fontSize: '12px', color: '#e8edf3', fontStyle: 'bold',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(swatch); this.marketGroup.add(nameTxt);
      this.marketDynamicNodes.push(swatch, nameTxt);

      // Price + trend
      const price = priceOf(s, def.id);
      const trend = priceTrend(s, def.id, 7);
      const priceTxt = this.add.text(x + 110, midY, `$${price}`, {
        fontFamily: 'monospace', fontSize: '13px',
        color: trend > 0.02 ? '#6ee79a' : trend < -0.02 ? '#ff7a7a' : '#e8edf3',
        fontStyle: 'bold',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(priceTxt);
      this.marketDynamicNodes.push(priceTxt);

      // Sparkline (last 90 days)
      const sparkX = x + 175, sparkY = ry + 8, sparkW = 120, sparkH = rowH - 16;
      this.drawSparkline(this.marketSparkGfx, sparkX, sparkY, sparkW, sparkH,
        s.market.history?.['home']?.[def.id], trend);

      // Global stock + your inventory (showing home country values)
      const stock = Math.round(s.market.inventory?.['home']?.[def.id] || 0);
      const yours = Math.round(inventoryOf(s, 'player', def.id));
      const stockTxt = this.add.text(x + 305, midY, `${stock}u`, {
        fontFamily: 'monospace', fontSize: '11px', color: '#9aa4ad',
      }).setOrigin(0, 0.5).setDepth(57);
      const yoursTxt = this.add.text(x + 360, midY, `${yours}u`, {
        fontFamily: 'monospace', fontSize: '11px',
        color: yours > 0 ? '#ffd166' : '#9aa4ad', fontStyle: yours > 0 ? 'bold' : 'normal',
      }).setOrigin(0, 0.5).setDepth(57);
      this.marketGroup.add(stockTxt); this.marketGroup.add(yoursTxt);
      this.marketDynamicNodes.push(stockTxt, yoursTxt);

      // Quantity stepper
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

      // Sell button
      const sellEnabled = yours >= qty;
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
          const r = sellFromInventory(s, 'player', def.id, qty);
          if (r.ok) {
            pushLog(s, `Sold ${r.units}u ${def.name} → $${r.revenue}`);
            pushFx(s, {
              type: 'coins', from: 'cash', to: 'cash',
              count: 4, value: r.revenue, color: 0xffd166,
            });
            pushFx(s, { type: 'sfx', kind: 'coin' });
          } else if (r.reason) pushLog(s, r.reason);
          this.refreshMarketModal();
          this.refreshTopBar();
        });
      }
      this.marketGroup.add(sellBg); this.marketGroup.add(sellTxt);
      this.marketDynamicNodes.push(sellBg, sellTxt);

      // Buy button
      const buyCost = price * qty;
      const buyEnabled = stock >= qty && s.player.cash >= buyCost;
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
          const r = buyFromGlobal(s, 'player', def.id, qty);
          if (r.ok) {
            pushLog(s, `Bought ${r.units}u ${def.name} → -$${r.cost}`);
            pushFx(s, { type: 'sfx', kind: 'coinNeg' });
          } else if (r.reason) pushLog(s, r.reason);
          this.refreshMarketModal();
          this.refreshTopBar();
        });
      }
      this.marketGroup.add(buyBg); this.marketGroup.add(buyTxt);
      this.marketDynamicNodes.push(buyBg, buyTxt);
    });
  }

  drawSparkline(gfx, x, y, w, h, history, trend) {
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
    // Dotted baseline at the basePrice (visual reference)
    const def = PRODUCIBLE_LIST.find(p => history === this.state.market.history?.['home']?.[p.id]);
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
      s.ui.savedSpeedIdx = s.time.speedIdx;
      setSpeed(s, 0);
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
    if (this.state.ui.offerOpen) setSpeed(this.state, this.state.ui.savedSpeedIdx ?? 1);
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
      },
    });
  }
}
