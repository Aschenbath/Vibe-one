export const UI_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

const PLACEHOLDER_CONTENT = /lorem ipsum|Card\s+\d+|Item\s+[A-Z]\b|\bTODO\b|placeholder text|sample data/i;
const ERROR_STACK = /(?:^|\n)\s*(?:Error|TypeError|ReferenceError|SyntaxError|RangeError):[^\n]*(?:\n\s+at\s+)/m;

export function contrastRatio(foreground, background) {
  const foregroundRgb = parseColor(foreground);
  const backgroundRgb = parseColor(background);
  if (!foregroundRgb || !backgroundRgb) return null;
  const foregroundLuminance = luminance(foregroundRgb);
  const backgroundLuminance = luminance(backgroundRgb);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

function parseColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const expanded = hex[1].length === 3
      ? hex[1].split('').map((part) => part + part).join('')
      : hex[1];
    return [0, 2, 4].map(
      (index) => Number.parseInt(expanded.slice(index, index + 2), 16),
    );
  }

  const functional = color.match(
    /^rgba?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/,
  );
  if (!functional) return null;
  const rgba = color.startsWith('rgba(');
  const alpha = functional[4];
  if (rgba !== (alpha != null)) return null;
  if (rgba && Number(alpha) !== 1) return null;
  const channels = functional.slice(1, 4).map(Number);
  if (channels.some((channel) => channel < 0 || channel > 255)) return null;
  return channels;
}

function luminance(rgb) {
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (
    channels[0] * 0.2126
    + channels[1] * 0.7152
    + channels[2] * 0.0722
  );
}

