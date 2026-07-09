// Reviewer: mechanical MVP checks. No model calls here - checks must be reproducible.
export function review({ install, build, shots, spec }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  add('npm install passes', install.exitCode === 0, `exit=${install.exitCode}`);
  add('npm run build passes', build.exitCode === 0, `exit=${build.exitCode}`);

  const expectedPages = spec.pages?.length ?? 0;
  add(
    'all planned pages screenshotted',
    shots.length === expectedPages && expectedPages > 0,
    `${shots.length}/${expectedPages}`,
  );

  for (const shot of shots) {
    add(`screenshot non-empty: ${shot.page}`, shot.bytes > 5_000, `${shot.bytes} bytes`);
    add(
      `page renders text: ${shot.page}`,
      (shot.text ?? '').trim().length > 20,
      `${(shot.text ?? '').trim().length} chars of visible text`,
    );
  }

  const failed = checks.filter((c) => !c.pass);
  return { pass: failed.length === 0, checks, failed };
}
