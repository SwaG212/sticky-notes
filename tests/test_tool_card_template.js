const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');

assert.match(html, /<template id="tool-card-template">[\s\S]*?<section class="tool-card">[\s\S]*?<div class="tool-card-body"><\/div>/);
assert.match(renderer, /toolCardTemplate\.content\.firstElementChild\.cloneNode\(true\)/);
assert.match(renderer, /renderTranslateCard\(\)[\s\S]*?createToolCard\('translate'\)/);
assert.match(renderer, /renderVideoDownloadCard\(\)[\s\S]*?createToolCard\('video-download', 'video-download-card'\)/);
assert.match(renderer, /renderHarnessCard\(\)[\s\S]*?createToolCard\('harness', 'harness-card'\)/);
assert.doesNotMatch(renderer, /card\.className\s*=\s*['"]tool-card/);

console.log('功能卡统一模板契约通过');
