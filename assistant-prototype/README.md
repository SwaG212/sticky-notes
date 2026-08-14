# 小智桌面助手原型（assistant-prototype）

语音助手"小智"的独立原型，最终宿主为便利贴（Sticky Notes）。当前完成 **阶段 0（骨架与契约）+ 阶段 1（文字版闭环）**，开发基线见 [DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)。

## 当前能力（阶段 1）

- 调试窗口文字输入 → DeepSeek 理解 → 追问 / 候选计划
- 本地计划校验（动作白名单 + Schema + 8 项完整性检查）
- 用户确认（绑定 planId + revision，修改后旧确认失效）
- 沙盒执行（MockHostAdapter 操作 `sandbox-data/`，零接触便利贴真实数据）
- 暂停 / 继续 / 停止（停止统一汇合 `CancellationController`，汇报真实执行结果）
- 结构化执行日志（`sandbox-data/journal/`），重启可恢复未完成计划

## 安装与运行

```bash
npm install
copy .env.example .env    # 填入 DEEPSEEK_API_KEY
npm start                 # 启动调试窗口
```

## 测试

```bash
npm test                  # 单元 + 集成 + 场景，共 134 条
npm run test:unit
npm run test:integration
npm run test:scenarios
```

测试覆盖：状态机合法/非法迁移、相对时间解析（Asia/Shanghai）、LLM 输出解析、确认失效、风险策略、动作白名单、取消/暂停/继续、日志脱敏、沙盒宿主，以及 DEVELOPMENT_GUIDE 18.3 的全部 10 个场景。

## 目录

```
src/
├─ assistant/   状态机、编排器、会话、取消控制器
├─ llm/         DeepSeek 客户端、提示词、输出解析、规划器
├─ planning/    Schema、计划校验、确认门、风险策略
├─ execution/   执行器、动作注册表、执行日志、10 个白名单动作
├─ host/        HostAdapter 契约 + MockHostAdapter（阶段 5 接入便利贴）
├─ storage/     配置、会话、沙盒数据
├─ main|preload|renderer/  调试窗口
test/
├─ unit/  integration/  scenarios/  fixtures/  helpers/
sandbox-data/  原型沙盒数据（不提交）
```

## 阶段进度

- [x] 阶段 0：骨架与契约（HostAdapter、MockHostAdapter、执行日志、单元测试）
- [x] 阶段 1：文字版闭环（DeepSeek 规划、校验、确认、沙盒执行、暂停/继续/停止）
- [ ] 阶段 2：按键语音（麦克风、VAD、whisper.cpp、Windows TTS）
- [ ] 阶段 3：语音唤醒与连续对话（"你好小智"）
- [ ] 阶段 4：稳定性（模型下载、网络容错、日志轮转、泄漏检查）
- [ ] 阶段 5：接入便利贴（StickyNotesAdapter、辅助进程）

> 文档 3.1：原型不得通过相对路径导入便利贴代码；阶段 1 只允许 MockHostAdapter 操作沙盒数据。
