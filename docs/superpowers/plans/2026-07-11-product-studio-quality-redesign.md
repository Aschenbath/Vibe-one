# Product Studio 成品质量升级实施计划 / Product Studio Quality Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal / 目标：** 把 Vibe-one 升级为适合面试展示的双语 Product Studio；纯文字与参考图任务均须通过确定性 UI audit、一次有界 polish 和全量复验后才能交付。

**Architecture / 架构：** 保留单 OpenAI-compatible provider、固定 React + Vite 脚手架、路径 jail、依赖白名单和机械成功门槛。Planner 增加结构化 `productDesign`；Playwright 采集桌面/移动证据；独立模块执行 UI audit；初稿首次全绿后只在候选副本 polish，候选全量复验通过才提升为最终 app。Console 拆出 Studio state/renderers，形成 Focus 任务书、时间线、作品画布与 Inspector。

**Tech Stack / 技术栈：** Node.js 20 ESM、`node:test`、OpenAI-compatible Chat Completions/SSE、React 18 + Vite、Playwright、原生 HTML/CSS/JavaScript console、固定白名单 `lucide-react`。

---

## 文档语言合同 / Documentation Language Contract

- 面试展示文档采用“完整中文主叙事 + 精简 English Overview/Key Evidence”，不逐句机械翻译。
- Console 继续中文；稳定事件、错误码、文件名、API 字段保留英文并提供中文解释。
- `SPEC.generated.md`、`PLAN.generated.md`、`DELIVERY_REPORT.md` 使用双语章节名和关键字段。
- 公开内容禁止 API Key、私有 endpoint、base64、绝对私有路径和个人生活/学习数据。

## File map / 文件地图

**Create:** `src/core/productDesign.js`, `src/runner/uiQuality.js`, `src/core/polisher.js`, `src/console/public/studio-state.js`, `src/console/public/studio-renderers.js`, `test/ui-quality.test.js`, `scripts/readme-screenshots.mjs`, `examples/signaldesk/input/*`, `examples/atlas-research/input/*`, `docs/demos/archive.md`。

**Modify:** `src/core/{planner,builder,reviewer,fixer,pipeline,runContext,config}.js`, `src/runner/commands.js`, `src/reporter/deliveryReport.js`, `src/console/{runStore,server,jobManager}.js`, `src/console/public/{index.html,app.js,app.css,copy.js,reference-input.js}`, `test/{core,e2e,console,console-e2e,visual}.test.js`, `package.json`, `README.md`, `FRAMEWORK.md`, `docs/{architecture,HANDOFF}.md`, `history.md`。

---
### Task 1: Define `productDesign` / 定义产品设计规格

**Files:** Create `src/core/productDesign.js`; Modify `test/core.test.js`。

- [ ] **Step 1: Write failing tests**

```js
const PRODUCT_DESIGN={productType:'数据密集型 B2B SaaS',targetUsers:['客服运营主管','质检专员'],tone:'精密、克制、可信，避免营销落地页语气',density:'compact',navigation:'左侧主导航与页面筛选工具条',contentStrategy:'真实质检指标、风险会话与处置动作',tokens:{colors:{canvas:'#f6f7f9',surface:'#fff',text:'#18202a',primary:'#315bea',success:'#167d6b',warning:'#a86108',danger:'#b74646'},typography:{display:'28px/1.2 700',heading:'18px/1.35 650',body:'14px/1.55 400',caption:'12px/1.45 500'},spacing:['4px','8px','12px','16px','24px','32px'],radii:['6px','10px','14px']},requiredStates:[{name:'loading',trigger:'首次进入队列'},{name:'empty',trigger:'筛选结果为零'},{name:'success',trigger:'标记复核完成'}]};
test('productDesign requires executable tokens and states',()=>{
  assert.equal(validateProductDesign(PRODUCT_DESIGN).density,'compact');
  assert.match(renderProductDesign(PRODUCT_DESIGN),/产品类型 \/ Product Type/);
  assert.throws(()=>validateProductDesign({...PRODUCT_DESIGN,tone:'现代简洁'}),{code:'PRODUCT_DESIGN_INVALID'});
  assert.throws(()=>validateProductDesign({...PRODUCT_DESIGN,tokens:{colors:{}}}),{code:'PRODUCT_DESIGN_INVALID'});
});
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`; Expected: `ERR_MODULE_NOT_FOUND`。
- [ ] **Step 3: Implement minimal API**

