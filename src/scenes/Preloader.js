import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

export class Preloader extends Phaser.Scene {
  constructor() {
    super('Preloader');
  }

  preload() {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    this.add.rectangle(cx, cy, 360, 6, 0x222b36);
    const bar = this.add.rectangle(cx - 180, cy, 0, 6, 0xffb347).setOrigin(0, 0.5);

    this.load.on('progress', (p) => {
      bar.width = 360 * p;
    });

    // Drop assets in /public/assets and load them here:
    // this.load.image('player', 'assets/player.png');
    // this.load.audio('hit', 'assets/hit.wav');
  }

  create() {
    this.scene.start('MainMenu');
  }
}
