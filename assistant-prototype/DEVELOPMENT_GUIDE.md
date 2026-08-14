# 小智桌面助手：项目框架与开发规范

> 文档状态：初版基线  
> 目标平台：Windows 10/11  
> 原型形态：独立 Electron 应用  
> 最终宿主：便利贴（Sticky Notes）  
> 基线方案：Porcupine + whisper.cpp `base` 多语言模型 + DeepSeek + Windows TTS

## 1. 文档目的

本文档是“小智”语音助手原型的开发基线。开始编码前应先遵守这里定义的模块边界、状态机、接口契约、安全规则和测试要求。

原型必须先在独立目录中完成并验证，不直接修改便利贴现有业务代码。接入便利贴时，只新增启动入口、状态入口和宿主适配器，不把语音、对话或执行逻辑复制进便利贴的 `main.js`。

如果后续实现需要改变本文档中的关键约束，应先修改文档并说明原因，再修改代码。

## 2. 产品目标与首版边界

### 2.1 目标体验

用户通过“你好小智”唤醒助手，口语化描述任务。助手能够：

1. 将中文语音转换为文字；
2. 理解长句、多个动作和上下文；
3. 在任务信息不完整或有歧义时持续追问；
4. 在执行前复述最终计划并等待用户明确确认；
5. 确认后进行受控操作，同时用语音反馈状态；
6. 完成后根据真实执行结果汇报；
7. 在聆听、思考、询问、播报和执行阶段随时停止。

### 2.2 首版支持的动作

- 创建任务；
- 修改任务；
- 完成任务；
- 创建或修改提醒；
- 创建笔记；
- 向已有笔记追加内容；
- 搜索笔记；
- 整理当天任务；
- 生成日报；
- 打开便利贴内指定页面。

### 2.3 首版不做

- 不执行模型生成的 Shell、PowerShell 或任意代码；
- 不允许模型直接读写任意文件；
- 不控制便利贴之外的桌面应用；
- 不发送邮件、聊天消息、付款或提交表单；
- 不做完全开放式的自主代理循环；
- 不承诺离线大模型推理；语音识别本地运行，任务理解使用 DeepSeek API；
- 不在第一阶段修改便利贴的数据文件。

## 3. 不可违反的设计原则

### 3.1 原型与便利贴隔离

- `assistant-prototype/` 拥有独立的 `package.json`、锁文件、源码、测试和沙盒数据；
- 原型不得通过相对路径导入便利贴的 `main.js`、`preload.js` 或 `renderer/renderer.js`；
- 原型阶段只使用 `MockHostAdapter` 操作沙盒数据；
- 对便利贴的所有操作最终都通过 `HostAdapter` 接口完成。

### 3.2 先澄清、再确认、后执行

- 大模型只能生成“对话决策”和“候选计划”，不能直接产生副作用；
- 任务信息缺失、含糊或存在未经确认的假设时，必须继续提问；
- 计划通过程序校验且用户明确确认后，执行器才可接收计划；
- 计划内容发生任何改变后，原确认立即失效，必须重新确认。

### 3.3 中断优先于所有业务逻辑

- 停止指令不依赖大模型理解；
- 语音停止、界面停止按钮和 `Esc` 必须汇合到同一个 `CancellationController`；
- 每次网络调用、子进程调用、TTS 播放和动作执行都必须支持取消或明确声明不可取消；
- 取消后必须汇报真实状态，不得把已完成操作说成已撤销。

### 3.4 单一麦克风所有者

- 只有 `AudioManager` 可以申请和持有麦克风；
- 唤醒检测、VAD、录音和紧急指令检测共享同一条 PCM 音频流；
- 禁止不同模块分别调用 `getUserMedia()` 抢占设备；
- 音频模块通过事件分发音频帧，不暴露原始设备控制权。

### 3.5 模型不等于权限

- LLM 说“已完成”不代表操作成功；
- 执行结果只能来自 `HostAdapter` 的结构化返回值；
- 动作名称和参数必须经过白名单及 Schema 校验；
- 未注册动作一律拒绝，禁止“尽量执行”。

## 4. 总体架构