```js
export function validateProductDesign(value){
  const fail=(detail)=>{const e=new Error(`PRODUCT_DESIGN_INVALID: ${detail}`);e.code='PRODUCT_DESIGN_INVALID';throw e;};
  for(const key of ['productType','tone','density','navigation','contentStrategy']) if(typeof value?.[key]!=='string'||value[key].trim().length<8) fail(`${key} incomplete`);
  if(/^(现代|简洁|modern|clean)[,，\s]*(现代|简洁|modern|clean)*$/i.test(value.tone)) fail('tone too vague');
  const t=value.tokens;if(!t||Object.keys(t.colors??{}).length<6||Object.keys(t.typography??{}).length<4||(t.spacing??[]).length<5||(t.radii??[]).length<3) fail('tokens incomplete');
  if((value.requiredStates??[]).length<2||value.requiredStates.some((s)=>!['loading','empty','error','success'].includes(s.name)||!s.trigger?.trim())) fail('states incomplete');
  return value;
}
export function renderProductDesign(v){return ['## 产品设计 / Product Design',`- 产品类型 / Product Type: ${v.productType}`,'```json',JSON.stringify(v.tokens,null,2),'```'].join('\n');}
```

- [ ] **Step 4: Run GREEN** — `node --test test/core.test.js`; Expected: PASS。
- [ ] **Step 5: Commit** — `git add src/core/productDesign.js test/core.test.js && git commit -m "feat: define product design contract"`。
### Task 2: Integrate Planner and bilingual artifacts / 接入 Planner 与双语产物

**Files:** Modify `src/core/planner.js`, `test/core.test.js`。

- [ ] **Step 1: Test contract**

```js
await plan(ctx,stubJsonProvider({...VALID_SPEC,productDesign:PRODUCT_DESIGN}),baseConfig);
assert.match(await fs.readFile(path.join(ctx.runDir,'SPEC.generated.md'),'utf8'),/产品设计 \/ Product Design/);
assert.match(await fs.readFile(path.join(ctx.runDir,'PLAN.generated.md'),'utf8'),/验证计划 \/ Verification Plan/);
assert.ok(ctx.events.some((event)=>event.type==='design:done'));
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`; Expected: planner ignores new contract。
- [ ] **Step 3: Implement** — add exact `productDesign` JSON shape to `PLANNER_SYSTEM`; call `validateProductDesign`; insert `renderProductDesign`; emit:

```js
await ctx.logEvent('design:done',{summary:`${spec.pages?.length??0} pages with executable product design`});
```

Keep `plan:done` for backward-compatible history.
- [ ] **Step 4: Verify** — `node --test test/core.test.js`; existing brief/reference/combined cases PASS。
- [ ] **Step 5: Commit** — `git add src/core/planner.js test/core.test.js && git commit -m "feat: plan executable product design"`。
### Task 3: Strengthen Builder contract / 提升 Builder 合同

**Files:** Modify `src/core/builder.js`, `test/core.test.js`, `package-lock.json`。

- [ ] **Step 1: Test budgets, prompt and whitelist**

```js
assert.match(BUILDER_SYSTEM,/at most 12 files/); assert.match(BUILDER_SYSTEM,/24,000 characters/);
assert.match(BUILDER_SYSTEM,/CSS variables/); assert.match(BUILDER_SYSTEM,/loading.*empty.*error.*success/s);
assert.equal(APP_DEPENDENCIES.dependencies['lucide-react'],'^0.468.0');
assert.throws(()=>validateGeneratedFiles(Array.from({length:13},(_,i)=>({path:`src/${i}.jsx`,content:'x'}))),{code:'BUILD_OUTPUT_LIMIT'});
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`。
- [ ] **Step 3: Implement**

```js
export const BUILD_LIMITS=Object.freeze({maxFiles:12,maxCharacters:24_000});
export function validateGeneratedFiles(files){const chars=files.reduce((n,f)=>n+f.content.length,0);if(files.length>12||chars>24_000){const e=new Error('BUILD_OUTPUT_LIMIT');e.code='BUILD_OUTPUT_LIMIT';throw e;}return files;}
```

