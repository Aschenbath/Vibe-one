import { STATUS_COPY, ERROR_COPY, EVENT_COPY } from './copy.js';
import { createReferenceInputController } from './reference-input.js';
import { createStudioState, reduceStudio, deriveStudioStage } from './studio-state.js';

let state = {
  ...createStudioState(),
  status: null,
  jobs: [],
  eventSource: null,
  activeEvidenceTab: 'preview',
  previewJobId: null,
  toastTimer: null,
  visualRequestSequence: 0,
};

function dispatch(action) {
  state = reduceStudio(state, action);
  return state;
}

const elements = {
  form: document.querySelector('#run-form'),
  title: document.querySelector('#title'),
  brief: document.querySelector('#brief'),
  briefCount: document.querySelector('#brief-count'),
  productGoal: document.querySelector('#product-goal'),
  targetUsers: document.querySelector('#target-users'),
  coreFlows: [...document.querySelectorAll('[id^="core-flow-"]')],
  visualDirection: document.querySelector('#visual-direction'),
  presetButtons: [...document.querySelectorAll('[data-preset]')],
  baseUrl: document.querySelector('#base-url'),
  model: document.querySelector('#model'),
  apiKey: document.querySelector('#api-key'),
  keyHint: document.querySelector('#key-hint'),
  clearKey: document.querySelector('#clear-key'),
  launchRun: document.querySelector('#launch-run'),
  newRun: document.querySelector('#new-run'),
  formMessage: document.querySelector('#form-message'),
  referenceInput: document.querySelector('#reference-input'),
  referenceTrigger: document.querySelector('#reference-trigger'),
  referenceDropzone: document.querySelector('#reference-dropzone'),
  referenceList: document.querySelector('#reference-list'),
  runHistory: document.querySelector('#run-history'),
  historyCount: document.querySelector('#history-count'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  workspaceTitle: document.querySelector('#workspace-title'),
  activeStatus: document.querySelector('#active-status'),
  modelReadout: document.querySelector('#model-readout'),
  composerPane: document.querySelector('#focus-workspace'),
  runMonitor: document.querySelector('#flow-workspace'),
  runTitle: document.querySelector('#run-title'),
  runMode: document.querySelector('#run-mode'),
  runStarted: document.querySelector('#run-started'),
  runRepairs: document.querySelector('#run-repairs'),
  stageTrack: document.querySelector('#stage-track'),
  eventLog: document.querySelector('#event-log'),
  liveLabel: document.querySelector('#live-label'),
  evidenceTitle: document.querySelector('#evidence-title'),
  refreshEvidence: document.querySelector('#refresh-evidence'),
  tabs: [...document.querySelectorAll('[data-tab]')],
  panels: [...document.querySelectorAll('[data-panel]')],
  shotCount: document.querySelector('#shot-count'),
  repairCount: document.querySelector('#repair-count'),
  previewLabel: document.querySelector('#preview-label'),
  launchPreview: document.querySelector('#launch-preview'),
  previewEmpty: document.querySelector('#preview-empty'),
  previewFrame: document.querySelector('#preview-frame'),
  screenshotsGrid: document.querySelector('#screenshots-grid'),
  referenceEvidence: document.querySelector('#reference-evidence'),
  visualComparisons: document.querySelector('#visual-comparisons'),
  reportContent: document.querySelector('#report-content'),
  repairList: document.querySelector('#repair-list'),
  imageDialog: document.querySelector('#image-dialog'),
  dialogImage: document.querySelector('#dialog-image'),
  dialogCaption: document.querySelector('#dialog-caption'),
  toast: document.querySelector('#toast'),
  settingsTrigger: document.querySelector('#settings-trigger'),
  settingsDrawer: document.querySelector('#settings-drawer'),
  historyToggle: document.querySelector('#history-toggle'),
  historyPanel: document.querySelector('#history-panel'),
};

const referenceInput = createReferenceInputController({
  input: elements.referenceInput,
  trigger: elements.referenceTrigger,
  dropzone: elements.referenceDropzone,
  list: elements.referenceList,
  onChange: () => {
    updateBriefCount();
    renderStatus();
  },
  showError,
});

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(ERROR_COPY[body.error?.code] || ERROR_COPY.INTERNAL_ERROR);
  return body;
}

async function boot() {
  bindEvents();
  updateBriefCount();
  try {
    await Promise.all([loadStatus(), loadJobs()]);
    setConnection(true);
    if (state.status.activeJobId) await selectJob(state.status.activeJobId);
  } catch (error) {
    setConnection(false);
    showError(error.message);
  }
  render();
}

