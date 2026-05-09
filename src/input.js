import Phaser from 'phaser';
import { KEYS } from './config.js';

export class Input {
  constructor(scene) {
    this.scene = scene;
    this.keys = {};
    for (const [name, codes] of Object.entries(KEYS)) {
      this.keys[name] = codes.map((code) =>
        scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes[code]),
      );
    }
  }

  isDown(name) {
    const group = this.keys[name];
    if (!group) return false;
    for (const k of group) if (k.isDown) return true;
    return false;
  }

  justPressed(name) {
    const group = this.keys[name];
    if (!group) return false;
    for (const k of group) if (Phaser.Input.Keyboard.JustDown(k)) return true;
    return false;
  }

  axisX() {
    return (this.isDown('RIGHT') ? 1 : 0) - (this.isDown('LEFT') ? 1 : 0);
  }

  axisY() {
    return (this.isDown('DOWN') ? 1 : 0) - (this.isDown('UP') ? 1 : 0);
  }
}