Call before writes; whitelist `lucide-react`; prompt requires used CSS variables, realistic data, specified states, 44px targets, styled controls, responsive page boundaries, no Emoji functional icons, no lorem/Card 1/Item A。
- [ ] **Step 4: Verify** — `node --test test/core.test.js`; safeJoin/forbidden path tests remain green。
- [ ] **Step 5: Commit** — `git add src/core/builder.js test/core.test.js package-lock.json && git commit -m "feat: strengthen generated UI contract"`。
### Task 4: Implement pure UI audit rules / 实现 UI audit 纯函数

**Files:** Create `src/runner/uiQuality.js`, `test/ui-quality.test.js`; Modify `package.json`。

- [ ] **Step 1: Write rule tests**

```js
const result=auditPageSnapshot({page:'队列',viewport:'mobile',document:{scrollWidth:430,clientWidth:390},interactive:[{label:'筛选',width:32,height:32}],overlaps:[{a:'筛选',b:'搜索'}],textSamples:[{foreground:'#999',background:'#fff',fontSize:14,fontWeight:400}],visibleText:'Card 1 placeholder text'});
assert.deepEqual(result.failures.map((x)=>x.code),['HORIZONTAL_OVERFLOW','ELEMENT_OVERLAP','HIT_TARGET_TOO_SMALL','LOW_CONTRAST','PLACEHOLDER_CONTENT']);
assert.equal(contrastRatio('#000','#fff'),21);
```

- [ ] **Step 2: Run RED** — `node --test test/ui-quality.test.js`; Expected: missing module。
- [ ] **Step 3: Implement exports**

```js
export const UI_VIEWPORTS=Object.freeze({desktop:{width:1440,height:900},mobile:{width:390,height:844}});
const rgb=(hex)=>{const value=hex.length===4?hex.slice(1).split('').map((x)=>x+x).join(''):hex.slice(1);return [0,2,4].map((i)=>parseInt(value.slice(i,i+2),16)/255);};
const luminance=(hex)=>rgb(hex).map((x)=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((sum,x,index)=>sum+x*[.2126,.7152,.0722][index],0);
export function contrastRatio(fg,bg){const [light,dark]=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);return Math.round(((light+.05)/(dark+.05))*100)/100;}
export function auditPageSnapshot(snapshot){const failures=[];const add=(code,detail)=>failures.push({code,page:snapshot.page,viewport:snapshot.viewport,detail});if(snapshot.document.scrollWidth>snapshot.document.clientWidth)add('HORIZONTAL_OVERFLOW',`${snapshot.document.scrollWidth}>${snapshot.document.clientWidth}`);for(const pair of snapshot.overlaps??[])add('ELEMENT_OVERLAP',`${pair.a}/${pair.b}`);for(const item of snapshot.interactive??[])if(item.width<44||item.height<44)add('HIT_TARGET_TOO_SMALL',`${item.label} ${item.width}x${item.height}`);for(const sample of snapshot.textSamples??[]){const large=sample.fontSize>=24||(sample.fontSize>=18&&sample.fontWeight>=700);if(contrastRatio(sample.foreground,sample.background)<(large?3:4.5))add('LOW_CONTRAST',sample.text??'text');}if(/lorem ipsum|Card \d+|Item [A-Z]|placeholder text/i.test(snapshot.visibleText??''))add('PLACEHOLDER_CONTENT','forbidden placeholder');return{...snapshot,pass:failures.length===0,failures};}
export function summarizeUiAudit(results,pages){const failures=results.flatMap((result)=>result.failures);for(const page of pages)for(const viewport of Object.keys(UI_VIEWPORTS))if(!results.some((result)=>result.page===page.name&&result.viewport===viewport))failures.push({code:'VIEWPORT_EVIDENCE_MISSING',page:page.name,viewport,detail:'missing audit result'});return{pass:failures.length===0,failures,results};}
```

