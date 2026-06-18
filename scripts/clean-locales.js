const fs = require('fs');
const path = require('path');
const KEEP = new Set(['zh-CN.pak', 'en-US.pak']);

exports.default = async function(context) {
  const localesDir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(localesDir)) return;
  for (const f of fs.readdirSync(localesDir)) {
    if (!KEEP.has(f)) fs.unlinkSync(path.join(localesDir, f));
  }
  // 删除 LICENSES.chromium.html（个人/内部分发可接受）
  const licensePath = path.join(context.appOutDir, 'LICENSES.chromium.html');
  if (fs.existsSync(licensePath)) fs.unlinkSync(licensePath);
};
