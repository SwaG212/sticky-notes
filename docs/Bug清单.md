# 便利贴 Bug 清单

> 日期：2026-06-13
> 当前状态：1 项已修复，0 项待修复

---

## BUG-001：图片缩略图删除按钮索引错位（已修复）

| 属性 | 内容 |
|------|------|
| Bug ID | BUG-001 |
| 发现日期 | 2026-06-13 |
| 优先级 | 🟡 Critical |
| 严重程度 | 一般 |
| 所属模块 | INPUT（输入捕获） |
| 关联测试用例 | INPUT-06 |
| 复现概率 | 必然复现（粘贴 2 张以上图片后删除非最后一张） |
| 环境 | Electron 33 / Windows 11 |

**复现步骤**：
1. 打开便利贴窗口
2. 依次粘贴 3 张截图
3. 点击第 1 张或第 2 张缩略图的 ✕ 删除按钮
4. 观察：可能删除错误的图片，或删除无反应（索引越界）

**预期结果**：点击哪张的 ✕，删除哪张，其余图片位置不变

**实际结果**：删除按钮的闭包中保存了渲染时的数组索引，删除操作导致数组重排后索引错位

**根因**：
```javascript
// 原代码（有 Bug）
state.images.forEach((url, i) => {
  btn.addEventListener('click', () => {
    state.images.splice(i, 1);  // i 在 forEach 闭包中固定，删除后不再对应正确位置
  });
});
```

**修复方案**：
```javascript
// 修复后：用 dataUrl 内容查找实际索引
btn.addEventListener('click', () => {
  const idx = state.images.indexOf(url);
  if (idx !== -1) { state.images.splice(idx, 1); ... }
});
```

**修复状态**：✅ 已修复（2026-06-13）
**修复文件**：`renderer/renderer.js:renderImages()`

---

## Bug 统计

| 优先级 | 数量 | 已修复 | 待修复 | WontFix |
|--------|------|--------|--------|---------|
| 🔴 Blocker | 0 | 0 | 0 | 0 |
| 🟡 Critical | 1 | 1 | 0 | 0 |
| ⚪ Minor | 0 | 0 | 0 | 0 |
| **合计** | **1** | **1** | **0** | **0** |
