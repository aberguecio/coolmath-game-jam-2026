import Phaser from 'phaser';
import { Boot } from './scenes/Boot.js';
import { Preloader } from './scenes/Preloader.js';
import { MainMenu } from './scenes/MainMenu.js';
import { Game } from './scenes/Game.js';
import { GAME_WIDTH, GAME_HEIGHT } from './config.js';
import { mountDebugPanel } from './debug-panel.js';

const config = {
  type: Phaser.AUTO,
  parent: 'app',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#0f1923',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [Boot, Preloader, MainMenu, Game],
};

const game = new Phaser.Game(config);

if (import.meta.env.DEV) {
  mountDebugPanel(game);
}

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
  import.meta.hot.dispose(() => {
    game.destroy(true);
  });
}