```text
麦克风
  └─ AudioManager（唯一所有者）
       ├─ WakeWordProvider（你好小智）
       ├─ EmergencyCommandDetector（小智停止）
       └─ Recorder + VAD
             └─ AsrProvider（whisper.cpp）
                   └─ AssistantOrchestrator
                         ├─ DialogueSession
                         ├─ Planner（DeepSeek）
                         ├─ PlanValidator
                         ├─ ConfirmationGate
                         ├─ Executor
                         │    └─ HostAdapter
                         ├─ TtsProvider
                         ├─ CancellationController
                         └─ ExecutionJournal
```

`AssistantOrchestrator` 是唯一允许推进对话状态的模块。音频、LLM、TTS 和执行器只能返回事件或结果，不能自行切换全局状态。

## 5. 推荐目录结构

```text
assistant-prototype/
├─ DEVELOPMENT_GUIDE.md
├─ README.md
├─ package.json
├─ package-lock.json
├─ .env.example
├─ src/
│  ├─ main/
│  │  ├─ index.js                 # Electron 主进程入口
│  │  ├─ create-window.js
│  │  └─ ipc-handlers.js
│  ├─ preload/
│  │  └─ index.js                 # 最小权限 IPC 桥
│  ├─ renderer/
│  │  ├─ index.html
│  │  ├─ app.js
│  │  └─ styles.css
│  ├─ assistant/
│  │  ├─ orchestrator.js          # 状态机与总流程
│  │  ├─ states.js
│  │  ├─ events.js
│  │  ├─ dialogue-session.js
│  │  └─ cancellation-controller.js
│  ├─ audio/
│  │  ├─ audio-manager.js
│  │  ├─ recorder.js
│  │  ├─ vad.js
│  │  ├─ wake-word-provider.js
│  │  └─ emergency-command-detector.js
│  ├─ asr/
│  │  ├─ asr-provider.js
│  │  └─ whisper-cpp-provider.js
│  ├─ llm/
│  │  ├─ planner.js
│  │  ├─ prompts.js
│  │  ├─ response-parser.js
│  │  └─ deepseek-client.js
│  ├─ planning/
│  │  ├─ plan-schema.js
│  │  ├─ plan-validator.js
│  │  ├─ confirmation-gate.js
│  │  └─ risk-policy.js
│  ├─ execution/
│  │  ├─ executor.js
│  │  ├─ action-registry.js
│  │  ├─ execution-journal.js
│  │  └─ actions/
│  │     ├─ create-task.js
│  │     ├─ set-reminder.js
│  │     └─ create-note.js
│  ├─ host/
│  │  ├─ host-adapter.js
│  │  ├─ mock-host-adapter.js
│  │  └─ sticky-notes-adapter.js  # 接入阶段再实现
│  ├─ tts/
│  │  ├─ tts-provider.js
│  │  └─ windows-tts-provider.js
│  ├─ storage/
│  │  ├─ config-store.js
│  │  ├─ session-store.js
│  │  └─ sandbox-store.js
│  └─ shared/
│     ├─ errors.js
│     ├─ logger.js
│     ├─ result.js
│     ├─ ids.js
│     └─ time.js
├─ test/
│  ├─ unit/
│  ├─ integration/
│  ├─ fixtures/
│  └─ scenarios/
├─ runtime/                       # 本地二进制，不提交仓库
├─ models/                        # 开发模型，不提交仓库
└─ sandbox-data/                  # 原型数据，不提交仓库
```

一个文件原则上只负责一个主要概念。若文件超过约 300 行，先检查是否混入了多个职责，不以机械拆分行数为目标。

## 6. 运行与部署边界

### 6.1 原型阶段

原型是独立 Electron 应用，拥有自己的调试窗口。窗口至少展示：

- 当前状态；
- 最近一次识别文本；
- 对话历史；
- 当前任务草案；
- 缺失字段和待确认假设；
- 最终执行计划；
- 每一步执行状态；
- 暂停、继续、停止按钮。

所有任务操作写入 `sandbox-data/`，不得读取或修改便利贴的真实数据目录。

### 6.2 接入便利贴阶段

