// Reviewer: mechanical MVP checks. No model calls here - checks must be reproducible.
export function review({ install, build, shots, spec, scenarioResults }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add('npm install passes', install.exitCode === 0, `exit=${install.exitCode}`);
  add('npm run build passes', build.exitCode === 0, `exit=${build.exitCode}`);

  const pages = spec.pages ?? [];
  const expectedPages = pages.length;
  add(
    'all planned pages screenshotted',
    shots.length === expectedPages && expectedPages > 0,
    `${shots.length}/${expectedPages}`,
  );

  const shotByName = new Map(shots.map((s) => [s.page, s]));
  for (const shot of shots) {
    add(`screenshot non-empty: ${shot.page}`, shot.bytes > 5_000, `${shot.bytes} bytes`);
    add(
      `page renders text: ${shot.page}`,
      (shot.text ?? '').trim().length > 20,
      `${(shot.text ?? '').trim().length} chars of visible text`,
    );
  }

  // Acceptance: each page's mustContain fragments must appear in its rendered text.
  for (const page of pages) {
    const shot = shotByName.get(page.name);
    for (const fragment of page.mustContain ?? []) {
      const present = !!shot && (shot.text ?? '').includes(fragment);
      add(`content present [${page.name}]: "${fragment}"`, present, present ? 'found' : 'missing from rendered page');
    }
  }

  // Interaction scenarios: each planner scenario must pass end-to-end.
  const scenarios = spec.scenarios ?? [];
  const resultByName = new Map((scenarioResults ?? []).map((r) => [r.name, r]));
  for (const sc of scenarios) {
    const res = resultByName.get(sc.name);
    add(`scenario passes: ${sc.name}`, !!res && res.pass, res ? res.error ?? 'ok' : 'scenario not executed');
  }

  const failed = checks.filter((c) => !c.pass);
  return { pass: failed.length === 0, checks, failed };
}
