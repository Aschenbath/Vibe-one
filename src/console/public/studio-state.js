const EVENT_STAGES = [
  [/^plan:/, 'planning'],
  [/^build:/, 'building'],
  [/^(cmd:(start|done)|preview:(start|ready)|screenshot|scenario|review)$/, 'verifying'],
  [/^visual:/, 'visual'],
  [/^(fix:|repair:)/, 'repairing'],
];

export function createStudioState() {
  return {
    mode: 'focus',
    runId: null,
    selectedJob: null,
    events: [],
    canvas: { device: 'desktop' },
    drawers: { timeline: false, inspector: false },
  };
}

export function reduceStudio(state, action) {
  switch (action.type) {
    case 'JOB_STARTED':
      return {
        ...state,
        mode: 'flow',
        runId: action.runId,
        selectedJob: state.selectedJob?.id === action.runId ? state.selectedJob : { id: action.runId },
        events: [],
      };
    case 'JOB_SELECTED':
      return {
        ...state,
        mode: 'flow',
        runId: action.job.id,
        selectedJob: action.job,
        events: [],
      };
    case 'JOB_UPDATED':
      return {
        ...state,
        runId: action.job.id || state.runId,
        selectedJob: { ...(state.selectedJob || {}), ...action.job },
      };
    case 'EVENT_RECEIVED':
      return { ...state, events: appendEvents(state.events, [action.event]) };
    case 'EVENTS_REPLAYED':
      return { ...state, events: appendEvents(state.events, action.events || []) };
    case 'DEVICE_SELECTED':
      return ['desktop', 'mobile'].includes(action.device)
        ? { ...state, canvas: { ...state.canvas, device: action.device } }
        : state;
    case 'INSPECTOR_OPENED':
      return { ...state, drawers: { timeline: false, inspector: true } };
    case 'TIMELINE_OPENED':
      return { ...state, drawers: { timeline: true, inspector: false } };
    case 'DRAWERS_CLOSED':
      return { ...state, drawers: { timeline: false, inspector: false } };
    case 'WORKSPACE_FOCUSED':
      return { ...state, ...createStudioState() };
    default:
      return state;
  }
}

export function deriveStudioStage(state) {
  const job = state.selectedJob;
  if (job?.stage) return job.stage;
  if (job?.status === 'success' || job?.status === 'planned') return 'success';
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const type = state.events[index]?.type || '';
    const found = EVENT_STAGES.find(([pattern]) => pattern.test(type));
    if (found) return found[1];
  }
  return state.mode === 'flow' ? 'planning' : 'idle';
}

function appendEvents(current, incoming) {
  const next = [...current];
  const keys = new Set(current.map(eventKey));
  for (const event of incoming) {
    const key = eventKey(event);
    if (!keys.has(key)) {
      keys.add(key);
      next.push(event);
    }
  }
  return next;
}

function eventKey(event) {
  return `${event.ts}|${event.type}|${event.summary || ''}`;
}