助手作为便利贴启动的独立辅助进程运行。双方使用 Electron utility process、Node child process IPC 或 JSON Lines 通信，不开放本机 HTTP 端口。

通信消息必须包含：

```json
{
  "version": 1,
  "id": "msg_...",
  "type": "action.request",
  "timestamp": "2026-08-12T10:00:00.000Z",
  "payload": {}
}
```

便利贴退出时，应先请求助手优雅停止；超时后再终止辅助进程。助手崩溃不得导致便利贴崩溃。

## 7. 对话状态机

### 7.1 状态定义

| 状态 | 含义 | 允许的主要输入 |
|---|---|---|
| `IDLE` | 等待唤醒 | 唤醒词、手动启动 |
| `LISTENING` | 正在接收用户语音 | 音频、停止、超时 |
| `TRANSCRIBING` | 正在语音识别 | 停止、识别结果 |
| `REASONING` | 正在理解和规划 | 停止、LLM 结果 |
| `CLARIFYING` | 已提出问题，等待补充 | 用户回答、停止、超时 |
| `AWAITING_CONFIRMATION` | 等待确认最终计划 | 确认、修改、取消 |
| `EXECUTING` | 正在执行计划 | 停止、暂停、动作结果 |
| `PAUSED` | 保留进度等待继续 | 继续、取消 |
| `REPORTING` | 正在播报执行结果 | 停止、播报完成 |
| `FOLLOW_UP` | 短时间等待连续对话 | 新语音、超时、停止 |
| `CANCELLING` | 正在收敛和清理 | 各模块取消结果 |
| `ERROR` | 可恢复错误 | 重试、取消、回到待机 |

### 7.2 状态机规则

- 所有状态变化通过 `orchestrator.dispatch(event)`；
- 非法状态迁移应记录并拒绝，不可静默跳转；
- 每轮任务拥有唯一 `sessionId`，每份计划拥有唯一 `planId` 和递增 `revision`；
- 用户确认必须绑定 `planId + revision`；
- 澄清期间不产生任何真实副作用；
- `STOP_REQUESTED` 可从所有非 `IDLE` 状态进入 `CANCELLING`；
- `CANCELLING` 完成后，根据实际结果进入 `REPORTING` 或 `IDLE`；
- `FOLLOW_UP` 默认保持 15 秒，可配置，超时回到 `IDLE`。

## 8. 音频、唤醒和识别规范

### 8.1 音频格式

- 内部标准格式：16 kHz、单声道、16-bit PCM；
- 浏览器采集时启用回声消除、噪声抑制和自动增益；
- 进入识别前转换为规范 WAV；
- 不在日志或错误报告中记录原始音频内容。

### 8.2 唤醒词

- 默认唤醒词：“你好小智”；
- 待机阶段只运行低功耗唤醒检测，不持续运行 Whisper；
- 检测成功后保留唤醒前约 500～1000 ms 环形缓冲，防止正文开头被截断；
- 唤醒灵敏度必须可配置；
- 开发期必须记录误唤醒次数和漏唤醒样本，但样本保存需用户主动开启。

Porcupine 需要 AccessKey。密钥只能保存在环境变量或加密配置中，禁止提交仓库。正式分发前必须复核 SDK、中文模型和自定义关键词的授权条件。

### 8.3 结束说话检测

- 唤醒后最多等待 5 秒开始说话；
- 检测到说话后，连续静音 1.2～1.5 秒结束本轮；
- 单轮录音最长 60 秒，超限后提示用户分段；
- 追问后的用户回答不要求再次说唤醒词；
- VAD 参数集中配置，不得散落在界面和业务代码中。

### 8.4 whisper.cpp

- 使用多语言 `base` 模型，禁止误用 `base.en`；
- 明确指定中文和转写任务；
- `whisper-cli.exe` 放在 `runtime/whisper/`，模型放在应用数据目录；
- 首次下载模型必须校验固定 SHA-256；
- 子进程启动、退出、超时、标准错误和取消必须统一封装；
- 临时 WAV 使用操作系统临时目录，识别完成后清理；
- 不把模型打入 `app.asar`；正式安装时应按需下载模型，降低安装包体积。

