import Phaser from 'phaser';
import { GAME_WIDTH, GAME_HEIGHT } from '../config.js';

export class MainMenu extends Phaser.Scene {
  constructor() {
    super('MainMenu');
  }

  init(data) {
    this.bankrupt = data?.bankrupt === true;
  }

  create() {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;

    this.add
      .text(cx, cy - 100, 'FARM TYCOON', {
        fontFamily: 'monospace', fontSize: '36px', color: '#ffb347',
      }).setOrigin(0.5);

    this.add
      .text(cx, cy - 60, 'Coolmath Game Jam 2026', {
        fontFamily: 'monospace', fontSize: '14px', color: '#7a8694',
      }).setOrigin(0.5);

    if (this.bankrupt) {
      this.add.text(cx, cy - 20, 'Bankrupt. The bank took everything.', {
        fontFamily: 'monospace', fontSize: '14px', color: '#ff4d6d',
      }).setOrigin(0.5);
    }

    const startBg = this.add.rectangle(cx, cy + 30, 220, 44, 0x2a4a6a)
      .setInteractive({ useHandCursor: true });
    this.add.text(cx, cy + 30, 'PLAY', {
      fontFamily: 'monospace', fontSize: '18px', color: '#e8edf3',
    }).setOrigin(0.5);
    startBg.on('pointerover', () => startBg.setFillStyle(0x3a6090));
    startBg.on('pointerout', () => startBg.setFillStyle(0x2a4a6a));
    startBg.on('pointerdown', () => this.scene.start('Game'));

    this.add.text(cx, cy + 90, 'Buy land · plant · harvest · pay your debt', {
      fontFamily: 'monospace', fontSize: '12px', color: '#9aa4ad',
    }).setOrigin(0.5);
    this.add.text(cx, cy + 110, 'left click for everything · 1/2/3 speed · SPACE pause', {
      fontFamily: 'monospace', fontSize: '11px', color: '#7a8694',
    }).setOrigin(0.5);
  }
}
