const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

assert.match(html, /id="settings-video-download-enabled"/, '设置页应提供视频下载开关');
assert.match(renderer, /actions\.append\(openButton, downloadButton\)/, '打开目录按钮必须位于下载按钮左侧');
assert.match(renderer, /downloadButton\.textContent = downloading \? '下载中…' : completed \? '再次下载' : failed \? '重新下载' : '确认下载'/);
assert.match(renderer, /openButton\.disabled = !completed/, '仅下载完成后启用打开目录');
assert.match(css, /\.video-download-progress\s*\{[\s\S]*?background:\s*#e9e9f0/, '未开始进度条应为灰色');
assert.match(css, /\.video-download-progress\.is-indeterminate[\s\S]*?animation:/, '未知大小下载应显示进行中动画');

assert.match(preload, /startVideoDownload:[\s\S]*?video-download-start/);
assert.match(preload, /onVideoDownloadProgress:[\s\S]*?video-download:progress/);
assert.match(main, /new Notification\(\{[\s\S]*?title: success \? '视频下载完成' : '视频下载失败'/, '完成和失败都应创建系统通知');
assert.match(main, /success && filePath[\s\S]*?shell\.showItemInFolder\(filePath\)/, '成功通知点击后应定位文件');
assert.match(main, /win\.webContents\.send\('video-download:focus'\)/, '失败通知点击后应定位下载卡片');
assert.match(main, /\.part/);
assert.match(main, /VIDEO_DOWNLOAD_URL_MAX_LENGTH/);
assert.match(main, /\['http:', 'https:'\]/);
assert.match(main, /videoDownloadDirHistory[\s\S]*?slice\(0, 5\)/, '下载目录历史最多保留 5 条');
assert.match(main, /activeVideoDownload\?\.status === 'downloading'/, '同一时间只允许一个视频下载');

console.log('视频下载卡片契约通过');
