const TIMELINE = [
  { key: 'design', label: '设计规格', event: (type) => type.startsWith('plan:') || type === 'design:done' },
  { key: 'draft', label: '生成初稿', event: (type) => type === 'build:start' },
  { key: 'build', label: '构建验证', event: (type) => type === 'build:done' || type.startsWith('cmd:') || type.startsWith('preview:') },
  { key: 'functional', label: '功能验收', event: (type) => type === 'scenario' || type === 'review' },
  { key: 'quality', label: 'UI 质量', event: (type) => type.startsWith('quality:') },
  { key: 'visual', label: '视觉验收', event: (type) => type.startsWith('visual:') },
  { key: 'polish', label: '成品抛光', event: (type) => type.startsWith('polish:') },
  { key: 'delivery', label: '交付完成', event: (type) => type === 'report:written' },
];

export function renderStudioTimeline(list, { job, events = [], activeStage }) {
  list.replaceChildren();
  const reached = new Set();
  for (const event of events) {
    for (const stage of TIMELINE) if (stage.event(String(event.type || ''))) reached.add(stage.key);
  }
  if (job?.status === 'success' || job?.status === 'planned') reached.add('delivery');
  const active = mapActiveStage(activeStage, reached);
  for (const [index, stage] of TIMELINE.entries()) {
    const item = document.createElement('li');
    item.dataset.stage = stage.key;
    const done = reached.has(stage.key);
    const failed = job?.status === 'failed' && stage.key === active;
    item.className = failed ? 'failed' : done ? 'done' : stage.key === active && !job?.terminal ? 'active' : '';
    const marker = document.createElement('span');
    marker.className = 'timeline-marker';
    marker.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'timeline-copy';
    const label = document.createElement('strong');
    label.textContent = stage.label;
    const status = document.createElement('small');
    status.textContent = failed ? '失败' : done ? '已完成' : stage.key === active && !job?.terminal ? '进行中' : '等待';
    copy.append(label, status);
    item.append(marker, copy);
    list.append(item);
  }
}

export function renderStudioInspector({ productContainer, designContainer, qualityContainer, design, quality, job }) {
  renderProduct(productContainer, design, job);
  renderDesign(designContainer, design);
  renderQuality(qualityContainer, quality, job);
}

function renderProduct(container, design, job) {
  container.replaceChildren();
  const summary = design?.available ? design.summary : null;
  container.append(section('产品目标', summary || `${job?.title || '当前产品'}的批准规格将在规划完成后显示。`));
  const pages = design?.pages || [];
  container.append(listSection('页面与场景', [
    ...pages.map((page) => `${page.name || page.route} · ${page.purpose || page.route}`),
    ...(design?.scenarios || []).map((scenario) => `${scenario.name} · ${scenario.expectText || '交互验收'}`),
  ], '还没有可用的页面与场景规格。'));
  container.append(listSection('Acceptance Criteria', design?.acceptance || [], '规划完成后显示验收标准。'));
}

function renderDesign(container, design) {
  container.replaceChildren();
  const productDesign = design?.productDesign || {};
  container.append(section('产品类型', productDesign.productType || '等待设计规格'));
  container.append(section('目标用户', toText(productDesign.targetUsers) || '等待设计规格'));
  container.append(section('视觉语气', productDesign.tone || '等待设计规格'));
  container.append(section('信息密度与导航', [productDesign.density, productDesign.navigation].filter(Boolean).join(' · ') || '等待设计规格'));
  const tokens = productDesign.tokens || {};
  container.append(listSection('Design Tokens', [
    ...Object.entries(tokens.colors || {}).map(([name, value]) => `${name}: ${value}`),
    ...Object.entries(tokens.typography || {}).map(([name, value]) => `${name}: ${value}`),
  ], '颜色与字体 token 将在规划完成后显示。'));
}

function renderQuality(container, quality, job) {
  container.replaceChildren();
  container.append(listSection('确定性完成度门槛', [
    '交互目标最小 44px',
    '普通文本 WCAG AA 4.5:1',
    '桌面与移动端无横向溢出',
    'loading / empty / error / success 状态可复现',
  ]));
  const terminal = quality?.terminal;
  const failures = terminal?.failures || [];
  const status = terminal ? (terminal.pass ? '最终 UI audit 已通过' : '最终 UI audit 未通过') : job?.terminal ? '没有可用的 UI audit 证据' : '等待 UI audit';
  container.append(section('当前结论', status));
  container.append(listSection('失败上下文', failures.map((failure) => [failure.page, failure.viewport, failure.code].filter(Boolean).join(' · ')), '当前没有失败项。'));
}

function mapActiveStage(stage, reached) {
  const mapping = { planning: 'design', building: 'draft', verifying: 'functional', visual: 'visual', repairing: 'quality', success: 'delivery', planned: 'delivery', failed: [...reached].at(-1) || 'design' };
  return mapping[stage] || 'design';
}

function section(title, value) {
  const block = document.createElement('section');
  block.className = 'inspector-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = value;
  block.append(heading, copy);
  return block;
}

function listSection(title, values, empty = '暂无内容。') {
  const block = document.createElement('section');
  block.className = 'inspector-block';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ul');
  const items = values.length ? values : [empty];
  for (const value of items) {
    const item = document.createElement('li');
    item.textContent = value;
    list.append(item);
  }
  block.append(heading, list);
  return block;
}

function toText(value) {
  return Array.isArray(value) ? value.join('、') : String(value || '');
}
