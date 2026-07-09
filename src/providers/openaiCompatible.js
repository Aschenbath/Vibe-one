// Single OpenAI-compatible chat provider. Deliberately the only provider in MVP.
// Uses global fetch (Node >= 20). Tracks usage metadata for the delivery report.

export function createProvider(config) {
  async function chat({ system, user, jsonMode = false }) {
    const body = {
      model: config.model,
      temperature: config.temperature,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    let res;
    // Bounded backoff for both transient network failures (fetch failed / reset /
    // EOF - common on shared gateways) and 429 rate limits.
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network-layer failure (no HTTP response). Retry with backoff.
        if (attempt >= 4) throw new Error(`model call failed (network): ${err.message}`);
        const waitMs = Math.min(2 ** attempt * 2, 30) * 1000;
        console.log(`[provider] network error "${err.message}", retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/4)`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (res.status !== 429 || attempt >= 4) break;
      const retryAfter = Number(res.headers.get('retry-after')) || 25;
      const waitMs = Math.min(retryAfter, 120) * 1000;
      console.log(`[provider] 429 rate limited, retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/4)`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`model call failed: HTTP ${res.status} ${text.slice(0, 500)}`);
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

// Tolerates markdown fences around the JSON payload.
export function extractJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(trimmed);
}