async function loadStatus() {
  state.status = await api('/api/status');
  if (!elements.baseUrl.value) elements.baseUrl.value = state.status.baseUrl;
  if (!elements.model.value) elements.model.value = state.status.model;
}

async function loadJobs() {
  const result = await api('/api/jobs');
  state.jobs = result.jobs || [];
}

async function saveSession() {
  const payload = {
    baseUrl: elements.baseUrl.value.trim(),
    model: elements.model.value.trim(),
  };
  const key = elements.apiKey.value.trim();
  if (key) payload.apiKey = key;
  state.status = await api('/api/session/config', { method: 'POST', body: JSON.stringify(payload) });
  elements.apiKey.value = '';
  renderStatus();
}

async function clearSessionKey() {
  state.status = await api('/api/session/config', { method: 'POST', body: JSON.stringify({ apiKey: '' }) });
  elements.apiKey.value = '';
  renderStatus();
  showToast(state.status.hasApiKey ? '会话 Key 已清除，环境变量中的 Key 仍可使用。' : '会话 Key 已清除。');
}

async function launchJob() {
  clearError();
  setFormBusy(true);
  try {
    await saveSession();
    await referenceInput.ready();
    const brief = composeBrief();
    if (brief.length > 100_000) throw new Error('产品任务书不能超过 100,000 个字符。');
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        title: elements.title.value,
        brief,
        references: await referenceInput.payload(),
        mode: document.querySelector('input[name="mode"]:checked').value,
        baseUrl: elements.baseUrl.value.trim(),
        model: elements.model.value.trim(),
      }),
    });
    dispatch({ type: 'JOB_STARTED', runId: job.id });
    state.jobs = [job, ...state.jobs.filter((item) => item.id !== job.id)];
    await selectJob(job.id);
    await loadStatus();
  } catch (error) {
    showError(error.message);
  } finally {
    setFormBusy(false);
    render();
  }
}

function connectEvents(id) {
  state.eventSource?.close();
  const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.eventSource = source;
  elements.liveLabel.classList.add('streaming');
  elements.liveLabel.lastChild.textContent = ' 实时';

  source.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    dispatch({ type: 'JOB_UPDATED', job: payload.job });
    if (payload.event) dispatch({ type: 'EVENT_RECEIVED', event: payload.event });
    upsertJob(payload.job);
    render();
    if (payload.job.terminal) {
      source.close();
      elements.liveLabel.classList.remove('streaming');
      elements.liveLabel.lastChild.textContent = ' 已完成';
      refreshSelectedJob();
    }
  };
  source.onerror = () => {
    elements.liveLabel.classList.remove('streaming');
    elements.liveLabel.lastChild.textContent = state.selectedJob?.terminal ? ' 已完成' : ' 正在重连';
  };
}

async function selectJob(id) {
  const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
  dispatch({ type: 'JOB_SELECTED', job });
  dispatch({ type: 'EVENTS_REPLAYED', events: job.events || [] });
  state.previewJobId = null;
  setWorkspaceView(state.mode);
  elements.previewFrame.src = 'about:blank';
  elements.previewFrame.hidden = true;
  elements.previewEmpty.hidden = false;
  upsertJob(job);
  render();
  loadActiveEvidence(job);
  if (!job.terminal) connectEvents(id);
}

async function refreshSelectedJob() {
  if (!state.selectedJob) return;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}`);
    dispatch({ type: 'JOB_UPDATED', job });
    dispatch({ type: 'EVENTS_REPLAYED', events: job.events || [] });
    upsertJob(job);
    render();
    loadActiveEvidence(job);
    if (state.activeEvidenceTab === 'report' && job.hasReport) await loadReport();
  } catch (error) {
    showToast(error.message);
  }
}

async function launchPreview() {
  if (!state.selectedJob) return;
  elements.launchPreview.disabled = true;
  elements.launchPreview.textContent = '正在启动…';
  try {
    const preview = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}/preview`, { method: 'POST' });
    elements.previewFrame.src = preview.url;
    elements.previewFrame.hidden = false;
    elements.previewEmpty.hidden = true;
    state.previewJobId = state.selectedJob.id;
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.launchPreview.textContent = state.previewJobId === state.selectedJob.id ? '重新启动预览' : '启动预览';
    elements.launchPreview.disabled = !state.selectedJob.previewEligible;
  }
}

