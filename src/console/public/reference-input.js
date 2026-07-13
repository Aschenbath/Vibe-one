export function createReferenceInputController({ input, trigger, dropzone, list, onChange, showError }) {
  const accepted = new Set(['image/png', 'image/jpeg', 'image/webp']);
  const files = [];
  let generation = 0;
  let pending = Promise.resolve();

  function add(nextFiles) {
    const incoming = [...nextFiles];
    const token = generation;
    pending = pending.then(() => addFiles(incoming, token));
    return pending;
  }

  async function addFiles(incoming, token) {
    if (token !== generation) return;
    if (files.length + incoming.length > 4) {
      showError('最多上传 4 张参考图。');
      return;
    }
    for (const file of incoming) {
      if (!accepted.has(file.type)) {
        showError('仅支持 PNG、JPEG 和 WebP 图片。');
        continue;
      }
      if (file.size > 6 * 1024 * 1024) {
        showError(`${file.name} 超过 6 MiB。`);
        continue;
      }
      let dimensions;
      try {
        dimensions = await readDimensions(file);
      } catch {
        if (token === generation) showError(`无法读取图片：${file.name}`);
        continue;
      }
      if (token !== generation) return;
      files.push({ file, ...dimensions, role: inferRole(file.name), objectUrl: URL.createObjectURL(file) });
    }
    if (token !== generation) return;
    render();
    onChange(files.length);
  }

  function remove(index) {
    const [removed] = files.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.objectUrl);
    render();
    onChange(files.length);
  }

  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    [files[index], files[target]] = [files[target], files[index]];
    render();
    onChange(files.length);
  }

  function storyboard() {
    return files.map(({ file, role }, index) => ({
      name: file.name,
      role: role.trim() || `页面参考 ${index + 1}`,
    }));
  }

  async function payload() {
    return Promise.all(files.map(async ({ file, width, height }) => ({
      name: file.name,
      type: file.type,
      width,
      height,
      base64: await fileBase64(file),
    })));
  }

  function clear() {
    generation += 1;
    for (const item of files) URL.revokeObjectURL(item.objectUrl);
    files.splice(0);
    render();
    onChange(0);
  }

  function render() {
    list.replaceChildren();
    files.forEach((item, index) => {
      const row = document.createElement('li');
      const image = document.createElement('img');
      image.src = item.objectUrl;
      image.alt = `${item.file.name} 预览`;
      const copy = document.createElement('span');
      copy.textContent = `${item.file.name} · ${item.width}×${item.height} · ${(item.file.size / 1024).toFixed(1)} KiB`;
      const role = document.createElement('input');
      role.value = item.role || '';
      role.placeholder = '页面角色，例如：运营总览';
      role.setAttribute('aria-label', `${item.file.name} 页面角色`);
      role.addEventListener('input', () => {
        item.role = role.value;
        onChange(files.length);
      });
      const up = button(`将 ${item.file.name} 前移`, () => move(index, -1));
      up.disabled = index === 0;
      const down = button(`将 ${item.file.name} 后移`, () => move(index, 1));
      down.disabled = index === files.length - 1;
      const del = button(`移除 ${item.file.name}`, () => remove(index));
      row.append(image, copy, role, up, down, del);
      list.append(row);
    });
  }

  trigger.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    try {
      await add(input.files);
    } finally {
      input.value = '';
    }
  });
  for (const type of ['dragenter', 'dragover']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.dataset.dragging = 'true';
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      delete dropzone.dataset.dragging;
    });
  }
  dropzone.addEventListener('drop', (event) => add(event.dataTransfer.files));
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });

  return {
    add,
    remove,
    move,
    payload,
    storyboard,
    clear,
    ready: () => pending,
    count: () => files.length,
  };
}

function inferRole(name) {
  if (/detail|详情/i.test(name)) return '详情页';
  if (/overview|home|dashboard|总览|首页/i.test(name)) return '总览页';
  if (/list|queue|列表|队列/i.test(name)) return '列表页';
  return '';
}

function button(label, onClick) {
  const value = document.createElement('button');
  value.type = 'button';
  value.textContent = label;
  value.addEventListener('click', onClick);
  return value;
}

function readDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const result = { width: image.naturalWidth, height: image.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`无法读取图片：${file.name}`));
    };
    image.src = url;
  });
}

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