Stable codes: overflow, out-of-bounds, overlap, 44px, contrast, landmarks/headings, unreachable states, empty main, placeholder, stack, unstyled native control, standalone Emoji icon, empty screenshot, missing viewport. Ignore hidden/disabled/zero-area elements。
- [ ] **Step 4: Verify** — add explicit test file to `package.json`; run `npm test`; Expected: PASS。
- [ ] **Step 5: Commit** — `git add src/runner/uiQuality.js test/ui-quality.test.js package.json package-lock.json && git commit -m "feat: add deterministic UI quality rules"`。
### Task 5: Collect Playwright evidence / 采集浏览器证据

**Files:** Modify `src/runner/commands.js`, `test/ui-quality.test.js`。

- [ ] **Step 1: Test collector**

```js
const evidence=await collectUiQuality(ctx,fixtureUrl,[{name:'Workspace',route:'/'}],[]);
assert.deepEqual(evidence.results.map((x)=>x.viewport),['desktop','mobile']);
assert.ok(evidence.summary.failures.some((x)=>x.code==='HIT_TARGET_TOO_SMALL'));
assert.ok(evidence.results.every((x)=>x.screenshot.endsWith('.png')));
```

- [ ] **Step 2: Run RED** — `node --test test/ui-quality.test.js`。
- [ ] **Step 3: Implement collector**

```js
export async function collectUiQuality(ctx,baseUrl,pages,requiredStates=[]){
  const browser=await chromium.launch();const results=[];
  try{for(const pageSpec of pages)for(const [viewportName,viewport] of Object.entries(UI_VIEWPORTS)){const page=await browser.newPage({viewport});await page.goto(new URL(pageSpec.route,baseUrl).href,{waitUntil:'networkidle'});const snapshot=await page.evaluate(collectDomSnapshot,{pageSpec,viewportName,requiredStates});const screenshot=`quality-${slug(pageSpec.name)}-${viewportName}.png`;await page.screenshot({path:path.join(ctx.qualityDir,screenshot),fullPage:true});results.push({...auditPageSnapshot(snapshot),screenshot});await page.close();}}finally{await browser.close();}return{results,summary:summarizeUiAudit(results,pages)};
}
```

Snapshot records dimensions, landmarks/headings, main area, rectangles/intersections, computed colors/fonts, visible text, native styling, standalone icon text and state evidence。
- [ ] **Step 4: Verify** — `node --test test/ui-quality.test.js`; Expected: PASS with two PNG records。
- [ ] **Step 5: Commit** — `git add src/runner/commands.js test/ui-quality.test.js && git commit -m "feat: collect browser UI quality evidence"`。
### Task 6: Gate Reviewer and repair / 接入 Reviewer 与修复

**Files:** Modify `src/core/reviewer.js`, `src/core/fixer.js`, `src/core/pipeline.js`, `test/core.test.js`, `test/e2e.test.js`。

- [ ] **Step 1: Test failure contract**

```js
const passingInput={install:{exitCode:0},build:{exitCode:0},shots:[],spec:{pages:[]},scenarioResults:[],visualResults:[]};
const r=review({...passingInput,uiQuality:{pass:false,failures:[{code:'HIT_TARGET_TOO_SMALL',page:'总览',viewport:'mobile',detail:'32x32'}]}});
assert.equal(r.pass,false); assert.ok(r.failed.some((x)=>x.name==='UI quality audit passes'));
assert.doesNotMatch(describeFailure({reviewResult:r,uiQuality:r.uiQuality}),/[A-Z]:\\|private\.invalid/);
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js test/e2e.test.js`。
- [ ] **Step 3: Integrate**

```js
const uiQuality=await collectUiQuality(ctx,preview.url,spec.pages??[],spec.productDesign?.requiredStates??[]);
await fs.writeFile(path.join(ctx.qualityDir,`round-${round}.json`),JSON.stringify(uiQuality,null,2),'utf8');
await ctx.logEvent('quality:audit',{summary:uiQuality.summary.pass?'UI quality checks pass':`${uiQuality.summary.failures.length} checks failing`});
```

Pass safe structured evidence into reviewer/fixer/report; no absolute path/raw stack。
- [ ] **Step 4: E2E proof** — stub round 0 has 32px button, repair returns 44px; run `VIBE_ONE_E2E=1 node --test test/e2e.test.js`; audit -> repair -> audit -> success。
- [ ] **Step 5: Commit** — `git add src/core/reviewer.js src/core/fixer.js src/core/pipeline.js test/core.test.js test/e2e.test.js && git commit -m "feat: gate delivery on UI quality"`。
### Task 7: Add isolated polish candidate / 增加隔离候选

