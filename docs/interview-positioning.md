# Interview Positioning

## The one-liner

> 我做了一个有边界的 AI 交付流水线：输入产品 brief，自动生成 spec 和可运行的 React 应用，用真实本地命令和 Playwright 截图做验证，失败时在限定轮数内自动修复，最后产出可审计的交付报告（命令、退出码、修复记录、token 消耗）。

## Why this is stronger than "I used AI to build an app"

- 证据可验证：面试官不需要相信任何说法；仓库已提交两份真实 Delivery Report 与 8 张截图，也可以本地复跑。
- 工程判断在系统里：reviewer 全部是机械检查（不是让模型自评），fixer 有硬性轮数上限，模型写文件被 path jail 限制在 `app/` 内。
- 与手动 AI 编辑的本质区别：这里模型是被编排的组件，验证和成功判定由确定性代码控制。

## Expected questions and answers

**Q: 模型输出不稳定怎么办？**
planner 使用 JSON mode；builder/fixer 使用 raw delimiter blocks，避免大段源码被 JSON 转义破坏。provider 使用 SSE streaming，并对网络错误、429、500/502/503/504 做有界重试；解析失败仍直接 fail，报告如实记录。

**Q: 怎么防止无限修复循环？**
`maxRepairRounds`（默认 2）硬上限；每轮的诊断和补丁文件都写进 events.jsonl 和报告；轮数耗尽就以 failed 状态收尾，不假装成功。

**Q: 成功的定义是什么？**
install/build 退出码为 0、preview 起得来、每个计划页面截图非空且有可见文本、`mustContain` 文本存在、Playwright 交互场景通过。全过才算 success。

**Q: 为什么不用 LangChain / 多 agent？**
MVP 阶段编排逻辑不到 200 行，确定性代码比框架更好审计；多 agent 对这个问题没有可测量的收益，属于范围蔓延（FRAMEWORK.md 明确列为 non-goal）。

## Demo script (5 minutes)

1. 展示 `examples/expense-mobile/input/brief.md`（输入只有一份中文 brief）。
2. 展示 `docs/demo-reports/expense-mobile.md`：round 0 成功、3 页、4 个交互场景。
3. 展示 `docs/demo-reports/notes-mobile-repaired.md`：round 0 失败、fixer 修改 `src/App.jsx`、round 1 全绿。
4. 展示 `docs/screenshots/` 中两套生成 UI。
5. 现场执行 `npm run demo:expense` 或 `npm run demo:notes`，边跑边讲 pipeline 阶段。
