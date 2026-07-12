// Offline unit tests: no network, no model. Pins the safety-critical helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILDER_SYSTEM, safeJoin } from '../src/core/builder.js';
import { parseFileBlocks } from '../src/core/builder.js';
import { createProvider, extractJson, resolveRequestTimeout } from '../src/providers/openaiCompatible.js';
import { review } from '../src/core/reviewer.js';
import {
  UI_EVIDENCE_LIMITS,
  createFixerUserContent,
  describeFailure,
  gatherSource,
  validateUiEvidenceFiles,
} from '../src/core/fixer.js';
import { writeReport } from '../src/reporter/deliveryReport.js';
import { exitCodeForStatus } from '../src/cli/status.js';
import { createRunContext } from '../src/core/runContext.js';
import { loadConfig } from '../src/core/config.js';
import { PLANNER_SYSTEM, createPlannerUserContent, plan } from '../src/core/planner.js';
import { runPipeline } from '../src/core/pipeline.js';
import {
  REFERENCE_LIMITS,
  normalizeReferencePayloads,
  writeReferencePayloads,
  discoverReferenceImages,
} from '../src/core/referenceImages.js';
import { renderProductDesign, validateProductDesign } from '../src/core/productDesign.js';

const APP = path.resolve('/tmp/run/app');
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function loadPolisherModule() {
  const module = await import('../src/core/polisher.js').catch(() => null);
  assert.ok(module, 'polisher module must exist');
  return module;
}
const PRODUCT_DESIGN = {
  productType: '数据密集型 B2B SaaS',
  targetUsers: ['客服运营主管', '质检专员'],
  tone: '现代数据工作台，克制可信、信息优先',
  density: 'compact',
  navigation: '左侧主导航配合顶部任务上下文切换',
  contentStrategy: '先展示异常、趋势与待处理任务，再提供明细下钻',
  componentLanguage: ['紧凑指标卡', '高密度数据表', '状态标签与行内操作'],
  responsiveRules: ['桌面端保留三栏工作区', '窄屏折叠侧栏并纵向排列摘要卡'],
  tokens: {
    colors: {
      canvas: '#F4F6F8',
      surface: '#FFFFFF',
      text: '#17202A',
      primary: '#2457D6',
      success: '#16825D',
      warning: '#C47A12',
      danger: '#C53A3A',
    },
    typography: {
      display: '700 32px/1.2 Inter, sans-serif',
      heading: '650 20px/1.3 Inter, sans-serif',
      body: '400 14px/1.5 Inter, sans-serif',
      caption: '500 12px/1.4 Inter, sans-serif',
    },
    spacing: ['4px', '8px', '12px', '16px', '24px', '32px'],
    radii: ['4px', '8px', '12px'],
  },
  requiredStates: [
    { name: 'loading', trigger: '首次加载质量概览时' },
    { name: 'empty', trigger: '筛选条件没有匹配记录时' },
    { name: 'success', trigger: '批量质检任务提交完成时' },
  ],
};

test('product design validates an executable compact B2B SaaS contract', () => {
  assert.equal(validateProductDesign(PRODUCT_DESIGN).density, 'compact');
});

test('product design accepts concise non-empty list labels', () => {
  const design = validateProductDesign({
    ...PRODUCT_DESIGN,
    targetUsers: ['CEO'],
    componentLanguage: ['表格'],
    responsiveRules: ['抽屉'],
  });

  assert.deepEqual(design.targetUsers, ['CEO']);
  assert.deepEqual(design.componentLanguage, ['表格']);
  assert.deepEqual(design.responsiveRules, ['抽屉']);
});

test('product design renders Chinese-first bilingual Markdown', () => {
  const markdown = renderProductDesign(PRODUCT_DESIGN);

  assert.match(markdown, /产品类型 \/ Product Type/);
  assert.match(markdown, /客服运营主管/);
  assert.match(markdown, /现代数据工作台，克制可信、信息优先/);
  assert.match(markdown, /左侧主导航配合顶部任务上下文切换/);
  assert.match(markdown, /先展示异常、趋势与待处理任务，再提供明细下钻/);
  assert.match(markdown, /紧凑指标卡/);
  assert.match(markdown, /首次加载质量概览时/);
  assert.match(markdown, /窄屏折叠侧栏并纵向排列摘要卡/);
});

test('product design rejects generic-only tones after Chinese and English normalization', () => {
  for (const tone of [
    '现代、简洁、专业、可信',
    '现代（简洁）专业—可信',
    ' modern / clean, professional； trustworthy ',
    '高级，美观，premium beautiful',
  ]) {
    assert.throws(
      () => validateProductDesign({ ...PRODUCT_DESIGN, tone }),
      (error) => error.code === 'PRODUCT_DESIGN_INVALID',
      tone,
    );
  }

  assert.equal(
    validateProductDesign({ ...PRODUCT_DESIGN, tone: '现代、简洁，但以风险会话密度和行内处置为核心' }).tone,
    '现代、简洁，但以风险会话密度和行内处置为核心',
  );
});

test('product design requires at least two distinct valid states', () => {
  assert.throws(
    () => validateProductDesign({
      ...PRODUCT_DESIGN,
      requiredStates: [
        { name: 'loading', trigger: '首次加载质量概览时' },
        { name: 'empty', trigger: '筛选条件没有匹配记录时' },
        { name: 'loading', trigger: '刷新质量概览时' },
      ],
    }),
    (error) => error.code === 'PRODUCT_DESIGN_INVALID',
  );
});

test('product design rejects incomplete lists, states, triggers, and token groups', () => {
  const invalidCases = [
    ['empty targetUsers', { targetUsers: [] }],
    ['blank targetUsers', { targetUsers: [' '] }],
    ['empty componentLanguage', { componentLanguage: [] }],
    ['blank componentLanguage', { componentLanguage: [' '] }],
    ['empty responsiveRules', { responsiveRules: [] }],
    ['blank responsiveRules', { responsiveRules: [' '] }],
    ['invalid state', { requiredStates: [{ name: 'idle', trigger: '等待任务开始时' }, PRODUCT_DESIGN.requiredStates[1]] }],
    ['short trigger', { requiredStates: [{ name: 'loading', trigger: '短' }, PRODUCT_DESIGN.requiredStates[1]] }],
    ['colors insufficient', { tokens: { ...PRODUCT_DESIGN.tokens, colors: { canvas: '#fff' } } }],
    ['typography insufficient', { tokens: { ...PRODUCT_DESIGN.tokens, typography: { body: '14px sans-serif' } } }],
    ['spacing insufficient', { tokens: { ...PRODUCT_DESIGN.tokens, spacing: ['4px'] } }],
    ['radii insufficient', { tokens: { ...PRODUCT_DESIGN.tokens, radii: ['4px'] } }],
  ];

  for (const [name, overrides] of invalidCases) {
    assert.throws(
      () => validateProductDesign({ ...PRODUCT_DESIGN, ...overrides }),
      (error) => error.code === 'PRODUCT_DESIGN_INVALID',
      name,
    );
  }
});

test('package test command is compatible with the Node 20 CI runner', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(
    pkg.scripts.test,
    'node --test test/console.test.js test/console-e2e.test.js test/core.test.js test/e2e.test.js test/ui-quality.test.js test/visual.test.js',
  );
  assert.doesNotMatch(pkg.scripts.test, /[*?]/);
});

