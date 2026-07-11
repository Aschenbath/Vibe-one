# Vibe-one

[![CI](https://github.com/Aschenbath/Vibe-one/actions/workflows/ci.yml/badge.svg)](https://github.com/Aschenbath/Vibe-one/actions/workflows/ci.yml)

Vibe-one 是一条有明确边界的 AI 产品交付流水线：接收产品需求、参考截图或两者组合，生成结构化产品/视觉规格与可运行的 React 应用，再通过本地命令、Playwright 交互场景和确定性视觉检查完成验收，并保留有界修复的完整证据。

```text
需求 / 参考截图 -> 多模态规划 -> 生成应用 -> 构建与截图 -> 机械验收与视觉门禁 -> 有界修复 -> 交付报告
```

产品边界见 [`FRAMEWORK.md`](FRAMEWORK.md)，模块设计见 [`docs/architecture.md`](docs/architecture.md)。

## Product Lab 本地工作台

启动浏览器工作台：

```bash
npm run console
```

打开终端输出的本地回环地址。Product Lab 支持：

- 纯文字需求、纯截图输入，或文字与截图组合输入；
- PNG、JPEG、WebP，最多 4 张，单张不超过 6 MiB、总计不超过 18 MiB；
- 单次完整任务请求最大 26 MiB；
- 实时流水线事件、本地运行历史、参考图/结果图/视觉修复证据；
- 在内嵌预览中启动验收通过的生成应用。

![Vibe-one Product Lab 桌面工作台](docs/screenshots/console-desktop.png)

浏览器不会持久化 API Key。页面中填写的 Key 只保留在当前 Node.js 进程内；未设置会话覆盖时仍可使用环境变量。公开任务对象和持久化产物不会包含凭证、上传图片的 base64、私有 endpoint 或绝对路径。HTTP 控制面默认仅监听 loopback。

## 已验证演示

以下两个演示均通过真实 OpenAI-compatible API 使用 `gpt-5.6-sol` 生成，再由本地机械验收完成验证，不使用模型自我打分。

| 演示 | 结果 | 证据 |
| --- | --- | --- |
| 自由职业者记账应用 | 第 0 轮成功；3 个页面、4 个交互场景 | [交付报告](docs/demo-reports/expense-mobile.md) |
| 笔记应用 | 第 1 轮修复后成功；2 个页面、2 个交互场景 | [修复后交付报告](docs/demo-reports/notes-mobile-repaired.md) |

| 记账应用 | 笔记应用 |
| --- | --- |
| ![生成的记账应用首页](docs/screenshots/expense-home.png) | ![生成的笔记列表](docs/screenshots/notes-list.png) |
| ![生成的支出录入页](docs/screenshots/expense-add.png) | ![生成的笔记编辑页](docs/screenshots/notes-editor.png) |

笔记演示是完整的“失败后修复”案例：初始应用把规划中的占位编辑路由重定向回列表页，导致 3 项机械内容检查失败；fixer 随后修改 `src/App.jsx`，第二轮验证成功。

## 快速开始

```bash
npm install
npx playwright install chromium
```

CLI 直接读取当前进程的环境变量，不会把 Key 写入运行产物。浏览器工作台也支持在页面中填写仅本次会话有效的 Key。

PowerShell：

```powershell
$env:VIBE_ONE_API_KEY = 'your-key'
$env:VIBE_ONE_BASE_URL = 'https://your-openai-compatible-endpoint/v1'
$env:VIBE_ONE_MODEL = 'your-model-id'
```

POSIX Shell：

```bash
export VIBE_ONE_API_KEY='your-key'
export VIBE_ONE_BASE_URL='https://your-openai-compatible-endpoint/v1'
export VIBE_ONE_MODEL='your-model-id'
```

运行演示或只生成规划：

```bash
npm run demo:expense
npm run demo:notes
node src/cli/index.js plan examples/expense-mobile
```

可选网络参数：

```text
VIBE_ONE_MAX_RETRIES=6
VIBE_ONE_REQUEST_TIMEOUT_MS=120000
VIBE_ONE_STREAM_TIMEOUT_MS=600000
```

Chat Completions 默认使用流式响应，避免较长的 builder 输出被中间网关提前截断；普通 JSON 响应仍作为兼容回退。

## 测试

```bash
npm test
npm run test:console:e2e
VIBE_ONE_E2E=1 npm test
```

- `npm test`：默认离线测试套件；
- `npm run test:console:e2e`：使用 stub pipeline 在桌面与窄屏视口驱动浏览器工作台；
- `VIBE_ONE_E2E=1 npm test`：执行真实 npm install/build、Vite preview、Playwright 截图、交互场景、功能修复和视觉修复，不消耗 API 配额。

## 运行产物

每次真实运行写入 `runs/<target>-<timestamp>/`：

| 产物 | 含义 |
| --- | --- |
| `SPEC.generated.md` / `PLAN.generated.md` | 页面规划、内容检查和交互场景 |
| `references/manifest.json` | 脱敏后的参考图元数据；图片以文件保存，不保存 base64 |
| `app/` | 可运行的生成应用 |
| `logs/` | 命令输出与结构化 `events.jsonl` |
| `screenshots/` | 页面截图和交互后截图 |
| `visual/comparisons.json` | 各轮视觉总分、结构/颜色子分、阈值、映射和通过/失败证据 |
| `DELIVERY_REPORT.md` | 命令、检查项、修复轮次、用量与最终状态 |

## 模块结构

```text
src/cli/        CLI 入口与状态退出码
src/console/    本地 HTTP/SSE API、任务历史、预览生命周期与浏览器 UI
src/core/       配置、运行上下文、pipeline、planner、builder、reviewer、fixer
src/providers/  单一 OpenAI-compatible 流式 Chat provider
src/runner/     命令执行、预览服务器与 Playwright 验收
src/reporter/   DELIVERY_REPORT.md 生成
```

## 设计与安全规则

- Reviewer 是纯机械验收：退出码、截图字节、可见文本、页面 `mustContain` 片段和端到端交互场景。
- 存在参考图时，planner 必须为每张上传图片生成合法页面映射，否则任务在构建前失败，禁止静默忽略截图。
- 视觉评分完全在本地执行：SSIM 派生的结构分与 RGB 直方图颜色分，不使用模型自评。
- 默认视觉阈值为 `0.62`，表示粗粒度布局与色彩一致性，不承诺像素级复刻。
- 只有全部 reviewer 检查通过，任务才会标记为成功。
- 修复循环受 `maxRepairRounds` 限制，并记录每轮诊断、补丁文件、分数和不可变截图证据。
- 模型不能覆盖 `package.json`、Vite 配置、lockfile 或 npm 配置；依赖使用白名单，安装命令带 `--ignore-scripts`。
- 模型写入路径通过 `safeJoin` 限制在生成应用目录内。
- 源文件使用分隔符协议传输，避免把大段代码强制塞进 JSON 转义字符串。

## 当前状态与边界

- **Engine：** 已支持文字、截图及组合规划、功能修复、确定性视觉比较、有界视觉修复、交付报告和完整证据链。
- **Console：** 全中文 Product Lab 已支持参考图上传、模型配置、会话级凭证、实时事件、历史回放、参考图/结果图/视觉比较/报告/修复记录和生成应用预览。

当前阶段只生成响应式 React + Vite Web 产品。本地工作台暂不包含远程托管、身份认证、并发任务、持久化凭证和命令执行中的取消；视觉门禁也不承诺像素级克隆。