## 9. LLM 输出契约

LLM 每轮只能返回以下决策之一：

- `clarify`：需要继续提问；
- `confirm`：信息完整，请用户确认计划；
- `answer`：纯问答，无需执行动作；
- `reject`：请求不支持或不安全。

示例：

```json
{
  "decision": "clarify",
  "speech": "请问明天下午几点提醒？",
  "draft": {
    "goal": "提醒发送合同",
    "actions": [
      {
        "type": "set_reminder",
        "args": {
          "title": "把合同发给王总",
          "time": null
        }
      }
    ]
  },
  "missingFields": ["actions[0].args.time"],
  "assumptions": []
}
```

解析规则：

- 只接受 JSON 对象，不从 Markdown 或自然语言中猜测动作；
- JSON 解析失败最多进行一次“格式修复”请求，仍失败则进入可恢复错误；
- `speech` 仅用于播报，不作为执行依据；
- 对日期、时间、对象和动作参数做本地二次验证；
- LLM 不得自行设置 `confirmed: true`；确认状态只能由本地 `ConfirmationGate` 产生；
- 对话历史设置上限，较早内容压缩为摘要，但当前草案和用户原始确认不得只保留摘要。

## 10. 计划完整性与确认规则

计划只有同时满足以下条件才能进入确认阶段：

1. `missingFields` 为空；
2. `assumptions` 为空；
3. 每个动作已在 `ActionRegistry` 注册；
4. 所有参数通过对应 Schema；
5. 相对时间已转换为 Asia/Shanghai 时区的绝对时间；
6. 操作对象唯一；
7. 动作数量、文本长度和数据规模未超过限制；
8. 风险策略允许该动作进入确认阶段。

用户确认语义至少支持“确认、可以、执行、开始”。以下表达不能当作确认：“嗯”“随便”“应该吧”“你看着办”。无法确定时继续询问。

修改、补充、否定或重新规划都会生成新的 `revision`。旧版本确认不得复用。

## 11. 动作注册与宿主适配器

### 11.1 动作定义

每个动作模块必须声明：

```js
{
  type: 'create_task',
  risk: 'low',
  schema: {},
  cancellable: true,
  idempotent: true,
  execute: async ({ args, host, signal, context }) => {},
  compensate: async ({ result, host, signal, context }) => {}
}
```

- `execute` 只能调用 `HostAdapter`，不能直接访问便利贴存储；
- `compensate` 是补偿操作，不保证等同于数据库事务回滚；
- 无法撤销的动作必须明确标记；
- 每次执行使用 `actionRunId`，宿主侧可据此避免重复创建。

### 11.2 HostAdapter 契约

```js
class HostAdapter {
  async getCapabilities({ signal }) {}
  async createTask(args, { signal, actionRunId }) {}
  async updateTask(args, { signal, actionRunId }) {}
  async completeTask(args, { signal, actionRunId }) {}
  async setReminder(args, { signal, actionRunId }) {}
  async createNote(args, { signal, actionRunId }) {}
  async appendNote(args, { signal, actionRunId }) {}
  async searchNotes(args, { signal }) {}
  async organizeTodayTasks(args, { signal, actionRunId }) {}
  async generateDailyReport(args, { signal, actionRunId }) {}
  async openPage(args, { signal }) {}
}
```

返回结果使用统一结构：

```json
{
  "ok": true,
  "data": {},
  "effect": {
    "summary": "已创建任务：发送合同",
    "reversible": true
  }
}
```

业务失败不使用模糊的 `null` 或 `false`，应返回稳定错误码，例如 `TASK_NOT_FOUND`、`AMBIGUOUS_TARGET`、`CONFLICT`。

## 12. 执行、暂停和停止

### 12.1 执行规则

- 默认按计划顺序串行执行；
- 只有明确声明互不依赖的只读动作才允许并行；
- 每个动作开始前检查 `AbortSignal`；
- 每个动作结束后立即写执行日志；
- 单步失败后默认停止后续步骤并汇报，不自动猜测替代动作；
- 需要重试的动作必须显式配置最大次数和退避策略；
- 非幂等动作不得自动重试。

