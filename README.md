# Frontend Autopilot

[![CI](https://github.com/Aschenbath/Frontend-Autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Aschenbath/Frontend-Autopilot/actions/workflows/ci.yml)

**给它一份产品需求，它不只生成页面，还会自己把应用跑起来、点一遍、检查一遍；过不了就修，修不好就明确判定失败。**

Frontend Autopilot 是我做的本地 AI 前端交付工具。普通代码生成器通常在模型输出代码后就结束了，Frontend Autopilot 继续完成真正影响交付的工作：安装依赖、构建项目、启动浏览器、执行用户操作、检查桌面与手机布局，再决定这个结果到底能不能交付。

## 先看实际结果

下面的 SignalDesk 不是手写演示页，而是 Frontend Autopilot 根据一份文字需求生成的客服质检后台。最终结果通过了真实构建和浏览器验收。

| 运营总览 | 会话队列 | 质检详情 |
| --- | --- | --- |
| ![SignalDesk 运营总览](docs/screenshots/signaldesk-overview.png) | ![SignalDesk 会话队列](docs/screenshots/signaldesk-queue.png) | ![SignalDesk 质检详情](docs/screenshots/signaldesk-review.png) |

这次运行的结果很直接：

- 生成 3 个完整页面；
- 6 个用户操作全部通过，包括搜索、筛选、打开详情、分配负责人和完成复核；
- 28 项交付检查全部通过；
- loading、empty、error、success 四种状态都在桌面和手机尺寸下真实触发并验证；
- 第一版有按钮尺寸和文字对比度问题，工具根据失败证据自动修复一次，复验通过后才交付。

[用人话看完整案例](docs/signaldesk-case-study.md) · [查看机器生成的原始验收报告](docs/demo-reports/signaldesk.md)

## 它和普通 AI 生成页面有什么区别？

| 常见的 AI 页面生成 | Frontend Autopilot |
| --- | --- |
| 模型说“完成了”就结束 | 本地构建和浏览器结果说了算 |
| 生成的代码可以随意改配置、加依赖 | 脚手架固定，依赖和可写路径受限制 |
| 截一张首页图当作成功 | 真正点击按钮、搜索、切换页面并检查状态 |
| 出错后反复重试，容易越改越乱 | 修复次数有上限，每次修完都从头验收 |
| 失败结果往往不会展示 | 没过质量线就明确拒绝交付 |

一句话概括：**模型负责写，本地程序负责验。**

## 真正难的不是“让 AI 写 React”

### 1. 把模型输出当作不可信代码

模型不能修改 `package.json`、Vite 配置、lockfile 或 npm 配置，也不能随便安装包。它只能在受控目录里写少量源码；路径越界、文件过多或内容过长都会被直接拒绝。依赖安装还会关闭 lifecycle scripts，避免生成代码借安装过程执行额外脚本。

Builder 默认只写 4 个模型文件，必要时最多 6 个；提示目标控制在 18,000 字符以内。程序层仍保留 12 文件 / 24,000 字符的硬上限，因为真实网关不一定会遵守 token 限制。

### 2. 证明应用是真的能用

Frontend Autopilot 不让模型给自己打分。它会在本机执行：

```text
npm install -> npm run build -> 启动 Vite -> Playwright 打开浏览器
```

然后按需求里的场景实际操作页面。例如 SignalDesk 的验收不是“页面里出现了按钮”，而是：搜索指定会话、打开详情、修改负责人、完成复核，再返回列表确认状态确实保留。

同时还会检查手机端横向溢出、按钮点击尺寸、文字对比度、页面语义，以及 loading / empty / error / success 是否能通过指定操作真实出现。

### 3. 防止自动修复把已经正确的地方改坏

修复不是无限循环。每轮只接收明确的失败证据，轮数耗尽就停止。首次全部通过后，视觉润色也不会直接覆盖成品，而是在隔离副本中修改；只有重新通过构建、交互和 UI 检查，候选版本才会成为最终结果。

这比“让模型继续优化一下”麻烦得多，但也正是生成代码从 demo 走向可交付工具时必须补上的部分。

## 工作过程

```text
产品需求 / 参考图
        ↓
整理成页面、流程和验收条件
        ↓
在固定 React + Vite 项目中生成源码
        ↓
真实构建 + 浏览器操作 + 桌面/手机检查
        ↓
失败：限次修复并重新验收
通过：隔离润色并再次完整验收
        ↓
截图 + 检查结果 + 交付报告
```

## 本地工作台

除了命令行，项目还有一个只监听本机地址的 Product Studio。左侧填写产品目标、核心流程和参考图，右侧可以看生成进度、页面预览、手机/桌面视口和失败详情。

| 填写需求 | 查看生成与验收过程 |
| --- | --- |
| ![Product Studio 输入界面](docs/screenshots/product-studio-focus.png) | ![Product Studio 运行界面](docs/screenshots/console-desktop.png) |

浏览器中填写的 API Key 只保存在当前 Node.js 进程内，不写入项目文件、运行报告或公开接口。

## 失败也算结果

另一个带参考图的 Atlas Research 挑战没有通过最终视觉与 UI 检查，所以仓库没有把它包装成成功案例。这一点对项目很重要：Frontend Autopilot 的价值不是保证模型每次都能做出好产品，而是让“不够好”变成可发现、可解释、会被拒绝的结果。

目前项目只生成使用模拟数据的 React + Vite 前端，不包含真实后端、登录系统、多人协作或云端部署，也不宣称能代替人工审美判断。

## 快速运行

需要 Node.js 20+。

```bash
npm install
npx playwright install chromium
npm test
npm run console
```

连接任意 OpenAI-compatible 接口后，可以运行示例：

```powershell
$env:FRONTEND_AUTOPILOT_API_KEY = 'your-key'
$env:FRONTEND_AUTOPILOT_BASE_URL = 'https://your-endpoint.example/v1'
$env:FRONTEND_AUTOPILOT_MODEL = 'your-model-id'
npm run demo:signaldesk
```

完整的无 API 集成测试会真实执行 npm、Vite 和 Playwright：

```bash
FRONTEND_AUTOPILOT_E2E=1 npm test
```

## English summary

Frontend Autopilot turns a product brief and optional reference images into a small React + Vite application, then verifies the result with real local builds, Playwright interactions, responsive UI checks, and bounded repair. The model writes code; deterministic local evidence decides whether the result can ship.

The published SignalDesk run generated three pages, passed 6/6 browser scenarios and 28/28 delivery checks, verified four executable UI states on desktop and mobile, and recovered from one evidence-driven repair. Atlas is kept as an honest rejected attempt because it did not meet the visual and UI gates.

## 继续了解

- [SignalDesk 案例：从需求到通过验收](docs/signaldesk-case-study.md)
- [技术架构与安全边界](docs/architecture.md)
- [产品范围与非目标](FRAMEWORK.md)
- [早期演示归档](docs/demos/archive.md)