async function loadReport() {
  if (!state.selectedJob?.hasReport) {
    elements.reportContent.textContent = '当前任务没有可用的交付报告。';
    return;
  }
  elements.reportContent.textContent = '正在加载交付报告…';
  try {
    elements.reportContent.textContent = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}/report`);
  } catch (error) {
    elements.reportContent.textContent = error.message;
  }
}

function bindEvents() {
  elements.form.addEventListener('submit', (event) => {
    event.preventDefault();
    launchJob();
  });
  elements.clearKey.addEventListener('click', () => clearSessionKey().catch((error) => showError(error.message)));
  elements.newRun.addEventListener('click', resetComposer);
  elements.brief.addEventListener('input', () => {
    updateBriefCount();
    renderStatus();
  });
  for (const input of [elements.productGoal, elements.targetUsers, ...elements.coreFlows, elements.visualDirection]) {
    input.addEventListener('input', () => {
      updateBriefCount();
      renderStatus();
    });
  }
  for (const button of elements.presetButtons) {
    button.addEventListener('click', () => applyPreset(button.dataset.preset));
  }
  elements.apiKey.addEventListener('input', renderStatus);
  elements.refreshEvidence.addEventListener('click', refreshSelectedJob);
  elements.launchPreview.addEventListener('click', launchPreview);
  elements.settingsTrigger.addEventListener('click', () => elements.settingsDrawer.showModal());
  elements.historyToggle.addEventListener('click', () => {
    const expanded = elements.historyToggle.getAttribute('aria-expanded') === 'true';
    elements.historyToggle.setAttribute('aria-expanded', String(!expanded));
    elements.historyPanel.hidden = expanded;
    elements.historyToggle.textContent = expanded ? '展开历史' : '收起历史';
  });
  for (const tab of elements.tabs) tab.addEventListener('click', () => activateTab(tab.dataset.tab));
}

function resetComposer() {
  state.eventSource?.close();
  dispatch({ type: 'WORKSPACE_FOCUSED' });
  state.previewJobId = null;
  referenceInput.clear();
  elements.form.reset();
  updateBriefCount();
  clearError();
  setWorkspaceView(state.mode);
  render();
  elements.brief.focus();
}

function activateTab(name) {
  state.activeEvidenceTab = name;
  for (const tab of elements.tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  for (const panel of elements.panels) {
    const active = panel.dataset.panel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  }
  if (name === 'report') loadReport();
  if (state.selectedJob && name === 'references') loadReferenceEvidence(state.selectedJob);
  if (state.selectedJob && name === 'visual') loadVisualEvidence(state.selectedJob).catch((error) => showToast(error.message));
}

function loadActiveEvidence(job) {
  if (state.activeEvidenceTab === 'references') loadReferenceEvidence(job);
  if (state.activeEvidenceTab === 'visual') loadVisualEvidence(job).catch((error) => showToast(error.message));
}

function loadReferenceEvidence(job) {
  renderReferenceEvidence(
    job.references || [],
    (name) => `/api/jobs/${encodeURIComponent(job.id)}/references/${encodeURIComponent(name)}`,
  );
}

async function loadVisualEvidence(job) {
  const requestSequence = ++state.visualRequestSequence;
  elements.visualComparisons.replaceChildren(createElement('p', 'panel-empty', '正在加载视觉证据…'));
  try {
    const history = await api(`/api/jobs/${encodeURIComponent(job.id)}/visual`);
    if (requestSequence !== state.visualRequestSequence || state.selectedJob?.id !== job.id) return;
    renderVisualComparisons(history, job.id);
  } catch (error) {
    if (requestSequence === state.visualRequestSequence && state.selectedJob?.id === job.id) {
      elements.visualComparisons.replaceChildren(createElement('p', 'panel-empty', '视觉证据加载失败。'));
    }
    throw error;
  }
}

function renderReferenceEvidence(references, imageUrl) {
  elements.referenceEvidence.replaceChildren();
  for (const reference of references) {
    const name = typeof reference === 'string' ? reference : reference.name;
    const card = createElement('article', 'reference-card');
    const image = document.createElement('img');
    image.src = imageUrl(name);
    image.alt = `参考图：${name}`;
    const details = typeof reference === 'string' ? name : `${name} · ${reference.width}×${reference.height}`;
    card.append(image, createElement('p', '', details));
    elements.referenceEvidence.append(card);
  }
}

function renderVisualComparisons(history, jobId) {
  elements.visualComparisons.replaceChildren();
  for (const round of [...history].sort((a, b) => b.round - a.round)) {
    const group = createElement('section', 'visual-round');
    group.append(createElement('h3', '', `第 ${round.round + 1} 轮`));
    for (const result of round.results || []) {
      const score = Number(result.score).toFixed(2);
      const card = createElement('article', 'visual-comparison');
      card.setAttribute('aria-label', `${result.page} 视觉一致性 ${score}`);
      card.append(
        createElement('h4', '', result.page),
        createElement('strong', result.pass ? 'pass' : 'fail', result.pass ? '通过' : '未通过'),
      );
      const images = createElement('div', 'comparison-images');
      images.append(
        evidenceImage(`/api/jobs/${encodeURIComponent(jobId)}/references/${encodeURIComponent(result.referenceImage)}`, `${result.page} 参考图`),
        evidenceImage(`/api/jobs/${encodeURIComponent(jobId)}/screenshots/${encodeURIComponent(result.actualImage)}`, `${result.page} 生成结果`),
      );
      card.append(
        images,
        createElement('p', 'comparison-score', `一致性 ${score}`),
        createElement('p', 'comparison-metrics', `结构 ${Number(result.structure).toFixed(2)} · 颜色 ${Number(result.color).toFixed(2)} · 阈值 ${Number(result.threshold).toFixed(2)}`),
      );
      group.append(card);
    }
    elements.visualComparisons.append(group);
  }
}

function evidenceImage(src, alt) {
  const image = document.createElement('img');
  image.src = src;
  image.alt = alt;
  image.loading = 'lazy';
  return image;
}

function render() {
  renderStatus();
  renderHistory();
  renderJob();
  renderEvidence();
}

function renderStatus() {
  const job = state.selectedJob;
  const active = state.status?.activeJobId;
  const status = job?.status || (active ? 'running' : 'ready');
  elements.activeStatus.textContent = STATUS_COPY[status] || (active ? '运行中' : '就绪');
  elements.activeStatus.className = `status-chip ${statusClass(status)}`;
  elements.modelReadout.textContent = job?.model || state.status?.model || '尚未配置模型';
  elements.keyHint.textContent = state.status?.hasApiKey ? '本次会话可用' : '未配置';
  const hasKey = Boolean(elements.apiKey.value.trim() || state.status?.hasApiKey);
  elements.launchRun.disabled = Boolean(active)
    || (!composeBrief().trim() && !referenceInput.count())
    || !hasKey;
}

function composeBrief() {
  const flows = elements.coreFlows.map((input) => input.value.trim()).filter(Boolean);
  const storyboard = referenceInput.storyboard();
  const sections = [
    ['产品目标', elements.productGoal.value],
    ['目标用户', elements.targetUsers.value],
    ['核心流程', flows.map((flow, index) => `${index + 1}. ${flow}`).join('\n')],
    ['视觉方向', elements.visualDirection.value],
    ['参考图 Storyboard', storyboard.map((item, index) => `${index + 1}. ${item.name} — ${item.role}`).join('\n')],
    ['补充要求', elements.brief.value],
  ];
  return sections
    .filter(([, value]) => value.trim())
    .map(([heading, value]) => `## ${heading}\n${value.trim()}`)
    .join('\n\n');
}