**Files:** Create `src/core/polisher.js`; Modify `src/core/runContext.js`, `src/core/config.js`, `test/core.test.js`。

- [ ] **Step 1: Test isolation and bounds**

```js
await createPolishCandidate(ctx); await fs.writeFile(path.join(ctx.polishCandidateDir,'src/App.jsx'),'candidate');
assert.equal(await fs.readFile(path.join(ctx.appDir,'src/App.jsx'),'utf8'),'draft');
assert.throws(()=>validatePolishFiles(Array.from({length:5},(_,i)=>({path:`src/${i}.jsx`,content:'x'}))),{code:'POLISH_OUTPUT_LIMIT'});
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`。
- [ ] **Step 3: Implement lifecycle**

```js
export const POLISH_LIMITS=Object.freeze({maxFiles:4,maxCharacters:18_000,maxRounds:1});
export async function createPolishCandidate(ctx){await fs.rm(ctx.polishCandidateDir,{recursive:true,force:true});await fs.cp(ctx.appDir,ctx.polishCandidateDir,{recursive:true});}
export async function promotePolishCandidate(ctx){const backup=`${ctx.appDir}.draft`;await fs.rename(ctx.appDir,backup);try{await fs.rename(ctx.polishCandidateDir,ctx.appDir);}catch(e){await fs.rename(backup,ctx.appDir);throw e;}}
```

Add `qualityDir`, `polishDir`, `polishCandidateDir`; fix `maxPolishRounds=1`, reject other external values。
- [ ] **Step 4: Verify** — `node --test test/core.test.js`; draft unchanged before promotion。
- [ ] **Step 5: Commit** — `git add src/core/polisher.js src/core/runContext.js src/core/config.js test/core.test.js && git commit -m "feat: isolate bounded polish candidates"`。
### Task 8: Implement one-pass Polisher / 实现单次 Polisher

**Files:** Modify `src/core/polisher.js`, `test/core.test.js`。

- [ ] **Step 1: Test prompt evidence**

```js
const files=await polish(ctx,captureProvider,{spec,uiQuality,screenshots:['home-desktop.png','home-mobile.png']});
assert.deepEqual(files,['src/styles.css']); assert.match(captureProvider.user,/Approved product design.*Current source.*desktop.*mobile/s);
assert.doesNotMatch(captureProvider.user,/private\.invalid|[A-Z]:\\/);
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`。
- [ ] **Step 3: Implement**

```js
export const POLISHER_SYSTEM=`Polish an already-correct React + Vite app. Improve only hierarchy, typography, spacing, density, component consistency, state presentation, and responsive behavior. Do not add features, routes, dependencies, network calls, or backend code. Return complete changed files using the builder delimiter protocol. Maximum 4 files and 18,000 characters.`;
```

`polish()` emits start/applied, gathers bounded source + approved design + relative screenshots + audit + optional visual evidence, validates 4/18k and same forbidden paths, applies only to candidate。
- [ ] **Step 4: Verify** — `node --test test/core.test.js`; boundary/security tests PASS。
- [ ] **Step 5: Commit** — `git add src/core/polisher.js test/core.test.js && git commit -m "feat: add single-pass UI polisher"`。
### Task 9: Verify candidate before promotion / 提升前全量复验

**Files:** Modify `src/core/pipeline.js`, `src/runner/commands.js`, `test/e2e.test.js`。

- [ ] **Step 1: Test both outcomes**

```js
assert.equal((await runPipeline({targetDir,config,provider:greenDraftGreenPolish()})).status,'success');
const failed=await runPipeline({targetDir,config,provider:greenDraftBrokenPolish()});
assert.equal(failed.status,'failed'); assert.equal(failed.errorCode,'POLISH_FAILED');
```

