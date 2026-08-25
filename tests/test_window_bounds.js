const assert = require('assert');
const { fitBoundsToWorkArea } = require('../window-bounds');

const leftDisplay = { x: -1280, y: 120, width: 1280, height: 720 };

assert.deepStrictEqual(
  fitBoundsToWorkArea({ x: -1400, y: 700, width: 360, height: 500 }, leftDisplay),
  { x: -1280, y: 340, width: 360, height: 500 },
  '跨屏后窗口应完整收进目标屏幕的可用区域',
);

assert.deepStrictEqual(
  fitBoundsToWorkArea({ x: -900, y: 180, width: 360, height: 500 }, leftDisplay),
  { x: -900, y: 180, width: 360, height: 500 },
  '已完整显示的窗口位置不应改变',
);

console.log('window bounds tests passed');
