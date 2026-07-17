# Frontend Autopilot 产品范围

这份文档只说明 Frontend Autopilot 做什么、不做什么。想快速了解项目，请先看 [README](README.md)；想看真实结果，请看 [SignalDesk 案例](docs/signaldesk-case-study.md)。

## 它要解决的问题

大模型生成一份 React 代码很快，但代码“看起来完整”不代表它能构建、能操作、能适配手机，更不代表自动修复后没有破坏原本正常的功能。

Frontend Autopilot 把生成过程收进一条小而严格的本地流水线：

```text
需求 -> 生成 -> 构建 -> 浏览器验收 -> 限次修复 -> 完整复验 -> 报告
```

它的目标不是做一个通用编程 Agent，而是可靠地交付小型、可演示、使用模拟数据的 React 前端。

## 当前支持

- 输入文字产品需求；
- 可选输入最多 4 张 PNG、JPEG 或 WebP 参考图；
- 生成响应式 React + Vite 应用；
- 验证页面内容和 Playwright 用户场景；
- 在桌面与手机尺寸检查布局、点击区域、对比度和页面状态；
- 有参考图时进行粗粒度结构与颜色比较；
- 根据失败证据进行有限轮修复；
- 在隔离副本中进行一次视觉润色，并完整复验；
- 输出截图、结构化检查结果和 Markdown 交付报告。

## 明确不做

- 不生成真实生产后端；
- 不处理登录、支付、实时通信或真实用户数据；
- 不进行原生 iOS / Android 构建；
- 不允许无限修复或无限润色；
- 不承诺像素级复刻；
- 不用另一个模型的主观评价代替本地验收；
- 不把没过门槛的结果称为成功。

## 成功标准

一次运行只有同时满足以下条件才会成功：

1. 依赖安装与生产构建成功；
2. 计划中的页面能够打开并显示关键内容；
3. 所有用户操作场景通过；
4. 桌面与手机 UI 检查通过；
5. 所有要求的 loading、empty、error、success 状态可以真实触发；
6. 如果提供参考图，视觉分数达到配置门槛；
7. 修复或润色后的版本重新通过全部检查。

## 硬边界

- 模型不能写项目 manifest、lockfile、npmrc 或 Vite 配置；
- 依赖来自固定白名单，安装时使用 `--ignore-scripts`；
- 所有模型路径都必须留在生成应用目录；
- Builder 默认 4 个模型文件、必要时最多 6 个，目标不超过 18,000 字符；程序硬拒绝超过 12 文件或 24,000 字符的输出；
- 修复轮次、命令时间、参考图大小、请求体大小和润色文件数都有上限；
- API Key 只存在于当前进程，不写入运行产物。

## 如何判断这个项目有没有价值

不要只看它能不能生成一张漂亮首页。更重要的问题是：

- 模型写出的代码有没有被当作不可信输入处理？
- 用户操作是否真的在浏览器里跑过？
- 失败时能否定位到具体证据，而不是继续盲目提示？
- 自动修复是否有停止条件？
- 最终结论能否被别人复跑和检查？

SignalDesk 已经证明纯文字需求路径可以通过这套流程。Atlas 则证明系统会拒绝没有达到视觉质量线的生成结果。

## English summary

Frontend Autopilot is deliberately narrow: it generates small mock-data React applications and decides delivery through local build, browser, UI, and optional visual evidence. It does not attempt to be a general coding agent or a production backend generator. Every repair is bounded, and every modified candidate must pass the full verification suite again.
