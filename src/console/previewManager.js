import { startPreview } from '../runner/commands.js';
import { ConsoleError } from './errors.js';

export function createPreviewManager({ start = startPreview } = {}) {
  let active = null;

  async function open(run) {
    if (run.status !== 'success') {
      throw new ConsoleError('PREVIEW_UNAVAILABLE', 'Only successful full runs can be previewed.', 409);
    }
    if (active?.id === run.id) return { id: active.id, url: active.url };

    active?.stop();
    active = null;
    const preview = await start({ appDir: run.appDir, logEvent: async () => {} });
    active = { id: run.id, url: preview.url, stop: preview.stop };
    return { id: active.id, url: active.url };
  }

  function state(id) {
    return active?.id === id ? { active: true, url: active.url } : { active: false, url: null };
  }

  function close() {
    active?.stop();
    active = null;
  }

  return { open, state, close };
}
