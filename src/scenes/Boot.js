import Phaser from 'phaser';

export class Boot extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload() {}

  create() {
    this.scene.start('Preloader');
  }
}