- [ ] **Step 2: Run RED** — `VIBE_ONE_E2E=1 node --test test/e2e.test.js`。
- [ ] **Step 3: Implement** — runner accepts `appDir=ctx.appDir`; after first green call polish; candidate reruns install/build/content/scenarios/UI/visual; promote only if all green; otherwise emit `polish:failed`, preserve draft/candidate evidence, never silently return success; plan-only skips polish。
- [ ] **Step 4: Verify** — same E2E command; both promotion and `POLISH_FAILED` PASS。
- [ ] **Step 5: Commit** — `git add src/core/pipeline.js src/runner/commands.js test/e2e.test.js && git commit -m "feat: verify polish before delivery"`。
### Task 10: Persist bilingual evidence / 持久化双语证据

**Files:** Modify `src/reporter/deliveryReport.js`, `src/console/runStore.js`, `src/console/server.js`, `test/core.test.js`, `test/console.test.js`。

- [ ] **Step 1: Test report/API**

```js
assert.match(renderReport(reportInput),/交付报告 \/ Delivery Report/);
assert.match(renderReport(reportInput),/UI 质量验收 \/ UI Quality Audit/);
assert.doesNotMatch(JSON.stringify(await getQuality(runId)),/private\.invalid|[A-Z]:\\|iVBOR/);
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js test/console.test.js`。
- [ ] **Step 3: Implement** — bilingual Overview/Product Design/Verification/UI/Visual/Polish/Evidence/Boundaries; jailed `/design`, `/quality`, `/polish` routes; stable codes and relative evidence URLs only。
- [ ] **Step 4: Verify** — `npm test`; safety tests remain green。
- [ ] **Step 5: Commit** — `git add src/reporter/deliveryReport.js src/console/runStore.js src/console/server.js test/core.test.js test/console.test.js && git commit -m "feat: expose product quality evidence"`。
### Task 11: Extract Studio state / 抽离 Studio 状态

**Files:** Create `src/console/public/studio-state.js`; Modify `src/console/public/app.js`, `src/console/server.js`, `test/console.test.js`。

- [ ] **Step 1: Test reducer**

```js
let s=reduceStudio(createStudioState(),{type:'JOB_STARTED',runId:'r1'});s=reduceStudio(s,{type:'DEVICE_SELECTED',device:'mobile'});s=reduceStudio(s,{type:'INSPECTOR_OPENED'});
assert.deepEqual({mode:s.mode,device:s.canvas.device,drawers:s.drawers},{mode:'flow',device:'mobile',drawers:{timeline:false,inspector:true}});
```

- [ ] **Step 2: Run RED** — `node --test test/console.test.js`。
- [ ] **Step 3: Implement** — export `createStudioState`, `reduceStudio`, `deriveStudioStage`; pure state only; `app.js` owns fetch/SSE and dispatches actions; serve module under CSP。
- [ ] **Step 4: Verify** — `node --test test/console.test.js`; PASS。
- [ ] **Step 5: Commit** — `git add src/console/public/studio-state.js src/console/public/app.js src/console/server.js test/console.test.js && git commit -m "refactor: extract Product Studio state"`。
### Task 12: Build Focus brief and storyboard / 构建 Focus 任务书

**Files:** Modify `index.html`, `app.js`, `reference-input.js`, `app.css`, `test/console-e2e.test.js` under console public paths。

- [ ] **Step 1: Browser test**

```js
await page.getByLabel('产品目标').fill('发现并处置高风险会话'); await page.getByRole('button',{name:'使用 SignalDesk 起点'}).click();
await dispatchReferenceFiles(page,['overview.png','detail.png']); await page.getByRole('button',{name:'将 detail.png 前移'}).click(); await page.getByRole('button',{name:'开始生成'}).click();
assert.match(submittedBrief,/产品目标.*目标用户.*核心流程.*视觉方向/s); assert.deepEqual(submittedReferences.map((x)=>x.name),['detail.png','overview.png']);
```

- [ ] **Step 2: Run RED** — `npm run test:console:e2e`。
- [ ] **Step 3: Implement** — semantic goal/users/max-3 flows/visual direction/storyboard; only B2B 工作台、数据产品、AI 知识工具 presets; compose unified brief; thumbnails/role/reorder/delete; preserve upload limits/settings。
- [ ] **Step 4: Verify** — console E2E PASS and 390px no overflow。
- [ ] **Step 5: Commit** — `git add src/console/public test/console-e2e.test.js && git commit -m "feat: add Product Studio brief canvas"`。
### Task 13: Build Flow shell and Inspector / 构建三段 Flow