### 12.2 停止

停止来源包括：

- “小智停止”“停止”“取消”；
- 调试窗口停止按钮；
- `Esc`；
- 便利贴接入后的停止入口；
- 应用退出或进程异常。

收到停止后依次：

1. 设置全局取消信号；
2. 立即停止 TTS；
3. 中止 DeepSeek 请求；
4. 终止 Whisper 子进程；
5. 阻止任何新动作开始；
6. 请求当前动作停止；
7. 写入执行日志；
8. 汇总“已完成、进行中断、未执行、无法撤销”的步骤；
9. 向用户播报真实结果。

停止不等于撤销。撤销必须是独立意图，并只针对标记为可补偿的操作。

### 12.3 暂停与继续

- 暂停只在动作边界生效；
- 已经进入不可暂停的动作时，先完成或取消该动作，再进入 `PAUSED`；
- 继续前重新确认宿主能力和目标对象仍然有效；
- 应用重启后不自动继续未完成计划，必须由用户确认恢复。

## 13. TTS 与“边说边做”

- TTS 内容和执行计划由协调器同时发起，但执行结果不得提前播报；
- 开始执行时可以说“好的，我现在开始处理”；
- 长任务只播报关键进度，避免逐步打扰；
- 最终汇报由 `ExecutionJournal` 的真实结果生成；
- 播报期间仍保留紧急停止检测；
- 为避免助手听到自己，应启用回声消除，并将普通唤醒检测暂时降敏或暂停；
- TTS 必须支持立即停止，不使用不可控的长音频队列；
- 首版优先使用 Windows 中文语音，未找到中文音色时在界面给出明确提示。

## 14. 配置与数据位置

开发阶段建议：

```text
assistant-prototype/.env                    # 本机开发密钥，不提交
assistant-prototype/models/                 # 本机模型，不提交
assistant-prototype/runtime/                # 本机二进制，不提交
assistant-prototype/sandbox-data/           # 沙盒任务数据，不提交
```

正式运行阶段建议：

```text
%APPDATA%/sticky-notes-assistant/config.enc
%APPDATA%/sticky-notes-assistant/models/
%APPDATA%/sticky-notes-assistant/sessions/
%APPDATA%/sticky-notes-assistant/journal/
%TEMP%/sticky-notes-assistant/
```

- API Key 使用 Electron `safeStorage` 加密；
- `.env.example` 只能包含变量名和示例说明，不包含真实值；
- 配置读取集中在 `config-store.js`，业务模块不得直接读取 `process.env`；
- 模型版本、SHA-256、下载地址和最低运行时版本集中维护；
- 临时音频默认及时删除；用户主动开启诊断采样时必须明确告知保存位置。

## 15. JavaScript 代码风格

为与当前便利贴保持一致，首版采用 CommonJS 和原生 JavaScript，不在原型中引入 TypeScript 编译链。

### 15.1 格式

- UTF-8 编码；
- 2 空格缩进；
- 使用分号；
- 字符串默认单引号；模板内容使用反引号；
- 行宽建议不超过 100～120 个字符；
- 对象和数组尾逗号遵循现有文件风格，同一文件保持一致；
- 禁止无意义缩写，`cfg` 等仓库既有缩写不扩散到新模块；
- 公共常量使用 `UPPER_SNAKE_CASE`，类使用 `PascalCase`，函数和变量使用 `camelCase`；
- 文件名使用 `kebab-case.js`；
- 布尔值命名使用 `is`、`has`、`can`、`should` 前缀。

### 15.2 模块与函数

- 一个模块暴露少量稳定接口，内部实现默认不导出；
- 优先依赖注入，禁止模块顶层创建麦克风、子进程或网络连接；
- 避免全局可变状态；会话状态归 `DialogueSession`，执行状态归 `Executor`；
- 异步函数必须明确处理超时和取消；
- 不使用空的 `catch`；忽略错误时必须记录原因；
- 不在业务代码中直接比较用户可见中文字符串来驱动状态；使用稳定枚举和错误码；
- 边界处校验输入，内部函数依赖已验证的数据；
- 对公共接口和复杂数据结构使用 JSDoc；
- 时间统一使用 ISO 8601 存储，展示时再转换时区。

