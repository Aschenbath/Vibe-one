# 技术架构

## 先说结论

Frontend Autopilot 的关键设计不是“多调用几个模型”，而是把模型放在一个受控位置：它可以提出产品方案、生成源码和修复文件，但不能决定自己是否成功，也不能随意改项目配置或在磁盘上乱写。

```text
输入需求
   ↓
Planner：整理页面、流程、状态和验收条件
   ↓
Builder：在固定脚手架里生成源码
   ↓
Runner：真实安装、构建、启动和截图
   ↓
Reviewer：检查内容、交互、桌面/手机 UI 和参考图
   ↓
失败 → Fixer 限次修复 → 回到 Runner
通过 → Polisher 在隔离副本中修改 → 完整复验
   ↓
Reporter：保存结果和交付报告
```

## 各模块负责什么

| 模块 | 职责 | 是否调用模型 |
| --- | --- | --- |
| `core/planner.js` | 把需求整理成页面、交互场景、状态触发方式和验收条件 | 是 |
| `core/builder.js` | 写入固定脚手架，并接收受限的源码文件 | 是 |
| `runner/commands.js` | 执行 npm、Vite、Playwright 和截图 | 否 |
| `core/reviewer.js` | 根据运行结果判断内容和交互是否通过 | 否 |
| `runner/uiQuality.js` | 在桌面和手机尺寸检查布局、控件、对比度和状态 | 否 |
| `runner/visualCompare.js` | 有参考图时比较大体结构和颜色分布 | 否 |
| `core/fixer.js` | 只根据失败证据生成修复文件 | 是 |
| `core/polisher.js` | 在隔离候选中做一次受限的视觉优化 | 是 |
| `reporter/deliveryReport.js` | 汇总命令、检查、修复和最终状态 | 否 |

## 三个核心设计

### 模型只能写业务源码

`package.json` 和 Vite 配置由流水线自己生成。模型不能写 manifest、lockfile、npmrc、配置文件或 `node_modules`，也不能使用白名单外的依赖。每个输出路径都会通过 `safeJoin` 检查，绝对路径和 `..` 越界路径会被拒绝。

Builder 默认被要求只输出 4 个文件，必要时最多 6 个，目标不超过 18,000 字符；本地验证器仍会硬拒绝超过 12 文件或 24,000 字符的响应。这样即使兼容接口忽略 `max_tokens`，模型也无法把无限内容写进应用目录。

### 成功由浏览器证据决定

Runner 会安装依赖、执行生产构建、启动可用端口上的 Vite preview，再由 Playwright 打开真实页面。Reviewer 使用这些结果检查关键文字和用户流程，不采用“请模型评价刚才生成得怎么样”这种自评方式。

产品状态也不是要求每张静态截图同时出现 loading、empty、error 和 success。Planner 必须为每个状态给出路由、操作步骤和预期文字，验收器在对应页面执行步骤后检查结果。

### 修复和润色都不能绕过验收

Fixer 只能在有限轮数内工作，每一轮都接收具体失败项。轮数耗尽后任务失败，不会静默继续重试。

首次全绿后，Polisher 修改的是单独的 `polish-candidate`。这个副本要重新通过构建、内容、交互、UI 和视觉检查；任何一项退化，原来的全绿版本都会保留。

## 本地工作台的数据边界

Product Studio 默认监听 `127.0.0.1`，一次只运行一个生成任务，并只保留一个 Vite 预览进程。浏览器提交的 API Key 留在 Node.js 进程内；公开任务对象、事件日志、截图清单和报告都会移除 Key、上传图片的 base64、私有 endpoint 和绝对路径。

参考图必须是 PNG、JPEG 或 WebP，最多 4 张，单张最多 6 MiB、总计最多 18 MiB。报告和截图读取也必须留在对应 run 目录中。

## 视觉检查的边界

本地视觉比较使用结构相似度和颜色直方图，只能判断大体布局和色彩是否接近，不能代替设计师判断，更不等于像素级复刻。UI audit 能发现可测量的问题，也不能证明页面一定“好看”。因此仓库同时保留机器报告和人工可查看的最终截图。

## English summary

The model is a constrained producer, not the judge. Fixed scaffolding, dependency allowlists, path jails, output budgets, real npm/Vite execution, Playwright scenarios, responsive state checks, bounded repair, and isolated polish promotion keep generation inside a verifiable local system. A result ships only when the complete deterministic verification path passes.