**Files:** Create `studio-renderers.js`; Modify console `index.html`, `app.js`, `app.css`, `copy.js`, `test/console-e2e.test.js`。

- [ ] **Step 1: Browser landmarks test**

```js
await openCompletedRun(page); await expect(page.getByRole('navigation',{name:'生产时间线'})).toBeVisible(); await expect(page.getByRole('main',{name:'作品画布'})).toBeVisible(); await expect(page.getByRole('complementary',{name:'质量 Inspector'})).toBeVisible();
await page.getByRole('button',{name:'手机视口'}).click(); await page.getByRole('tab',{name:'UI 质量'}).click(); await expect(page.locator('#inspector-panel')).toContainText('44px');
```

- [ ] **Step 2: Run RED** — `npm run test:console:e2e`。
- [ ] **Step 3: Implement** — render timeline design/build/functional/UI/visual/polish/delivery; canvas keeps last usable preview and changes page/device without task restart; Inspector tabs Product Spec/Design System/Quality/Evidence with contextual page/check/evidence links。
- [ ] **Step 4: Verify** — E2E PASS at 1440x900。
- [ ] **Step 5: Commit** — `git add src/console/public test/console-e2e.test.js && git commit -m "feat: build Product Studio Flow workspace"`。
### Task 14: Responsive visual system and accessibility / 响应式视觉与无障碍

**Files:** Modify `src/console/public/app.css`, `index.html`, `test/console-e2e.test.js`。

- [ ] **Step 1: Mobile test**

```js
assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
await mobile.getByRole('button',{name:'打开生产时间线'}).click(); await mobile.getByRole('button',{name:'打开 Inspector'}).click();
assert.equal(await mobile.locator('button,a,input,textarea,select').evaluateAll((els)=>els.filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&(r.width<44||r.height<44)}).length),0);
```

- [ ] **Step 2: Run RED** — `npm run test:console:e2e`。
- [ ] **Step 3: Implement** — local Chinese font stack; porcelain/cool-gray canvas, graphite/cobalt/teal/amber/red tokens; thin dividers/compact toolbars; desktop 3-column grid; <900px mutually exclusive drawers with Escape/focus return/body lock; 180–240ms motion and reduced-motion off。
- [ ] **Step 4: Verify** — desktop/mobile, keyboard, 44px, reduced motion PASS。
- [ ] **Step 5: Commit** — `git add src/console/public/app.css src/console/public/index.html test/console-e2e.test.js && git commit -m "feat: finish responsive Studio experience"`。
### Task 15: Add representative demo inputs / 添加代表性输入

**Files:** Create both example trees; Modify `package.json`, `test/core.test.js`。

- [ ] **Step 1: Test examples**

```js
for(const name of ['signaldesk','atlas-research']){const brief=await fs.readFile(path.join(PROJECT_ROOT,'examples',name,'input','brief.md'),'utf8');assert.match(brief,/3 个页面|three pages/i);assert.match(brief,/至少 5 个交互场景|at least five/i);}assert.ok((await discoverReferenceImages(path.join(PROJECT_ROOT,'examples','atlas-research','input'))).length>=2);
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`。
- [ ] **Step 3: Implement** — SignalDesk pages: overview/queue/detail and 6 interactions; Atlas: library/reader/insights and 6 interactions; realistic neutral data and required states; Atlas >=2 public-safe references + manifest/page roles; add `demo:signaldesk`, `demo:atlas` scripts。
- [ ] **Step 4: Verify** — configs load; Atlas references discovered。
- [ ] **Step 5: Commit** — `git add examples package.json package-lock.json test/core.test.js && git commit -m "feat: add representative product briefs"`。
### Task 16: Run and inspect real API demos / 运行并检查真实 API 演示

**Files:** Create/Modify `docs/screenshots/signaldesk-*`, `docs/screenshots/atlas-*`, `docs/demo-reports/{signaldesk,atlas-research}.md`; Modify `history.md`。

