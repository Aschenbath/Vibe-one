// Single OpenAI-compatible chat provider. Deliberately the only provider in MVP.
// Uses global fetch (Node >= 20). Tracks usage metadata for the delivery report.

export function createProvider(config) {
  async function chat({ system, user, jsonMode = false }) {
    const streamResponses = config.streamResponses !== false;
    const body = {
      model: config.model,
      temperature: config.temperature,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(streamResponses ? { stream: true, stream_options: { include_usage: true } } : {}),
    };

    let res;
    const maxRetries = config.maxNetworkRetries ?? 6;
    const reqTimeout = resolveRequestTimeout(config, streamResponses);
    // Bounded backoff for transient network failures, rate limits, and gateway
    // failures. Each attempt is timeout-bounded so a hung socket cannot stall a run.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(reqTimeout),
        });
      } catch (err) {
        // Network-layer failure or per-request timeout (no HTTP response). Retry.
        if (attempt >= maxRetries) throw new Error(`model call failed (network) after ${maxRetries + 1} attempts: ${err.message}`);
        const waitMs = Math.min(2 ** attempt * 2, 30) * 1000;
        console.log(`[provider] network error "${err.message}", retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const retryableStatus = res.status === 429 || [500, 502, 503, 504].includes(res.status);
      if (!retryableStatus || attempt >= maxRetries) break;
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
      const fallbackSeconds = res.status === 429 ? 25 : Math.min(2 ** attempt * 2, 30);
      const waitSeconds = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0), 120) : fallbackSeconds;
      const waitMs = waitSeconds * 1000;
      console.log(`[provider] HTTP ${res.status}, retrying in ${waitSeconds}s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`model call failed: HTTP ${res.status} ${text.slice(0, 500)}`);
    }

    if (streamResponses && res.headers.get('content-type')?.includes('text/event-stream')) {
      return readStreamedChat(res, config.model);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('model call returned no message content');
    }
    return { content, usage: data.usage ?? null, model: data.model ?? config.model };
  }

  // JSON-expecting variant with one bounded retry on parse failure.
  async function chatJson(opts) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, usage, model } = await chat({ ...opts, jsonMode: true });
      try {
        return { json: extractJson(content), usage, model };
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`model returned unparseable JSON twice: ${lastErr.message}`);
  }

  return { chat, chatJson };
}

export function resolveRequestTimeout(config, streamResponses) {
  if (!streamResponses) return config.requestTimeoutMs ?? 120_000;
  return config.streamRequestTimeoutMs ?? Math.max(config.requestTimeoutMs ?? 120_000, 600_000);
}

async function readStreamedChat(res, fallbackModel) {
  if (!res.body) throw new Error('model stream returned no response body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  let model = fallbackModel;

  function consumeEvent(event) {
    const payload = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload || payload === '[DONE]') return;
    let data;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      throw new Error(`model stream returned invalid SSE JSON: ${err.message}`);
    }
    const delta = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content;
    if (typeof delta === 'string') content += delta;
    if (data.usage) usage = data.usage;
    if (data.model) model = data.model;
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) consumeEvent(event);
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
  if (!content) throw new Error('model call returned no message content');
  return { content, usage, model };
}

// Tolerates markdown fences around the JSON payload.
export function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(trimmed);
}