test('builder prompt keeps model output within the gateway-friendly MVP budget', () => {
  assert.match(BUILDER_SYSTEM, /at most 12 files/i);
  assert.match(BUILDER_SYSTEM, /24,000 characters/i);
  assert.match(BUILDER_SYSTEM, /src\/App\.jsx/);
  assert.match(BUILDER_SYSTEM, /CSS variables.*design tokens.*actually use/is);
  assert.match(BUILDER_SYSTEM, /realistic.*consistent mock data/is);
  assert.match(BUILDER_SYSTEM, /loading.*empty.*error.*success.*trigger/is);
  assert.match(BUILDER_SYSTEM, /44px.*targets/is);
  assert.match(BUILDER_SYSTEM, /style.*button.*input.*select.*number spinner/is);
  assert.match(BUILDER_SYSTEM, /responsive.*page boundaries/is);
  assert.match(BUILDER_SYSTEM, /do not use Emoji.*functional icons/is);
  assert.match(BUILDER_SYSTEM, /lorem ipsum.*Card 1.*Item A/is);
});

test('builder exposes the fixed dependency and output limit contracts', async () => {
  const { APP_DEPENDENCIES, BUILD_LIMITS } = await import('../src/core/builder.js');

  assert.equal(APP_DEPENDENCIES.dependencies['lucide-react'], '^0.468.0');
  assert.deepEqual(BUILD_LIMITS, { maxFiles: 12, maxCharacters: 24_000 });
  assert.equal(Object.isFrozen(BUILD_LIMITS), true);
  assert.equal(Object.isFrozen(APP_DEPENDENCIES), true);
  assert.equal(Object.isFrozen(APP_DEPENDENCIES.dependencies), true);
  assert.equal(Object.isFrozen(APP_DEPENDENCIES.devDependencies), true);
});

test('generated file limits accept the exact file and character boundaries', async () => {
  const { validateGeneratedFiles } = await import('../src/core/builder.js');
  const files = Array.from({ length: 12 }, (_, index) => ({
    path: 'src/file-' + index + '.js',
    content: index === 0 ? 'x'.repeat(23_989) : 'x',
  }));

  assert.equal(files.reduce((total, file) => total + file.content.length, 0), 24_000);
  assert.equal(validateGeneratedFiles(files), files);
});

test('generated file limits reject excess and malformed model output with a stable code', async () => {
  const { validateGeneratedFiles } = await import('../src/core/builder.js');
  const tooMany = Array.from({ length: 13 }, (_, index) => ({
    path: 'src/file-' + index + '.js',
    content: 'x',
  }));

  assert.throws(
    () => validateGeneratedFiles(tooMany),
    (error) => error.code === 'BUILD_OUTPUT_LIMIT' && /13 files.*12/i.test(error.message),
  );
  assert.throws(
    () => validateGeneratedFiles([{ path: 'src/App.jsx', content: 'x'.repeat(24_001) }]),
    (error) => error.code === 'BUILD_OUTPUT_LIMIT' && /24001.*24000/.test(error.message),
  );
  for (const files of [
    undefined,
    null,
    {},
    [],
    [{ path: 'src/App.jsx' }],
    [{ path: 'src/App.jsx', content: 42 }],
  ]) {
    assert.throws(
      () => validateGeneratedFiles(files),
      (error) => error.code === 'BUILD_OUTPUT_LIMIT',
    );
  }
});

