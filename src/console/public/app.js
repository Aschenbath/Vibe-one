import { STATUS_COPY, ERROR_COPY, EVENT_COPY } from './copy.js';

const state = {
  status: null,
  jobs: [],
  selectedJob: null,
  events: [],
  eventSource: null,
  activeEvidenceTab: 'preview',
  previewJobId: null,
  toastTimer: null,
};

const elements = {
  form: document.querySelector('#run-form'),
  title: document.querySelector('#title'),
  brief: document.querySelector('#brief'),
  briefCount: document.querySelector('#brief-count'),
  baseUrl: document.querySelector('#base-url'),
  model: document.querySelector('#model'),
  apiKey: document.querySelector('#api-key'),
  keyHint: document.querySelector('#key-hint'),
  clearKey: document.querySelector('#clear-key'),
  launchRun: document.querySelector('#launch-run'),
  newRun: document.querySelector('#new-run'),
  formMessage: document.querySelector('#form-message'),
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

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(ERROR_COPY[body.error?.code] || body.error?.message || `请求失败 (${response.status})`);
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
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        title: elements.title.value,
        brief: elements.brief.value,
        mode: document.querySelector('input[name="mode"]:checked').value,
        baseUrl: elements.baseUrl.value.trim(),
        model: elements.model.value.trim(),
      }),
    });
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
    state.selectedJob = { ...state.selectedJob, ...payload.job };
    if (payload.event) pushEvent(payload.event);
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
  state.selectedJob = job;
  state.events = [];
  for (const event of job.events || []) pushEvent(event);
  state.previewJobId = null;
  setWorkspaceView('flow');
  elements.previewFrame.src = 'about:blank';
  elements.previewFrame.hidden = true;
  elements.previewEmpty.hidden = false;
  upsertJob(job);
  render();
  if (!job.terminal) connectEvents(id);
}

async function refreshSelectedJob() {
  if (!state.selectedJob) return;
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(state.selectedJob.id)}`);
    state.selectedJob = job;
    for (const event of job.events || []) pushEvent(event);
    upsertJob(job);
    render();
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
  state.selectedJob = null;
  state.events = [];
  state.previewJobId = null;
  clearError();
  setWorkspaceView('focus');
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
  elements.launchRun.disabled = Boolean(active) || !elements.brief.value.trim() || !hasKey;
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
    copy.append(createElement('small', '', `${STATUS_COPY[job.status || job.stage] || job.status || job.stage} / ${formatDate(job.createdAt)}`));
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
    item.classList.toggle('active', !job.terminal && stage === job.stage);
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
        createElement('span', 'event-summary', EVENT_COPY[event.type] || event.summary || '事件已记录'),
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
      createElement('strong', '', EVENT_COPY[event.type] || event.summary || '自动修复事件'),
      createElement('code', '', event.type),
    );
    elements.repairList.append(item);
  }
}

function pushEvent(event) {
  const key = `${event.ts}|${event.type}|${event.summary || ''}`;
  if (!state.events.some((item) => `${item.ts}|${item.type}|${item.summary || ''}` === key)) state.events.push(event);
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
  elements.briefCount.textContent = `${elements.brief.value.length.toLocaleString()} / 100,000`;
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