function applyPreset(name) {
  const presets = {
    signaldesk: {
      title: 'SignalDesk 客服质检平台',
      goal: '帮助客服运营团队发现、复核并处置高风险会话，交付可追踪的质检闭环。',
      users: '客服运营主管与质检专员；桌面端高频使用，信息密度偏高。',
      flows: ['筛选并搜索风险会话', '打开质检详情并查看证据', '分配负责人并标记复核'],
      visual: '精密、克制、可信的数据密集型 B2B 工作台；冷灰画布、钴蓝操作色、紧凑表格与清晰状态。',
    },
    data: {
      title: 'Pulseboard 数据运营平台',
      goal: '把关键业务指标、异常变化和处置动作汇总为可执行的运营视图。',
      users: '业务分析师与运营负责人；桌面端持续监控，信息密度紧凑。',
      flows: ['查看指标趋势与异常', '切换维度并筛选数据', '创建并跟踪处置任务'],
      visual: '编辑式数据产品，浅瓷色背景、石墨文字、清晰图表与克制强调色。',
    },
    atlas: {
      title: 'Atlas Research 研究情报工作台',
      goal: '让研究人员从资料检索、证据阅读到洞察沉淀形成连续工作流。',
      users: '研究员与策略团队；需要长时间阅读、引用核对和知识整理。',
      flows: ['搜索并筛选资料', '打开双栏阅读并切换引用', '保存洞察并整理集合'],
      visual: '安静、理性、具有编辑感的 AI 知识工具；低饱和纸张色、清晰层级与舒适阅读密度。',
    },
  };
  const preset = presets[name];
  if (!preset) return;
  if (!elements.title.value.trim()) elements.title.value = preset.title;
  if (!elements.productGoal.value.trim()) elements.productGoal.value = preset.goal;
  if (!elements.targetUsers.value.trim()) elements.targetUsers.value = preset.users;
  elements.coreFlows.forEach((input, index) => { if (!input.value.trim()) input.value = preset.flows[index] || ''; });
  if (!elements.visualDirection.value.trim()) elements.visualDirection.value = preset.visual;
  updateBriefCount();
  renderStatus();
}