export function auditPageSnapshot(snapshot = {}) {
  const page = snapshot.page ?? '';
  const route = snapshot.route ?? '';
  const viewport = snapshot.viewport ?? '';
  const failures = [];
  const add = (code, detail) => failures.push({ code, page, route, viewport, detail });

  const documentMetrics = snapshot.document ?? {};
  const scrollWidth = numberOrZero(documentMetrics.scrollWidth);
  const clientWidth = numberOrZero(documentMetrics.clientWidth);
  if (scrollWidth > clientWidth) {
    add('HORIZONTAL_OVERFLOW', scrollWidth + '>' + clientWidth);
  }

  for (const entry of snapshot.outOfBounds ?? []) {
    add(
      'ELEMENT_OUT_OF_BOUNDS',
      describe(entry, 'element') + (entry?.edge ? ' beyond ' + entry.edge : ''),
    );
  }

  for (const pair of snapshot.overlaps ?? []) {
    const first = pair?.a ?? pair?.first ?? 'element';
    const second = pair?.b ?? pair?.second ?? 'element';
    add('ELEMENT_OVERLAP', first + '/' + second);
  }

  for (const item of snapshot.interactive ?? []) {
    const width = numberOrZero(item?.width);
    const height = numberOrZero(item?.height);
    if (width < 44 || height < 44) {
      add(
        'HIT_TARGET_TOO_SMALL',
        describe(item, 'interactive target') + ' ' + width + 'x' + height,
      );
    }
  }

  for (const sample of snapshot.textSamples ?? []) {
    const ratio = contrastRatio(sample?.foreground, sample?.background);
    const fontSize = numberOrZero(sample?.fontSize);
    const fontWeight = numberOrZero(sample?.fontWeight);
    const largeText = fontSize >= 24 || (fontSize >= 18 && fontWeight >= 700);
    const threshold = largeText ? 3 : 4.5;
    if (ratio == null) {
      add(
        'LOW_CONTRAST',
        describe(sample, 'text') + ': invalid color '
          + String(sample?.foreground) + '/' + String(sample?.background),
      );
    } else if (ratio < threshold) {
      add(
        'LOW_CONTRAST',
        describe(sample, 'text') + ': ratio ' + ratio + ' < ' + threshold,
      );
    }
  }

  const landmarks = snapshot.landmarks ?? {};
  const missingLandmarks = [];
  if (!landmarks.main) missingLandmarks.push('main');
  if (!landmarks.navigation) missingLandmarks.push('navigation');
  if (missingLandmarks.length) {
    add('LANDMARK_MISSING', 'missing ' + missingLandmarks.join(', '));
  }

  if (invalidHeadingHierarchy(snapshot.headings ?? [])) {
    add(
      'HEADING_HIERARCHY_INVALID',
      'requires a non-empty H1 and no heading level skips',
    );
  }

  const stateEvidence = new Map(
    (snapshot.stateEvidence ?? [])
      .filter((entry) => entry?.name)
      .map((entry) => [entry.name, entry]),
  );
  for (const requiredState of snapshot.requiredStates ?? []) {
    const stateName = typeof requiredState === 'string'
      ? requiredState
      : requiredState?.name;
    if (!stateName) continue;
    if (stateEvidence.get(stateName)?.reachable !== true) {
      add('STATE_UNREACHABLE', stateName + ' has no reachable evidence');
    }
  }

  const mainRegion = snapshot.mainRegion ?? {};
  const mainText = String(mainRegion.visibleText ?? '').trim();
  if (
    numberOrZero(mainRegion.width) <= 0
    || numberOrZero(mainRegion.height) <= 0
    || !mainText
  ) {
    add('EMPTY_MAIN_REGION', 'main region has no visible area or text');
  }

  const visibleText = String(snapshot.visibleText ?? '');
  if (PLACEHOLDER_CONTENT.test(visibleText)) {
    add('PLACEHOLDER_CONTENT', 'forbidden placeholder content is visible');
  }
  if (ERROR_STACK.test(visibleText)) {
    add('ERROR_STACK_VISIBLE', 'an error stack is visible');
  }

  for (const control of snapshot.nativeControls ?? []) {
    if (control?.styled === false) {
      add('UNSTYLED_NATIVE_CONTROL', describe(control, 'native control'));
    }
  }

  for (const icon of snapshot.emojiIcons ?? []) {
    const text = typeof icon === 'string' ? icon : icon?.text;
    if (String(text ?? '').trim()) {
      add('EMOJI_ICON_VISIBLE', describe(icon, 'Emoji icon'));
    }
  }

  const screenshot = snapshot.screenshot ?? {};
  const screenshotBytes = numberOrZero(screenshot.bytes);
  if (
    screenshotBytes <= 0
    || numberOrZero(screenshot.width) <= 0
    || numberOrZero(screenshot.height) <= 0
  ) {
    add('SCREENSHOT_EMPTY', 'screenshot has no bytes or dimensions');
  }

  return {
    page,
    route,
    viewport,
    pass: failures.length === 0,
    failures,
    metrics: {
      scrollWidth,
      clientWidth,
      interactiveCount: (snapshot.interactive ?? []).length,
      textSampleCount: (snapshot.textSamples ?? []).length,
      screenshotBytes,
    },
  };
}

export function summarizeUiAudit(results, pages) {
  const auditResults = Array.isArray(results) ? results : [];
  const failures = auditResults.flatMap((result) => result.failures ?? []);
  for (const page of pages ?? []) {
    const pageName = typeof page === 'string' ? page : page.name;
    const route = typeof page === 'string' ? '' : page.route ?? '';
    for (const viewport of Object.keys(UI_VIEWPORTS)) {
      const present = auditResults.some(
        (result) => result.page === pageName && result.viewport === viewport,
      );
      if (!present) {
        failures.push({
          code: 'VIEWPORT_EVIDENCE_MISSING',
          page: pageName,
          route,
          viewport,
          detail: 'missing audit result',
        });
      }
    }
  }
  return { pass: failures.length === 0, failures, results: auditResults };
}

function invalidHeadingHierarchy(headings) {
  if (!Array.isArray(headings) || headings.length === 0) return true;
  const validH1 = headings.some(
    (heading) => heading?.level === 1 && String(heading.text ?? '').trim(),
  );
  if (!validH1) return true;
  let previousLevel = null;
  for (const heading of headings) {
    const level = Number(heading?.level);
    if (!Number.isInteger(level) || level < 1 || level > 6) return true;
    if (previousLevel != null && level > previousLevel + 1) return true;
    previousLevel = level;
  }
  return false;
}

function describe(value, fallback) {
  if (typeof value === 'string') return value;
  return value?.label ?? value?.text ?? value?.selector ?? fallback;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
