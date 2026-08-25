const fs = require('fs');
const path = require('path');
let tempSequence = 0;

// 同目录临时文件写完并刷盘后再替换目标文件，避免进程异常退出留下半截内容。
function atomicWriteFileSync(filePath, data, encoding) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${tempSequence++}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, data, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore cleanup error */ }
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* ignore cleanup error */ }
    throw error;
  }
}

module.exports = { atomicWriteFileSync };