function renderHistory() {
  elements.runHistory.replaceChildren();
  elements.historyCount.textContent = String(state.jobs.length);
  if (!state.jobs.length) {
    elements.runHistory.append(createElement('div', 'rail-empty', '还没有运行记录。'));
    return;
  }
  for (const job of state.jobs) {
    const button = createElement('button', `history-item${state.selectedJob?.id === job.id ? ' selected' : ''}`);
    button.type = 'button';
    button.addEventListener('click', () => selectJob(job.id).catch((error) => showToast(error.message)));
    const dot = createElement('span', `history-status ${statusClass(job.status || job.stage)}`);
    dot.setAttribute('aria-hidden', 'true');
    const copy = createElement('span', 'history-copy');
    copy.append(createElement('strong', '', job.title || job.id));
    copy.append(createElement('small', '', `${STATUS_COPY[job.status || job.stage] || '状态待确认'} / ${formatDate(job.createdAt)}`));
    button.append(dot, copy);
    elements.runHistory.append(button);
  }
}

function renderJob() {
  const job = state.selectedJob;
  elements.composerPane.hidden = Boolean(job);
  elements.runMonitor.hidden = !job;
  elements.workspaceTitle.textContent = job ? '产品生成流程' : '你想做什么产品？';
  if (!job) return;

  elements.runTitle.textContent = job.title || job.id;
  if (elements.runMode) elements.runMode.textContent = job.mode === 'plan' ? '仅生成规格' : '完整运行';
  elements.runStarted.textContent = formatDate(job.createdAt);
  elements.runRepairs.textContent = String(job.repairCount || 0);
  renderStages(job);
  renderEvents(job);
}

function renderStages(job) {
  const stages = ['planning', 'building', 'verifying', 'visual', 'repairing', 'success'];
  const activeStage = deriveStudioStage(state);
  const reached = new Set();
  for (const event of state.events) {
    if (event.type.startsWith('plan:')) reached.add('planning');
    if (event.type.startsWith('build:')) reached.add('building');
    if (['cmd:start', 'cmd:done', 'preview:start', 'preview:ready', 'screenshot', 'scenario', 'review'].includes(event.type)) reached.add('verifying');
    if (event.type.startsWith('visual:')) reached.add('visual');
    if (event.type.startsWith('fix:') || event.type.startsWith('repair:')) reached.add('repairing');
  }
  if (job.status === 'success' || job.status === 'planned') reached.add('success');
  const failedStage = job.status === 'failed'
    ? (stages.includes(job.stage) ? job.stage : [...stages].reverse().find((stage) => reached.has(stage)) || 'planning')
    : null;
  for (const item of elements.stageTrack.querySelectorAll('li')) {
    const stage = item.dataset.stage;
    item.classList.toggle('active', !job.terminal && stage === activeStage);
    item.classList.toggle('done', reached.has(stage) && stage !== failedStage);
    item.classList.toggle('failed', stage === failedStage);
  }
}

function renderEvents(job) {
  elements.eventLog.replaceChildren();
  if (!state.events.length) {
    elements.eventLog.append(createElement('li', 'log-empty', '任务启动后，运行事件会显示在这里。'));
  } else {
    for (const event of state.events) {
      const row = createElement('li', `event-row ${eventClass(event.type)}`);
      row.append(
        createElement('time', 'event-time', formatTime(event.ts)),
        createElement('span', 'event-type', event.type),
        createElement('span', 'event-summary', EVENT_COPY[event.type] || '事件已记录'),
      );
      elements.eventLog.append(row);
    }
    elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
  }
  elements.liveLabel.classList.toggle('streaming', !job.terminal);
  elements.liveLabel.lastChild.textContent = job.terminal ? ' 已完成' : ' 实时';
}