### 15.3 推荐返回方式

业务层优先返回显式结果：

```js
return {
  ok: false,
  error: {
    code: 'AMBIGUOUS_TARGET',
    message: '存在多个同名任务',
    details: { candidates },
  },
};
```

编程错误、非法状态和不可恢复基础设施错误可以抛出类型化异常。禁止依赖错误文本做分支判断。

## 16. 日志与可观测性

日志必须是结构化事件，至少包含：

```text
timestamp, level, event, sessionId, planId, actionRunId, state, durationMs
```

规则：

- 不记录 API Key、Authorization Header 和完整系统提示词；
- 默认不记录原始音频；
- 用户语音文本和笔记内容在日志中默认截断或脱敏；
- 状态迁移、LLM 延迟、ASR 延迟、动作开始/结束、取消来源必须记录；
- 用户可见错误使用简洁中文，开发日志保留稳定错误码和技术细节；
- 日志按大小轮转，避免长期运行无限增长。

建议统计：唤醒成功率、误唤醒次数、ASR 耗时、澄清轮数、计划校验失败率、动作成功率、停止响应时间。

## 17. 安全与隐私

- Electron 窗口启用 `contextIsolation: true`、`sandbox: true`，禁用 `nodeIntegration`；
- preload 只暴露具体方法，禁止暴露原始 `ipcRenderer`；
- 所有 IPC 请求校验发送方、类型、长度和 Schema；
- 不允许 renderer 提供任意文件路径或可执行文件路径；
- 模型下载只允许固定 HTTPS 来源，并校验哈希；
- LLM 输出永远视为不可信输入；
- 动作参数禁止目录穿越、协议注入和超长内容；
- 删除、覆盖、外发等高风险能力即使以后实现，也必须二次确认；
- 助手界面必须明确显示麦克风是否处于待机监听或正式录音状态；
- 提供一键关闭唤醒、关闭麦克风和清理会话记录的入口。

## 18. 测试策略

使用 Node 内置 `node:test` 和 `assert` 作为首选，避免为了基础测试引入大型框架。音频、LLM、TTS、时间和宿主适配器均通过依赖注入替换为测试替身。

### 18.1 单元测试

- 状态机合法与非法迁移；
- 日期和相对时间解析；
- LLM JSON 解析及 Schema 校验；
- 计划 revision 与确认失效；
- 风险策略；
- 动作注册和参数限制；
- 取消、暂停和继续；
- 日志脱敏。

### 18.2 集成测试

- 音频文件 → Whisper → 中文文本；
- 多轮澄清 → 最终计划 → 确认；
- 执行计划 → MockHostAdapter → 执行日志；
- TTS 播报时触发停止；
- DeepSeek 请求超时或取消；
- Whisper 子进程退出、卡死或模型缺失；
- 应用重启后发现未完成执行日志。

### 18.3 场景测试

至少覆盖：

1. “明天下午提醒我发合同”——追问具体时间和对象；
2. 用户回答后又修改时间——旧确认失效；
3. 一句话包含多个动作——生成有序计划；
4. 思考时说“停止”——网络请求立即取消；
5. 执行第二步时停止——准确汇报第一步已完成；
6. TTS 播报时说“小智停止”——立即静音；
7. 用户长时间不回答——安全超时回到待机；
8. LLM 返回未知动作——拒绝执行；
9. 模型返回“已完成”但适配器失败——必须汇报失败；
10. 重复收到相同动作请求——不得重复创建任务。

### 18.4 验收指标

- 停止按钮到执行器收到取消信号：目标小于 100 ms；
- 语音停止到停止 TTS：在目标设备上尽量小于 500 ms；
- 未经确认的写操作数量必须为 0；
- 未注册动作执行数量必须为 0；
- 中断后执行的新步骤数量必须为 0；
- 所有已执行步骤都有日志和真实结果；
- 原型测试期间便利贴真实数据零修改。

## 19. 开发阶段划分

### 阶段 0：骨架与契约

