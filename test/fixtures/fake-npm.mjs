// Поддельный npm для тестов без сети: «ставит» пакеты в node_modules текущей папки.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2).filter((a) => a !== 'install' && !a.startsWith('--'));
const legacy = process.argv.includes('--legacy-peer-deps');
for (const spec of args) {
  // старая версия с peer react@18 в проекте на React 19 — как @mantine/core@7.0.0
  if (/@7\.0\.0$/.test(spec)) {
    console.error('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error peer react@"^18.2.0" from ' + spec);
    process.exit(1);
  }
  if (spec.includes('needs-legacy') && !legacy) {
    console.error('npm error code ERESOLVE\nnpm error Could not resolve dependency: peer react@"^17"');
    process.exit(1);
  }
  if (spec.includes('does-not-exist')) {
    console.error(`npm ERR! 404 Not Found - GET https://registry.npmjs.org/${spec}`);
    process.exit(1);
  }
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1).replace(/[^\d.]/g, '') || '1.0.0' : '7.17.0';
  const dir = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  writeFileSync(path.join(dir, 'index.js'), 'export const ok = true;\n');
}
console.log(`added ${args.length} packages`);