- [ ] **Step 1: Preflight** — `npm test`; Expected: PASS before paid calls。
- [ ] **Step 2: SignalDesk** — `npm run demo:signaldesk`; Expected: real usage >0, 3 pages, >=5 scenarios, desktop/mobile audit green, polish promoted, report success。
- [ ] **Step 3: Atlas** — `npm run demo:atlas`; Expected: >=2 mappings, 3 pages, >=5 scenarios, visual history, audit green, polish promoted, report success。
- [ ] **Step 4: Manual evidence gate** — inspect every image; reject clipping, blank main, filler, unreadable density, broken responsive data, inconsistent mock data or unstyled controls; copy only reviewed screenshots/sanitized reports; scan secrets/endpoints/base64/absolute paths。
- [ ] **Step 5: Record and push evidence**

```bash
git add docs/screenshots docs/demo-reports history.md
git commit -m "docs: add verified Product Studio demos"
git push origin main
```

Record absolute timestamp, model ID (never key/endpoint), run IDs, rounds, page/scenario counts, UI repairs, visual scores and remaining limits。
### Task 17: Rewrite bilingual portfolio docs and final verification / 重写双语作品集文档并总验收

**Files:** Modify public docs/screenshots/tests/history; Create `docs/demos/archive.md`, `scripts/readme-screenshots.mjs`。

- [ ] **Step 1: Test README contract**

```js
const readme=await fs.readFile(path.join(PROJECT_ROOT,'README.md'),'utf8');assert.ok(readme.indexOf('## 为什么做 Vibe-one')<readme.indexOf('## English Overview'));assert.match(readme,/SignalDesk/);assert.match(readme,/Atlas Research/);assert.doesNotMatch(readme,/## 主演示.*Expense Tracker|## 主演示.*Notes App/s);
```

- [ ] **Step 2: Run RED** — `node --test test/core.test.js`; Expected: old demos still primary / English Overview absent。
- [ ] **Step 3: Rewrite docs** — README order: Chinese thesis, architecture, Studio shots, SignalDesk, Atlas, mechanical-vs-visual-vs-human quality, safety, quick start, interview points, concise English Overview. Architecture/HANDOFF/FRAMEWORK use Chinese main sections + English summary tables. Expense/Notes move to archive without deleting history。
- [ ] **Step 4: Deterministic screenshots**

```js
// scripts/readme-screenshots.mjs: start stub console, seed Focus and completed Flow,
// pin prefers-color-scheme: light, capture 1440x900 and 390x844, close all processes.
```

Run: `node scripts/readme-screenshots.mjs`; Expected: non-empty reviewed Focus/Flow images。
- [ ] **Step 5: Full verify, history, commit, push**

```bash
npm test
npm run test:console:e2e
VIBE_ONE_E2E=1 npm test
node --check src/core/pipeline.js
node --check src/core/polisher.js
node --check src/runner/uiQuality.js
node --check src/console/public/app.js
git diff --check
```

Expected: all suites/syntax/whitespace PASS. Scan public tracked files for key patterns, private endpoints, `data:image`, base64, `C:\\Users\\`, `D:\\`, `F:\\`, placeholder terms; only explicit test fixtures may match. Inspect every README image. Append timestamped `history.md`, then:

```bash
git add README.md FRAMEWORK.md docs scripts test history.md src package.json package-lock.json examples
git commit -m "feat: deliver Product Studio quality pipeline"
git push origin main
git status -sb
```

Expected: clean `main...origin/main`。

---

## Self-review / 自查

- Spec 1–3: architecture boundaries; 4–5: Tasks 11–14; 6: Tasks 1–2; 7: Task 3; 8: Tasks 4–6; 9–10: Tasks 7–10; 11: Tasks 15–16; 12: all TDD/E2E; 13: Task 17; 14 completion gates: Tasks 9/14/16/17; 15 exclusions stay explicit。
- No placeholder markers, deferred implementation, undefined future phase, multi-agent runtime, model self-score, backend/database, arbitrary dependencies, pixel-perfect claim or unbounded loop。
- Stable names are consistent: `productDesign`, `UI_VIEWPORTS`, `collectUiQuality`, `uiQuality`, `POLISH_LIMITS`, `polishCandidateDir`, `polish()`, `promotePolishCandidate()`, `POLISH_FAILED`。
- Implementation begins in a worktree; every task has a focused commit; Task 16 performs an evidence push and Task 17 the final integration push。