function renderEvidence() {
  const job = state.selectedJob;
  elements.evidenceTitle.textContent = job ? job.title || job.id : '未选择任务';
  elements.shotCount.textContent = String(job?.screenshots?.length || 0);
  elements.repairCount.textContent = String(job?.repairCount || 0);
  elements.launchPreview.disabled = !job?.previewEligible;
  elements.launchPreview.textContent = state.previewJobId === job?.id ? '重新启动预览' : '启动预览';
  elements.previewLabel.textContent = !job
    ? '选择一个成功完成的任务后，可在这里启动产品预览。'
    : job.previewEligible
      ? '已通过验证，可以在本地端口启动预览。'
      : job.terminal
        ? '当前任务没有可预览的成功构建。'
        : '构建验证通过后即可启动预览。';
  renderScreenshots(job);
  renderRepairs(job);
}

function renderScreenshots(job) {
  elements.screenshotsGrid.replaceChildren();
  const screenshots = job?.screenshots || [];
  if (!screenshots.length) {
    elements.screenshotsGrid.append(createElement('div', 'panel-empty', '当前任务还没有结果截图。'));
    return;
  }
  for (const name of screenshots) {
    const button = createElement('button', 'screenshot-item');
    button.type = 'button';
    const url = `/api/jobs/${encodeURIComponent(job.id)}/screenshots/${encodeURIComponent(name)}`;
    const image = document.createElement('img');
    image.src = url;
    image.alt = `生成结果截图：${readableName(name)}`;
    image.loading = 'lazy';
    button.append(image, createElement('span', '', readableName(name)));
    button.addEventListener('click', () => {
      elements.dialogImage.src = url;
      elements.dialogCaption.textContent = readableName(name);
      elements.imageDialog.showModal();
    });
    elements.screenshotsGrid.append(button);
  }
}

function renderRepairs(job) {
  elements.repairList.replaceChildren();
  const repairs = state.events.filter((event) => event.type.startsWith('fix:') || event.type.startsWith('repair:'));
  if (!job || !repairs.length) {
    elements.repairList.append(createElement('li', 'panel-empty', '当前任务没有自动修复记录。'));
    return;
  }
  for (const event of repairs) {
    const item = createElement('li', 'repair-item');
    item.append(
      createElement('time', '', formatDate(event.ts)),
      createElement('strong', '', EVENT_COPY[event.type] || '自动修复事件'),
      createElement('code', '', event.type),
    );
    elements.repairList.append(item);
  }
}

function upsertJob(job) {
  const index = state.jobs.findIndex((item) => item.id === job.id);
  if (index === -1) state.jobs.unshift(job);
  else state.jobs[index] = { ...state.jobs[index], ...job };
}

function setFormBusy(busy) {
  elements.launchRun.disabled = busy;
  elements.launchRun.textContent = busy ? '正在启动…' : '开始生成';
}

function setWorkspaceView(view) {
  document.body.dataset.view = view;
  elements.composerPane.hidden = view !== 'focus';
  elements.runMonitor.hidden = view !== 'flow';
}

function updateBriefCount() {
  elements.briefCount.textContent = `${composeBrief().length.toLocaleString()} / 100,000`;
}

function setConnection(online) {
  elements.connectionDot.className = `connection-dot ${online ? 'online' : 'offline'}`;
  elements.connectionLabel.textContent = online ? '本地服务已连接' : '本地服务不可用';
}

function showError(message) {
  elements.formMessage.textContent = message;
  showToast(message);
}

function clearError() {
  elements.formMessage.textContent = '';
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 4200);
}

function createElement(tag, className = '', text = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function statusClass(status = '') {
  if (status === 'success' || status === 'planned') return status;
  if (status === 'failed') return 'failed';
  if (['queued', 'planning', 'building', 'verifying', 'visual', 'repairing', 'running'].includes(status)) return status;
  return 'neutral';
}

function eventClass(type) {
  if (type === 'fatal') return 'fatal';
  if (type.includes('retry') || type === 'repair:exhausted') return 'retry';
  return '';
}

function formatDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString([], { hour12: false });
}

function readableName(name) {
  return name.replace(/\.png$/i, '').replace(/[-_]+/g, ' ');
}

boot();