- 建立独立 package、目录和配置；
- 实现状态枚举、事件、错误码、结果类型；
- 实现 `HostAdapter`、`MockHostAdapter` 和执行日志；
- 建立单元测试与基础 CI 命令。

### 阶段 1：文字版闭环

- 调试窗口输入文字；
- DeepSeek 理解、追问和计划生成；
- 本地计划校验；
- 用户确认；
- 沙盒执行；
- 暂停、继续和停止。

文字闭环未稳定前，不接唤醒词。

### 阶段 2：按键语音

- 麦克风和统一音频管线；
- VAD 与 WAV 输出；
- whisper.cpp `base`；
- Windows TTS；
- 验证 TTS 与执行并行、中途打断。

### 阶段 3：语音唤醒与连续对话

- “你好小智”唤醒；
- 环形音频缓冲；
- 追问后自动继续聆听；
- 15 秒连续对话窗口；
- “小智停止”紧急指令；
- 误唤醒和回声测试。

### 阶段 4：稳定性

- 长时间待机；
- 模型缺失和自动下载；
- 网络断开、超时和重试；
- 进程崩溃恢复；
- 日志轮转；
- CPU、内存和句柄泄漏检查。

### 阶段 5：接入便利贴

- 冻结 HostAdapter 契约；
- 实现 `StickyNotesAdapter`；
- 便利贴主进程启动和管理助手辅助进程；
- 增加小智入口、状态指示和停止按钮；
- 使用真实便利贴动作做受控集成测试；
- 保留禁用助手后一切原功能不受影响的回退路径。

## 20. 每次提交前检查清单

- [ ] 是否仍然保持原型与便利贴隔离？
- [ ] 是否新增了绕过 `HostAdapter` 的数据操作？
- [ ] 是否新增了绕过确认门的副作用？
- [ ] 新异步任务是否支持超时和取消？
- [ ] 停止后是否可能继续启动下一动作？
- [ ] LLM 返回值是否经过 Schema 校验？
- [ ] 错误是否有稳定错误码？
- [ ] 日志是否可能泄漏密钥、原始音频或完整隐私内容？
- [ ] 是否为新状态迁移和动作补充测试？
- [ ] 是否验证了失败、中断和重复请求，而不仅是成功路径？
- [ ] 是否更新了接口文档和配置示例？
- [ ] 是否避免修改与当前任务无关的便利贴文件？

## 21. 已知风险与预留替换点

| 风险 | 当前处理 | 替换点 |
|---|---|---|
| whisper.cpp `base` 中文长句准确率有限 | 首版优先验证交互闭环 | `AsrProvider` 可替换 Fun-ASR-Nano |
| Porcupine 需要密钥及授权复核 | 原型期使用开发密钥 | `WakeWordProvider` 可替换 sherpa-onnx KWS |
| 系统 TTS 音色不够自然 | 首版使用 Windows 中文音色 | `TtsProvider` 可替换 CosyVoice 等 |
| TTS 声音引发自唤醒 | 回声消除、降敏、紧急词独立检测 | 后续支持声纹/回声参考信号 |
| LLM 产生不可靠计划 | Schema、白名单、完整性校验和确认门 | 可替换任意兼容 Planner |
| 辅助进程异常退出 | 便利贴与助手进程隔离、执行日志恢复 | 后续增加监督与健康检查 |

## 22. 完成定义

只有满足以下条件，独立原型才可以进入便利贴接入阶段：

- 能完成“唤醒 → 聆听 → 识别 → 澄清 → 确认 → 执行 → 汇报”完整闭环；
- 澄清可以进行多轮，且计划修改后会重新确认；
- 所有执行动作来自白名单且通过 Schema；
- 在思考、TTS 和执行阶段均能停止；
- 中断汇报能准确区分已完成和未执行步骤；
- 连续待机和多轮测试无明显内存、进程或麦克风泄漏；
- 原型对便利贴现有代码和真实数据保持零依赖、零修改；
- 单元测试、集成测试和核心场景测试全部通过；
- Porcupine、whisper.cpp、模型文件及分发方式的许可证已经复核。