test('build rejects over-limit output before writing any model-authored file', async () => {
  const { build } = await import('../src/core/builder.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-builder-limit-order-'));
  const appDir = path.join(root, 'app');
  const events = [];
  const content = Array.from({ length: 13 }, (_, index) => [
    '=== FILE: src/file-' + index + '.jsx',
    'export default function File' + index + '() { return null; }',
    '=== END ===',
  ].join('\n')).join('\n');
  const ctx = {
    appDir,
    logEvent: async (type, data) => events.push({ type, ...data }),
    addUsage: () => {},
  };

  await fs.mkdir(appDir, { recursive: true });
  try {
    await assert.rejects(
      build(
        ctx,
        { chat: async () => ({ content, usage: {} }) },
        { brief: '构建质量运营工作台' },
        { summary: '质量运营工作台' },
      ),
      (error) => error.code === 'BUILD_OUTPUT_LIMIT',
    );
    assert.equal((await fs.stat(path.join(appDir, 'package.json'))).isFile(), true);
    await assert.rejects(
      fs.access(path.join(appDir, 'src', 'file-0.jsx')),
      (error) => error.code === 'ENOENT',
    );
    assert.equal(events.some((event) => event.type === 'build:done'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('planned and successful runs exit cleanly', () => {
  assert.equal(exitCodeForStatus('planned'), 0);
  assert.equal(exitCodeForStatus('success'), 0);
  assert.equal(exitCodeForStatus('failed'), 2);
});

test('safeJoin allows normal relative paths', () => {
  assert.equal(safeJoin(APP, 'src/main.jsx'), path.resolve(APP, 'src/main.jsx'));
});

test('safeJoin rejects traversal and absolute paths', () => {
  assert.throws(() => safeJoin(APP, '../outside.txt'));
  assert.throws(() => safeJoin(APP, '..\\outside.txt'));
  assert.throws(() => safeJoin(APP, path.resolve('/etc/passwd')));
  assert.throws(() => safeJoin(APP, 'C:\\Windows\\evil.js'));
});

test('portable absolute-path detection rejects Windows and POSIX forms on every host OS', async () => {
  const builder = await import('../src/core/builder.js');
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('C:\\Windows\\evil.js'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('\\\\server\\share\\evil.js'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('/etc/passwd'), true);
  assert.equal(builder.isAbsoluteOnAnyPlatform?.('src/App.jsx'), false);
});

test('safeJoin rejects pipeline-owned files', () => {
  assert.throws(() => safeJoin(APP, 'package.json'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'vite.config.js'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, '.npmrc'), /pipeline-owned/);
  assert.throws(() => safeJoin(APP, 'node_modules/react/index.js'), /pipeline-owned/);
  // normal app files still allowed
  assert.ok(safeJoin(APP, 'src/App.jsx'));
});

test('extractJson tolerates markdown fences', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.throws(() => extractJson('not json'));
});

test('provider preserves OpenAI-compatible multimodal user content', async (t) => {
  let requestBody;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const provider = createProvider({
    model: 'vision-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });
  const content = [
    { type: 'text', text: 'Clone this UI' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ];

  await provider.chatJson({ system: 'system', user: content });

  assert.deepEqual(requestBody.messages[1].content, content);
});

test('provider rejects unsupported multimodal parts before sending a request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const provider = createProvider({
    model: 'vision-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });

  await assert.rejects(
    provider.chat({ user: [{ type: 'input_image', image_url: { url: 'data:image/png;base64,AAAA' } }] }),
    /unsupported part/,
  );
  assert.equal(calls, 0);
});

test('provider returns a coded error when the upstream rejects visual content', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(
    'image content is not supported by this model',
    { status: 415 },
  ));
  const provider = createProvider({
    model: 'text-only-model',
    baseUrl: 'http://local/v1',
    apiKey: 'x',
    temperature: 0,
    streamResponses: false,
    maxNetworkRetries: 0,
  });

  await assert.rejects(
    provider.chat({
      user: [
        { type: 'text', text: 'Clone this UI' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }),
    (error) => error.code === 'VISION_UNSUPPORTED',
  );
});

test('planner content includes reference images and visual schema instructions', () => {
  const content = createPlannerUserContent({
    brief: '做一个记账产品',
    references: [{
      name: 'home.png',
      type: 'image/png',
      width: 390,
      height: 844,
      buffer: ONE_PIXEL_PNG,
    }],
  });

  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /home\.png.*390x844/s);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.match(PLANNER_SYSTEM, /visualDesign/);
  assert.match(PLANNER_SYSTEM, /referenceImage/);
});

test('planner validates product design and writes bilingual artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-planner-product-design-'));
  const events = [];
  const ctx = {
    runDir: root,
    logEvent: async (type, data) => events.push({ type, ...data }),
    addUsage: () => {},
  };
  const config = {
    brief: '构建客服质检运营工作台',
    references: [],
    stack: 'react-vite',
    viewport: { width: 1440, height: 900 },
    maxRepairRounds: 1,
  };

  try {
    const spec = productPlanFixture();
    const result = await plan(ctx, {
      chatJson: async () => ({
        json: spec,
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    }, config);
    const [specMd, planMd] = await Promise.all([
      fs.readFile(path.join(root, 'SPEC.generated.md'), 'utf8'),
      fs.readFile(path.join(root, 'PLAN.generated.md'), 'utf8'),
    ]);

    assert.deepEqual(result.productDesign, PRODUCT_DESIGN);
    assert.match(PLANNER_SYSTEM, /productDesign/);
    assert.match(PLANNER_SYSTEM, /productType.*targetUsers.*tone.*density.*navigation.*contentStrategy/s);
    assert.match(PLANNER_SYSTEM, /colors.*typography.*spacing.*radii/s);
    assert.match(PLANNER_SYSTEM, /componentLanguage.*requiredStates.*responsiveRules/s);
    assert.match(PLANNER_SYSTEM, /product-specific.*not generic.*modern.*clean/is);
    assert.match(PLANNER_SYSTEM, /at least 6 color tokens.*4 typography tokens.*5 spacing values.*3 radii/is);
    assert.match(PLANNER_SYSTEM, /at least 2 distinct states.*loading.*empty.*error.*success/is);
    assert.match(PLANNER_SYSTEM, /trigger.*at least 4 characters/is);
    assert.match(PLANNER_SYSTEM, /density.*compact.*8 characters/is);
    assert.match(specMd, /产品设计 \/ Product Design/);
    assert.match(specMd, /客服运营主管/);
    assert.match(specMd, /#2457D6/);
    assert.match(planMd, /验证计划 \/ Verification Plan/);
    assert.match(planMd, /数据密集型 B2B SaaS/);
    assert.match(planMd, /面向客服运营团队的会话质量与风险处置工作台/);
    assert.ok(events.some((event) => event.type === 'design:done'));
    assert.ok(events.some((event) => event.type === 'plan:done'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('planner rejects missing or invalid product design before writing artifacts', async () => {
  for (const productDesign of [
    undefined,
    { ...PRODUCT_DESIGN, tone: '现代简洁' },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-planner-invalid-design-'));
    const events = [];
    const spec = productPlanFixture();
    if (productDesign === undefined) delete spec.productDesign;
    else spec.productDesign = productDesign;
    const ctx = {
      runDir: root,
      logEvent: async (type, data) => events.push({ type, ...data }),
      addUsage: () => {},
    };
    const config = {
      brief: '构建客服质检运营工作台',
      references: [],
      stack: 'react-vite',
      viewport: { width: 1440, height: 900 },
      maxRepairRounds: 1,
    };

    try {
      await assert.rejects(
        plan(ctx, { chatJson: async () => ({ json: spec }) }, config),
        (error) => error.code === 'PRODUCT_DESIGN_INVALID',
      );
      await assert.rejects(
        fs.access(path.join(root, 'SPEC.generated.md')),
        (error) => error.code === 'ENOENT',
      );
      await assert.rejects(
        fs.access(path.join(root, 'PLAN.generated.md')),
        (error) => error.code === 'ENOENT',
      );
      assert.equal(events.some((event) => event.type === 'design:done'), false);
      assert.equal(events.some((event) => event.type === 'plan:done'), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('planner rejects incomplete or unsafe visual mappings for reference jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-planner-visual-contract-'));
  const reference = {
    name: 'home.png',
    type: 'image/png',
    width: 1,
    height: 1,
    buffer: ONE_PIXEL_PNG,
  };
  const ctx = {
    runDir: root,
    logEvent: async () => {},
    addUsage: () => {},
  };
  const config = {
    brief: '',
    references: [reference],
    stack: 'react-vite',
    viewport: { width: 1, height: 1 },
    maxRepairRounds: 0,
  };
  const invalidSpecs = [
    { pages: [{ name: 'Home', route: '/', referenceImage: 'home.png' }] },
    {
      visualDesign: visualDesignFixture(),
      pages: [{ name: 'Home', route: '/', referenceImage: 'missing.png' }],
    },
    {
      visualDesign: visualDesignFixture(),
      pages: [{ name: 'Home', route: '/', referenceImage: null }],
    },
  ];

  try {
    for (const spec of invalidSpecs) {
      await assert.rejects(
        plan(ctx, { chatJson: async () => ({ json: spec }) }, config),
        (error) => error.code === 'VISUAL_PLAN_INVALID',
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pipeline fails before build when a reference is not mapped by the planner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-pipeline-visual-contract-'));
  const targetDir = path.join(root, 'target');
  let buildCalls = 0;
  const config = {
    stack: 'react-vite',
    viewport: { width: 1, height: 1 },
    maxRepairRounds: 0,
    model: 'stub',
    baseUrl: 'http://stub.local/v1',
    brief: '',
    references: [{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      buffer: ONE_PIXEL_PNG,
    }],
    runsRoot: path.join(root, 'runs'),
  };
  const provider = {
    chatJson: async () => ({
      json: {
        visualDesign: visualDesignFixture(),
        pages: [{ name: 'Home', route: '/', referenceImage: null }],
      },
    }),
    chat: async () => {
      buildCalls += 1;
      throw new Error('builder should not run');
    },
  };

  try {
    const result = await runPipeline({ targetDir, config, provider });
    const events = await fs.readFile(path.join(result.runDir, 'logs', 'events.jsonl'), 'utf8');
    assert.equal(result.status, 'failed');
    assert.equal(buildCalls, 0);
    assert.match(events, /"type":"fatal".*"code":"VISUAL_PLAN_INVALID"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('pipeline returns PIPELINE_FAILED for an uncoded infrastructure exception', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-pipeline-uncoded-'));
  const privatePath = 'D:\\private\\vibe-secret\\artifact.txt';
  const config = {
    stack: 'react-vite',
    viewport: { width: 390, height: 844 },
    maxRepairRounds: 0,
    model: 'stub',
    baseUrl: 'https://private.invalid/v1',
    brief: '# Brief',
    references: [],
    runsRoot: path.join(root, 'runs'),
  };
  const provider = {
    chatJson: async () => {
      throw new Error(`browser failed at ${privatePath}`);
    },
  };

  try {
    const result = await runPipeline({
      targetDir: path.join(root, 'target'),
      config,
      provider,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'PIPELINE_FAILED');
    const events = await fs.readFile(
      path.join(result.runDir, 'logs', 'events.jsonl'),
      'utf8',
    );
    assert.match(events, /"type":"fatal".*"summary":"PIPELINE_FAILED"/);
    assert.doesNotMatch(events, /private\.invalid|vibe-secret|artifact\.txt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function visualDesignFixture() {
  return {
    layout: 'single page',
    palette: ['#ffffff'],
    typography: 'sans serif',
    spacing: '16px rhythm',
    components: ['Header'],
    responsive: 'fluid layout',
  };
}

function productPlanFixture() {
  return {
    summary: '面向客服运营团队的会话质量与风险处置工作台。',
    visualDesign: visualDesignFixture(),
    productDesign: PRODUCT_DESIGN,
    pages: [{
      name: '质量概览',
      route: '/',
      purpose: '定位风险趋势与待处理会话',
      mustContain: ['质量概览', '待处理会话'],
      referenceImage: null,
    }],
    components: [
      { name: '风险指标卡', usedBy: '质量概览' },
      { name: '会话数据表', usedBy: '质量概览' },
    ],
    dataModel: [{
      entity: 'QualityConversation',
      fields: ['id', 'riskLevel', 'owner', 'status'],
    }],
    interactions: ['按风险等级筛选会话', '批量标记复核完成'],
    acceptance: ['运营人员可以从异常指标下钻到风险会话'],
    scenarios: [{
      name: '筛选高风险会话',
      route: '/',
      steps: [{ action: 'click', target: '高风险' }],
      expectText: '待处理会话',
    }],
  };
}

test('provider retries transient gateway failures', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('gateway timeout', { status: 504, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model: 'stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const provider = createProvider({
    apiKey: 'test-key',
    baseUrl: 'http://stub.local/v1',
    model: 'stub',
    temperature: 0,
    maxNetworkRetries: 1,
    requestTimeoutMs: 1000,
  });
  const result = await provider.chat({ user: 'hello' });

  assert.equal(result.content, 'ok');
  assert.equal(calls, 2);
});

test('provider collects streamed chat completions across SSE chunks', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"model":"stub","choices":[{"delta":{"content":"Hel'));
        controller.enqueue(encoder.encode('lo "}}]}\n\ndata: {"choices":[{"delta":{"content":"world"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const provider = createProvider({
    apiKey: 'test-key',
    baseUrl: 'http://stub.local/v1',
    model: 'stub',
    temperature: 0,
    maxNetworkRetries: 0,
    requestTimeoutMs: 1000,
  });
  const result = await provider.chat({ user: 'hello' });

  assert.equal(requestBody.stream, true);
  assert.equal(result.content, 'Hello world');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2 });
});

test('streaming requests use a longer timeout than non-streaming requests', () => {
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000 }, false), 120_000);
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000 }, true), 600_000);
  assert.equal(resolveRequestTimeout({ requestTimeoutMs: 120_000, streamRequestTimeoutMs: 300_000 }, true), 300_000);
});

test('parseFileBlocks handles the delimiter protocol with tricky content', () => {
  // Content deliberately contains quotes, backslashes, braces, and a JSON blob -
  // exactly what breaks a JSON-string transport but is fine for delimited raw text.
  const out = `=== FILE: index.html
<div id="root"></div>
=== END ===
=== FILE: src/App.jsx
const s = "he said \\"hi\\"";
const re = /\\d+/;
const obj = { a: 1, b: "}" };
=== END ===`;
  const files = parseFileBlocks(out);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'index.html');
  assert.match(files[0].content, /<div id="root">/);
  assert.equal(files[1].path, 'src/App.jsx');
  assert.match(files[1].content, /he said/);
  assert.match(files[1].content, /\{ a: 1, b: "\}" \}/);
});

test('parseFileBlocks strips an outer markdown fence', () => {
  const out = '```\n=== FILE: a.js\nconsole.log(1);\n=== END ===\n```';
  const files = parseFileBlocks(out);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'a.js');
  assert.match(files[0].content, /console\.log\(1\)/);
});

test('parseFileBlocks ignores empty or markerless output', () => {
  assert.equal(parseFileBlocks('just some prose, no markers').length, 0);
  assert.equal(parseFileBlocks('=== FILE: empty.js\n\n=== END ===').length, 0);
});

const okShot = { page: 'Home', route: '/', bytes: 60_000, text: 'x'.repeat(100), file: 'home.png' };

test('review passes only when everything is green', () => {
  const spec = { pages: [{ name: 'Home', route: '/' }] };
  const good = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec });
  assert.equal(good.pass, true);

  const badBuild = review({ install: { exitCode: 0 }, build: { exitCode: 1 }, shots: [okShot], spec });
  assert.equal(badBuild.pass, false);

  const emptyShot = review({
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [{ ...okShot, bytes: 100, text: '' }],
    spec,
  });
  assert.equal(emptyShot.pass, false);

  const missingPage = review({ install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [], spec });
  assert.equal(missingPage.pass, false);
});

test('review gates otherwise-green delivery on the UI quality summary', () => {
  const base = {
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [okShot],
    spec: { pages: [{ name: 'Home', route: '/' }] },
    scenarioResults: [],
    visualResults: [],
  };
  const failure = {
    code: 'HIT_TARGET_TOO_SMALL',
    page: '总览',
    route: '/',
    viewport: 'mobile',
    detail: '筛选 32x32',
    screenshot: 'quality-overview-mobile.png',
  };
  const failed = review({
    ...base,
    uiQuality: { pass: false, failures: [failure] },
  });
  const passed = review({
    ...base,
    uiQuality: { pass: true, failures: [] },
  });

  assert.equal(failed.pass, false);
  assert.deepEqual(
    failed.failed.map((check) => check.name),
    ['UI quality audit passes'],
  );
  assert.deepEqual(failed.uiQuality.failures, [failure]);
  assert.equal(passed.pass, true);
});

test('review requires mapped visual comparisons to meet threshold', () => {
  const spec = {
    pages: [{ name: 'Home', route: '/', referenceImage: 'home.png' }],
  };
  const base = {
    install: { exitCode: 0 },
    build: { exitCode: 0 },
    shots: [okShot],
    spec,
    scenarioResults: [],
  };
  const fail = review({
    ...base,
    visualResults: [{
      page: 'Home',
      referenceImage: 'home.png',
      score: 0.4,
      structure: 0.5,
      color: 0.2,
      threshold: 0.62,
      pass: false,
    }],
  });
  const pass = review({
    ...base,
    visualResults: [{
      page: 'Home',
      referenceImage: 'home.png',
      score: 0.8,
      structure: 0.8,
      color: 0.8,
      threshold: 0.62,
      pass: true,
    }],
  });

  assert.equal(fail.pass, false);
  assert.equal(pass.pass, true);
});

test('review enforces mustContain page content', () => {
  const spec = { pages: [{ name: 'Home', route: '/', mustContain: ['本月支出', '¥'] }] };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 } };

  const good = review({ ...base, shots: [{ ...okShot, text: '本月支出 ¥1234 记一笔' + 'x'.repeat(50) }], spec });
  assert.equal(good.pass, true);

  const missing = review({ ...base, shots: [{ ...okShot, text: 'hello world' + 'x'.repeat(50) }], spec });
  assert.equal(missing.pass, false);
  assert.ok(missing.failed.some((c) => c.name.includes('本月支出')));
});

test('review enforces interaction scenarios', () => {
  const spec = {
    pages: [{ name: 'Home', route: '/' }],
    scenarios: [{ name: 'add expense shows new row', route: '/', steps: [], expectText: '新记录' }],
  };
  const base = { install: { exitCode: 0 }, build: { exitCode: 0 }, shots: [okShot], spec };

  const pass = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: true }] });
  assert.equal(pass.pass, true);

  const fail = review({ ...base, scenarioResults: [{ name: 'add expense shows new row', pass: false, error: 'text not found' }] });
  assert.equal(fail.pass, false);

  const notRun = review({ ...base, scenarioResults: [] });
  assert.equal(notRun.pass, false);
});

test('describeFailure includes build stderr and failed checks', () => {
  const text = describeFailure({
    install: { exitCode: 0 },
    build: { exitCode: 1, stderr: 'SyntaxError: unexpected token' },
    shots: [],
    reviewResult: { failed: [{ name: 'npm run build passes', detail: 'exit=1' }] },
  });
  assert.match(text, /BUILD FAILED/);
  assert.match(text, /SyntaxError/);
  assert.match(text, /REVIEW CHECKS FAILED/);
});

test('describeFailure includes safe structured UI audit evidence only', () => {
  const privateEndpoint = 'https://private.invalid/v1';
  const windowsPath = 'D:\\private\\vibe-secret\\quality-overview-mobile.png';
  const posixPath = '/private/vibe-secret/artifact.txt';
  const failure = {
    code: 'HIT_TARGET_TOO_SMALL',
    page: '总览',
    route: '/',
    viewport: 'mobile',
    detail: [
      '筛选 32x32',
      windowsPath,
      posixPath,
      privateEndpoint,
      'Error: private failure\n    at secret.js:1:1',
      'data:image/png;base64,AAAA',
    ].join(' '),
    screenshot: windowsPath,
  };
  const text = describeFailure({
    reviewResult: {
      failed: [{ name: 'UI quality audit passes', detail: '1 checks failing' }],
      uiQuality: { pass: false, failures: [failure] },
    },
    uiQuality: { summary: { pass: false, failures: [failure] } },
  });

  assert.match(text, /UI QUALITY AUDIT FAILED/);
  assert.match(text, /HIT_TARGET_TOO_SMALL.*总览.*mobile.*筛选 32x32/s);
  assert.match(text, /quality-overview-mobile\.png/);
  assert.doesNotMatch(
    text,
    /private\.invalid|vibe-secret|D:\\|\/private\/|data:image|secret\.js|\n\s*at\s/u,
  );
});

test('gatherSource collects app source and skips scaffold + node_modules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-src-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'node_modules', 'react'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), '{"scaffold":true}');
  await fs.writeFile(path.join(dir, 'src', 'App.jsx'), 'export default function App(){}');
  await fs.writeFile(path.join(dir, 'node_modules', 'react', 'index.js'), 'module.exports={}');

  const out = await gatherSource(dir);
  assert.match(out, /=== FILE: src\/App\.jsx/);
  assert.match(out, /export default function App/);
  assert.doesNotMatch(out, /scaffold/); // package.json excluded
  assert.doesNotMatch(out, /node_modules/); // deps excluded

  await fs.rm(dir, { recursive: true, force: true });
});

test('visual repair content includes diagnostics, reference, and generated screenshot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-visual-fix-'));
  const reference = path.join(root, 'reference.png');
  const actual = path.join(root, 'actual.png');
  await fs.writeFile(reference, ONE_PIXEL_PNG);
  await fs.writeFile(actual, ONE_PIXEL_PNG);

  try {
    const content = await createFixerUserContent({
      round: 1,
      failure: 'visual similarity failed',
      source: '=== FILE: src/App.jsx\nexport default 1\n=== END ===',
      visualFailures: [{
        page: 'Home',
        referenceFile: reference,
        actualFile: actual,
        referenceType: 'image/png',
        score: 0.4,
        threshold: 0.62,
      }],
    });

    assert.equal(content.filter((part) => part.type === 'image_url').length, 2);
    assert.match(content[0].text, /visual similarity failed/);
    assert.match(content[1].text, /Home.*0\.4.*0\.62/s);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('UI repair content includes diagnostics and generated screenshots without reference labels', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ui-fix-'));
  const actual = path.join(root, 'quality-overview-mobile.png');
  await fs.writeFile(actual, ONE_PIXEL_PNG);

  try {
    const content = await createFixerUserContent({
      round: 1,
      failure: 'UI quality audit failed',
      source: '=== FILE: src/App.jsx\nexport default 1\n=== END ===',
      uiFailures: [{
        code: 'HIT_TARGET_TOO_SMALL',
        page: '总览',
        route: '/',
        viewport: 'mobile',
        detail: '筛选 32x32',
        screenshot: 'quality-overview-mobile.png',
        actualFile: actual,
      }],
    });

    assert.equal(content.filter((part) => part.type === 'image_url').length, 1);
    assert.match(content[0].text, /UI quality audit failed/);
    assert.match(content[1].text, /HIT_TARGET_TOO_SMALL.*总览.*mobile.*筛选 32x32/s);
    assert.doesNotMatch(content[1].text, /Reference image follows|vibe-ui-fix-/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('UI repair evidence rejects more than the bounded screenshot count', async () => {
  const failures = Array.from(
    { length: 9 },
    (_, index) => ({ actualFile: `quality-${index}.png` }),
  );
  await assert.rejects(
    validateUiEvidenceFiles(failures),
    (error) => error.code === 'UI_EVIDENCE_LIMIT',
  );
  assert.equal(UI_EVIDENCE_LIMITS.maxFiles, 8);
});

test('UI repair evidence rejects aggregate bytes before reading image content', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ui-evidence-limit-'));
  const files = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const file = path.join(root, `quality-${index}.png`);
      await fs.writeFile(file, '');
      await fs.truncate(file, 6 * 1024 * 1024 + 1);
      files.push({ actualFile: file });
    }
    await assert.rejects(
      validateUiEvidenceFiles(files),
      (error) => error.code === 'UI_EVIDENCE_LIMIT',
    );
    assert.equal(UI_EVIDENCE_LIMITS.maxTotalBytes, 24 * 1024 * 1024);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('delivery report records input references and visual score history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-visual-report-'));
  const privateEndpoint = 'https://private.invalid/v1';
  const privatePath = 'D:\\private\\vibe-secret\\artifact.txt';
  const ctx = {
    runId: 'visual-run',
    runDir: root,
    events: [],
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    async logEvent(type, data) {
      this.events.push({ type, ...data });
    },
  };
  const config = {
    model: 'stub',
    baseUrl: privateEndpoint,
    stack: 'react-vite',
    maxRepairRounds: 1,
    references: [{ name: 'home.png', width: 390, height: 844, type: 'image/png' }],
  };
  const visualHistory = [
    { round: 0, results: [{ page: 'Home', score: 0.54, threshold: 0.62, structure: 0.61, color: 0.3767, pass: false }] },
    { round: 1, results: [{ page: 'Home', score: 0.7812, threshold: 0.62, structure: 0.79, color: 0.7607, pass: true }] },
  ];

  await writeReport(ctx, {
    config,
    spec: { summary: 'Visual app' },
    status: 'success',
    rounds: 1,
    finalReview: { checks: [] },
    shots: [],
    scenarioResults: [],
    visualHistory,
    error: new Error(`upstream ${privateEndpoint} failed at ${privatePath}`),
  });
  const report = await fs.readFile(path.join(root, 'DELIVERY_REPORT.md'), 'utf8');
  const events = JSON.stringify(ctx.events);

  assert.match(report, /## Input references/);
  assert.match(report, /home\.png.*390x844.*image\/png/);
  assert.match(report, /### Round 0[\s\S]*0\.5400 \/ 0\.6200/);
  assert.match(report, /### Round 1[\s\S]*0\.7812 \/ 0\.6200/);
  assert.doesNotMatch(report, /Visual similarity to any reference is not scored/);
  assert.doesNotMatch(report, /private\.invalid|vibe-secret/);
  assert.doesNotMatch(events, /vibe-visual-report-|vibe-secret|private\.invalid/);
  await fs.rm(root, { recursive: true, force: true });
});

test('polish limits and file validation enforce exact bounded safe output', async () => {
  const {
    POLISH_LIMITS,
    validatePolishFiles,
  } = await loadPolisherModule();
  assert.equal(Object.isFrozen(POLISH_LIMITS), true);
  assert.deepEqual(POLISH_LIMITS, {
    maxFiles: 4,
    maxCharacters: 18_000,
    maxRounds: 1,
  });
  const exact = [
    { path: 'src/a.js', content: 'a'.repeat(4_500) },
    { path: 'src/b.js', content: 'b'.repeat(4_500) },
    { path: 'src/c.js', content: 'c'.repeat(4_500) },
    { path: 'src/d.js', content: 'd'.repeat(4_500) },
  ];
  assert.equal(validatePolishFiles(exact, APP), exact);

  for (const files of [
    Array.from({ length: 5 }, (_, index) => ({
      path: `src/${index}.js`,
      content: 'x',
    })),
    [{ path: 'src/large.js', content: 'x'.repeat(18_001) }],
    null,
    [],
    [{ path: '', content: 'x' }],
    [{ path: 'src/a.js', content: null }],
  ]) {
    assert.throws(
      () => validatePolishFiles(files, APP),
      (error) => error.code === 'POLISH_OUTPUT_LIMIT',
    );
  }
});

test('polish file validation reuses the builder path jail', async () => {
  const { validatePolishFiles } = await loadPolisherModule();
  for (const unsafePath of [
    'package.json',
    'package-lock.json',
    'vite.config.js',
    '.env',
    'node_modules/pkg/index.js',
    '../outside.js',
    '/etc/passwd',
    'C:\\Windows\\evil.js',
  ]) {
    assert.throws(
      () => validatePolishFiles([{ path: unsafePath, content: 'x' }], APP),
      (error) => error.code === 'POLISH_OUTPUT_LIMIT',
      unsafePath,
    );
  }
});

test('polish candidate copies trusted source without disposable build caches', async () => {
  const { createPolishCandidate } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-copy-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(ctx.appDir, 'node_modules', 'pkg'), { recursive: true });
    await fs.mkdir(path.join(ctx.appDir, 'DIST'), { recursive: true });
    await fs.mkdir(path.join(ctx.appDir, '.VITE'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    await fs.writeFile(path.join(ctx.appDir, 'package.json'), '{"name":"app"}');
    await fs.writeFile(path.join(ctx.appDir, 'vite.config.js'), 'export default {}');
    await fs.writeFile(path.join(ctx.appDir, 'node_modules', 'pkg', 'index.js'), 'cache');
    await fs.writeFile(path.join(ctx.appDir, 'DIST', 'index.js'), 'build');
    await fs.writeFile(path.join(ctx.appDir, '.VITE', 'meta.json'), 'cache');

    await createPolishCandidate(ctx);
    await fs.writeFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'candidate');

    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'draft');
    assert.equal(await fs.readFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'utf8'), 'candidate');
    assert.equal(await fs.readFile(path.join(ctx.polishCandidateDir, 'package.json'), 'utf8'), '{"name":"app"}');
    assert.equal(await fs.readFile(path.join(ctx.polishCandidateDir, 'vite.config.js'), 'utf8'), 'export default {}');
    for (const disposable of ['node_modules', 'DIST', '.VITE']) {
      await assert.rejects(fs.stat(path.join(ctx.polishCandidateDir, disposable)), { code: 'ENOENT' });
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polish candidate rejects source links before deleting or copying', async () => {
  const { createPolishCandidate } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-link-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    for (const detectedBy of ['dirent', 'lstat']) {
      let removed = false;
      let copied = false;
      const entry = {
        name: 'external-link',
        isDirectory: () => false,
        isSymbolicLink: () => detectedBy === 'dirent',
      };
      const operations = {
        readdir: async () => [entry],
        lstat: async () => ({
          isDirectory: () => false,
          isSymbolicLink: () => detectedBy === 'lstat',
        }),
        rm: async () => { removed = true; },
        cp: async () => { copied = true; },
      };

      await assert.rejects(
        createPolishCandidate(ctx, operations),
        (error) => error.code === 'POLISH_SOURCE_LINK_UNSAFE',
        detectedBy,
      );
      assert.equal(removed, false, detectedBy);
      assert.equal(copied, false, detectedBy);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polish promotion retains the prior app as the owned draft', async () => {
  const {
    createPolishCandidate,
    promotePolishCandidate,
  } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-promote-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    await createPolishCandidate(ctx);
    await fs.writeFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'candidate');
    await fs.mkdir(ctx.draftAppDir, { recursive: true });
    await fs.writeFile(path.join(ctx.draftAppDir, 'stale.txt'), 'stale');

    await promotePolishCandidate(ctx);

    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'candidate');
    assert.equal(await fs.readFile(path.join(ctx.draftAppDir, 'src', 'App.jsx'), 'utf8'), 'draft');
    await assert.rejects(fs.stat(path.join(ctx.draftAppDir, 'stale.txt')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polish promotion with a missing candidate leaves the app untouched', async () => {
  const { promotePolishCandidate } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-missing-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    await fs.rm(ctx.polishCandidateDir, { recursive: true, force: true });

    await assert.rejects(
      promotePolishCandidate(ctx),
      (error) => error.code === 'POLISH_CANDIDATE_MISSING',
    );
    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'draft');
    await assert.rejects(fs.stat(ctx.draftAppDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polish promotion restores the app when candidate promotion fails', async () => {
  const {
    createPolishCandidate,
    promotePolishCandidate,
  } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-rollback-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    await createPolishCandidate(ctx);
    await fs.writeFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'candidate');
    const promotionError = new Error('candidate promotion failed');
    promotionError.code = 'EACCES';
    let renameCalls = 0;

    await assert.rejects(
      promotePolishCandidate(ctx, {
        stat: fs.stat,
        rm: fs.rm,
        async rename(from, to) {
          renameCalls += 1;
          if (renameCalls === 2) throw promotionError;
          return fs.rename(from, to);
        },
      }),
      (error) => error === promotionError,
    );

    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'draft');
    assert.equal(
      await fs.readFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'utf8'),
      'candidate',
    );
    await assert.rejects(fs.stat(ctx.draftAppDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('polish promotion reports a sanitized recovery error when rollback also fails', async () => {
  const {
    createPolishCandidate,
    promotePolishCandidate,
  } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-rollback-fail-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    await createPolishCandidate(ctx);
    await fs.writeFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'candidate');
    const promotionDetail = 'candidate failed at ' + ctx.appDir;
    const rollbackDetail = 'rollback failed at ' + ctx.draftAppDir;
    let renameCalls = 0;

    await assert.rejects(
      promotePolishCandidate(ctx, {
        stat: fs.stat,
        rm: fs.rm,
        async rename(from, to) {
          renameCalls += 1;
          if (renameCalls === 1) return fs.rename(from, to);
          if (renameCalls === 2) throw new Error(promotionDetail);
          throw new Error(rollbackDetail);
        },
      }),
      (error) => {
        assert.equal(error.code, 'POLISH_ROLLBACK_FAILED');
        assert.match(error.message, /draft retained.*recovery required/i);
        assert.equal(error.message.includes(root), false);
        assert.equal(error.message.includes(promotionDetail), false);
        assert.equal(error.message.includes(rollbackDetail), false);
        assert.equal(error.draftRetained, true);
        assert.equal(error.recoveryRequired, true);
        return true;
      },
    );

    assert.equal(
      await fs.readFile(path.join(ctx.draftAppDir, 'src', 'App.jsx'), 'utf8'),
      'draft',
    );
    assert.equal(
      await fs.readFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'utf8'),
      'candidate',
    );
    await assert.rejects(fs.stat(ctx.appDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('single-pass polisher applies bounded UI-only files to an isolated candidate', async () => {
  const { POLISHER_SYSTEM, polish } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-pass-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  const calls = [];
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'export default function App(){return draft}');
    await fs.writeFile(path.join(ctx.appDir, 'src', 'styles.css'), '.app{padding:8px}');
    await fs.writeFile(path.join(ctx.appDir, 'package.json'), '{private:true}');
    for (const filename of ['quality-overview-desktop.png', 'quality-overview-mobile.png']) {
      await fs.writeFile(path.join(ctx.qualityDir, filename), ONE_PIXEL_PNG);
    }
    const privateEndpoint = 'https://private.invalid/v1';
    const privatePath = 'D:\\private\\vibe-secret\\quality.png';
    await fs.writeFile(
      path.join(ctx.appDir, 'src', 'private.js'),
      `export const endpoint = '${privateEndpoint}';\nexport const file = '${privatePath}';`,
    );
    const evidence = {
      spec: {
        ...productPlanFixture(),
        baseUrl: privateEndpoint,
        apiKey: 'session-secret',
        productDesign: { ...PRODUCT_DESIGN, endpoint: privateEndpoint },
      },
      uiQuality: {
        summary: {
          pass: false,
          failures: [{
            code: 'DENSITY_TOO_LOW',
            page: '质量概览',
            route: '/',
            viewport: 'desktop',
            detail: `cards are sparse ${privateEndpoint} ${privatePath} Error: hidden\n    at secret.js:1:1`,
            screenshot: privatePath,
            actualFile: privatePath,
            stack: 'Error: hidden at secret.js:1:1',
          }],
        },
      },
      visualResults: [{
        page: '质量概览',
        score: 0.51,
        threshold: 0.62,
        structure: 0.58,
        color: 0.42,
        pass: false,
        referenceImage: 'D:\\private\\reference-home.png',
        actualFile: privatePath,
      }],
      screenshots: [
        'quality-overview-desktop.png',
        { filename: 'quality-overview-mobile.png' },
        { filename: 'quality-overview-desktop.png' },
      ],
    };
    const provider = {
      async chat(request) {
        calls.push(request);
        return {
          content: [
            '=== FILE: src/App.jsx',
            'export default function App(){return polished}',
            '=== END ===',
            '=== FILE: src/styles.css',
            '.app{padding:16px}',
            '=== END ===',
          ].join('\n'),
          usage: { prompt_tokens: 7, completion_tokens: 9 },
        };
      },
    };

    const changed = await polish(ctx, provider, evidence);
    const textPart = calls[0].user.find((part) => part.type === 'text').text;
    const imageParts = calls[0].user.filter((part) => part.type === 'image_url');

    assert.deepEqual(changed, ['src/App.jsx', 'src/styles.css']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].system, POLISHER_SYSTEM);
    assert.match(POLISHER_SYSTEM, /hierarchy.*typography.*spacing.*density.*component consistency.*state presentation.*responsive/is);
    assert.match(POLISHER_SYSTEM, /Do not add features\/routes\/dependencies\/network\/backend/);
    assert.match(POLISHER_SYSTEM, /at most 4 files.*18,000 characters/is);
    assert.match(textPart, /Approved spec.*Product Design/is);
    assert.match(textPart, /数据密集型 B2B SaaS/);
    assert.match(textPart, /Current model-authored source.*src\/App\.jsx.*draft/is);
    assert.match(textPart, /quality-overview-desktop\.png.*quality-overview-mobile\.png/is);
    assert.match(textPart, /DENSITY_TOO_LOW.*质量概览.*desktop.*cards are sparse/is);
    assert.match(textPart, /score.*0\.51.*threshold.*0\.62/is);
    assert.match(textPart, /reference-home\.png/);
    assert.doesNotMatch(textPart, /private\.invalid|vibe-secret|session-secret|data:image|base64|secret\.js|Error: hidden/);
    assert.equal(imageParts.length, 2);
    assert.ok(imageParts.every((part) => /^data:image\/png;base64,/.test(part.image_url.url)));
    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'export default function App(){return draft}');
    assert.equal(await fs.readFile(path.join(ctx.polishCandidateDir, 'src', 'App.jsx'), 'utf8'), 'export default function App(){return polished}\n');
    assert.equal(await fs.readFile(path.join(ctx.polishCandidateDir, 'src', 'styles.css'), 'utf8'), '.app{padding:16px}\n');
    assert.equal(ctx.usage.promptTokens, 7);
    assert.equal(ctx.usage.completionTokens, 9);
    assert.equal(ctx.usage.calls, 1);
    assert.deepEqual(ctx.events.map((event) => event.type), ['polish:start', 'polish:applied']);
    assert.deepEqual(ctx.events.map((event) => event.summary), [
      'applying one bounded UI polish pass',
      '2 files applied to isolated candidate',
    ]);
    assert.doesNotMatch(JSON.stringify(ctx.events), /private\.invalid|vibe-secret|session-secret|base64|src\/App/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('single-pass polisher rejects invalid model output before candidate writes', async () => {
  const { polish } = await loadPolisherModule();
  const cases = [
    ['no files', 'not a file response', 'POLISH_OUTPUT_INVALID'],
    ['forbidden file', '=== FILE: package.json\n{}\n=== END ===', 'POLISH_OUTPUT_LIMIT'],
    ['too many files', Array.from({ length: 5 }, (_, index) => `=== FILE: src/${index}.js\nx\n=== END ===`).join('\n'), 'POLISH_OUTPUT_LIMIT'],
    ['too many characters', `=== FILE: src/App.jsx\n${'x'.repeat(18_001)}\n=== END ===`, 'POLISH_OUTPUT_LIMIT'],
  ];

  for (const [name, content, code] of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-invalid-'));
    const ctx = await createRunContext(path.join(root, 'target'), {
      runsRoot: path.join(root, 'runs'),
    });
    try {
      await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
      let calls = 0;
      await assert.rejects(
        polish(ctx, {
          async chat() {
            calls += 1;
            return { content, usage: {} };
          },
        }, { spec: productPlanFixture(), uiQuality: { pass: true }, screenshots: [] }),
        (error) => error.code === code,
        name,
      );
      assert.equal(calls, 1, name);
      assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'draft', name);
      assert.deepEqual(await fs.readdir(ctx.polishCandidateDir), [], name);
      assert.deepEqual(ctx.events.map((event) => event.type), ['polish:start'], name);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('single-pass polisher propagates provider failure without success evidence', async () => {
  const { polish } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-provider-fail-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    const providerError = new Error('provider unavailable');

    await assert.rejects(
      polish(ctx, { chat: async () => { throw providerError; } }, {
        spec: productPlanFixture(),
        uiQuality: { pass: true },
      }),
      (error) => error === providerError,
    );

    assert.deepEqual(ctx.events.map((event) => event.type), ['polish:start']);
    assert.equal(ctx.usage.calls, 0);
    assert.equal(await fs.readFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'utf8'), 'draft');
    assert.deepEqual(await fs.readdir(ctx.polishCandidateDir), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('single-pass polisher rejects screenshot paths outside owned evidence directories', async () => {
  const { polish } = await loadPolisherModule();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-evidence-jail-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  let calls = 0;
  try {
    await fs.mkdir(path.join(ctx.appDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(ctx.appDir, 'src', 'App.jsx'), 'draft');
    for (const filename of ['../outside.png', 'D:\\private\\outside.png', '/private/outside.png']) {
      await assert.rejects(
        polish(ctx, { chat: async () => { calls += 1; } }, {
          spec: productPlanFixture(),
          uiQuality: { pass: true },
          screenshots: [filename],
        }),
        (error) => error.code === 'POLISH_EVIDENCE_INVALID',
        filename,
      );
    }
    assert.equal(calls, 0);
    assert.deepEqual(ctx.events.map((event) => event.type), [
      'polish:start',
      'polish:start',
      'polish:start',
    ]);
    assert.deepEqual(await fs.readdir(ctx.polishCandidateDir), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run context exposes owned quality and polish paths without precreating the draft', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-context-'));
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
  });
  try {
    assert.equal((await fs.stat(ctx.qualityDir)).isDirectory(), true);
    assert.equal((await fs.stat(ctx.polishDir)).isDirectory(), true);
    assert.equal((await fs.stat(ctx.polishCandidateDir)).isDirectory(), true);
    await assert.rejects(fs.stat(ctx.draftAppDir), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('config fixes polish rounds to one and rejects external expansion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-polish-config-'));
  const inputDir = path.join(root, 'input');
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'brief.md'), '# Demo');
  try {
    const defaults = await loadConfig(root, { apiKey: 'session-secret' });
    assert.equal(defaults.maxPolishRounds, 1);
    await fs.writeFile(
      path.join(inputDir, 'constraints.json'),
      JSON.stringify({ maxPolishRounds: 1 }),
    );
    assert.equal(
      (await loadConfig(root, { apiKey: 'session-secret' })).maxPolishRounds,
      1,
    );
    for (const invalid of [0, 2, -1, '1']) {
      await fs.writeFile(
        path.join(inputDir, 'constraints.json'),
        JSON.stringify({ maxPolishRounds: invalid }),
      );
      await assert.rejects(
        loadConfig(root, { apiKey: 'session-secret' }),
        (error) => error.code === 'CONFIG_INVALID',
      );
    }
    assert.doesNotMatch(
      await fs.readFile(path.join(inputDir, 'constraints.json'), 'utf8'),
      /session-secret/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('run context mirrors persisted events to an optional listener', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-events-'));
  const seen = [];
  const ctx = await createRunContext(path.join(root, 'target'), {
    runsRoot: path.join(root, 'runs'),
    onEvent: (event) => seen.push(event),
  });

  await ctx.logEvent('plan:start', { summary: 'planning' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'plan:start');
  const persisted = await fs.readFile(path.join(ctx.logsDir, 'events.jsonl'), 'utf8');
  assert.match(persisted, /"type":"plan:start"/);
  await fs.rm(root, { recursive: true, force: true });
});

test('run context copies reference evidence into the run directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-run-reference-'));
  const targetDir = path.join(root, 'target');
  const inputDir = path.join(targetDir, 'input');
  const referencesDir = path.join(inputDir, 'references');
  await fs.mkdir(referencesDir, { recursive: true });
  await fs.writeFile(path.join(referencesDir, 'home.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(referencesDir, 'manifest.json'),
    JSON.stringify([{
      name: 'home.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );

  const ctx = await createRunContext(targetDir, {
    runsRoot: path.join(root, 'runs'),
    inputDir,
  });

  assert.deepEqual(await fs.readFile(path.join(ctx.referencesDir, 'home.png')), ONE_PIXEL_PNG);
  assert.equal((await fs.stat(ctx.visualDir)).isDirectory(), true);
  await fs.rm(root, { recursive: true, force: true });
});

test('loadConfig accepts an in-memory API key without persisting it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-config-'));
  await fs.mkdir(path.join(root, 'input'), { recursive: true });
  await fs.writeFile(path.join(root, 'input', 'brief.md'), '# Demo');

  const config = await loadConfig(root, { apiKey: 'session-secret' });

  assert.equal(config.apiKey, 'session-secret');
  assert.doesNotMatch(await fs.readFile(path.join(root, 'input', 'brief.md'), 'utf8'), /session-secret/);
  await fs.rm(root, { recursive: true, force: true });
});

test('reference images validate magic bytes, dimensions, names, and limits', () => {
  const refs = normalizeReferencePayloads([{
    name: '../Home Screen.PNG',
    type: 'image/png',
    width: 1,
    height: 1,
    base64: ONE_PIXEL_PNG.toString('base64'),
  }]);
  assert.deepEqual(refs.map(({ name, type, width, height }) => ({ name, type, width, height })), [{
    name: 'home-screen.png', type: 'image/png', width: 1, height: 1,
  }]);
  assert.throws(
    () => normalizeReferencePayloads([{
      name: 'bad.png',
      type: 'image/png',
      width: 1,
      height: 1,
      base64: Buffer.from('not-png').toString('base64'),
    }]),
    /REFERENCE_INVALID/,
  );
  assert.throws(
    () => normalizeReferencePayloads(Array.from(
      { length: REFERENCE_LIMITS.maxFiles + 1 },
      (_, i) => ({
        name: `${i}.png`,
        type: 'image/png',
        width: 1,
        height: 1,
        base64: ONE_PIXEL_PNG.toString('base64'),
      }),
    )),
    /REFERENCE_COUNT_EXCEEDED/,
  );
});

test('reference images persist and loadConfig accepts screenshot-only input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-reference-'));
  await fs.mkdir(path.join(root, 'input'), { recursive: true });
  const refs = normalizeReferencePayloads([{
    name: 'home.png',
    type: 'image/png',
    width: 1,
    height: 1,
    base64: ONE_PIXEL_PNG.toString('base64'),
  }]);
  await writeReferencePayloads(path.join(root, 'input'), refs);
  const discovered = await discoverReferenceImages(path.join(root, 'input'));
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].name, 'home.png');
  const config = await loadConfig(root, { apiKey: 'session-secret' });
  assert.equal(config.brief, '');
  assert.equal(config.references.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('reference discovery rejects manifest paths outside the references directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-reference-jail-'));
  const inputDir = path.join(root, 'input');
  const referencesDir = path.join(inputDir, 'references');
  await fs.mkdir(referencesDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, 'outside.png'), ONE_PIXEL_PNG);
  await fs.writeFile(
    path.join(referencesDir, 'manifest.json'),
    JSON.stringify([{
      name: '../outside.png',
      type: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG.length,
    }]),
  );

  await assert.rejects(discoverReferenceImages(inputDir), /REFERENCE_PATH_INVALID/);
  await fs.rm(root, { recursive: true, force: true });
});
