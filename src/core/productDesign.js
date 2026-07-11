const ERROR_CODE = 'PRODUCT_DESIGN_INVALID';
const REQUIRED_TEXT_FIELDS = [
  'productType',
  'tone',
  'navigation',
  'contentStrategy',
];
const REQUIRED_LIST_FIELDS = [
  'targetUsers',
  'componentLanguage',
  'responsiveRules',
];
const STATE_NAMES = new Set(['loading', 'empty', 'error', 'success']);
const VAGUE_TONE = /^(?:(?:现代|简洁|modern|clean)[,，/、\s]*)+$/iu;

export function validateProductDesign(value) {
  if (!isRecord(value)) fail('product design must be an object');

  for (const field of REQUIRED_TEXT_FIELDS) {
    requireText(value[field], 8, field);
  }

  const density = requireText(value.density, 1, 'density');
  if (density !== 'compact' && density.length < 8) {
    fail('density incomplete');
  }
  if (VAGUE_TONE.test(value.tone.trim())) {
    fail('tone too vague');
  }

  for (const field of REQUIRED_LIST_FIELDS) {
    requireStringList(value[field], field);
  }

  validateTokens(value.tokens);
  validateStates(value.requiredStates);
  return value;
}

export function renderProductDesign(value) {
  const design = validateProductDesign(value);
  const lines = [
    '## 产品设计 / Product Design',
    '',
    `- **产品类型 / Product Type:** ${design.productType}`,
    `- **视觉语气 / Visual Tone:** ${design.tone}`,
    `- **密度 / Density:** ${design.density}`,
    `- **导航 / Navigation:** ${design.navigation}`,
    `- **内容策略 / Content Strategy:** ${design.contentStrategy}`,
    '',
    '### 目标用户 / Target Users',
    '',
    ...design.targetUsers.map((user) => `- ${user}`),
    '',
    '### 组件语言 / Component Language',
    '',
    ...design.componentLanguage.map((component) => `- ${component}`),
    '',
    '### 设计令牌 / Design Tokens',
    '',
    '~~~json',
    JSON.stringify(design.tokens, null, 2),
    '~~~',
    '',
    '### 核心状态 / Required States',
    '',
    ...design.requiredStates.map((state) => `- **${state.name}:** ${state.trigger}`),
    '',
    '### 响应式规则 / Responsive Rules',
    '',
    ...design.responsiveRules.map((rule) => `- ${rule}`),
  ];
  return lines.join('\n');
}

function validateTokens(tokens) {
  if (!isRecord(tokens)) fail('tokens incomplete');
  requireTokenRecord(tokens.colors, 6, 'colors');
  requireTokenRecord(tokens.typography, 4, 'typography');
  requireTokenList(tokens.spacing, 5, 'spacing');
  requireTokenList(tokens.radii, 3, 'radii');
}

function validateStates(states) {
  if (!Array.isArray(states) || states.length < 2) {
    fail('requiredStates incomplete');
  }
  for (const state of states) {
    if (
      !isRecord(state)
      || !STATE_NAMES.has(state.name)
      || typeof state.trigger !== 'string'
      || state.trigger.trim().length < 4
    ) {
      fail('requiredStates incomplete');
    }
  }
}

function requireText(value, minLength, field) {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    fail(`${field} incomplete`);
  }
  return value.trim();
}

function requireStringList(value, field) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    fail(`${field} incomplete`);
  }
}

function requireTokenRecord(value, minimum, field) {
  if (
    !isRecord(value)
    || Object.keys(value).length < minimum
    || Object.values(value).some((token) => typeof token !== 'string' || !token.trim())
  ) {
    fail(`tokens.${field} incomplete`);
  }
}

function requireTokenList(value, minimum, field) {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.some((token) => typeof token !== 'string' || !token.trim())
  ) {
    fail(`tokens.${field} incomplete`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(detail) {
  const error = new Error(`${ERROR_CODE}: ${detail}`);
  error.code = ERROR_CODE;
  throw error;
}
