// Статическая проверка (без сборки/запуска Electron): каждый корневой файл,
// на который server.js ссылается через require('./name') (без вложенных
// путей — routes/*, public/* — уже целиком покрыты своими собственными
// entries в extraResources), должен сам иметь entry в extraResources
// electron-builder.yml. Иначе упакованное desktop-приложение падает в
// бесконечном цикле перезапуска прямо при старте ("Cannot find module") —
// npm test (ни этот, ни корневой) НЕ ловит эту категорию бага, потому что
// оба гоняют server.js прямо из исходников (require разрешается по
// репозиторию, а не по Resources/app/ упакованной сборки) — единственный
// способ поймать её на практике раньше был реальный `--dir`-билд + запуск
// (см. CLAUDE.md "Desktop-specific gotchas"). Случалось дважды на одном и
// том же месте: package.json (2026-08-12), backup.js (2026-08-14) — эта
// проверка должна закрыть весь класс бага на будущее, не только эти два файла.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

// Простой построчный разбор списка `- from: ...` под extraResources: —
// файл маленький и рукописный (см. electron-builder.yml), полноценный
// YAML-парсер тут ни к чему.
function parseExtraResourcesFroms(yamlText) {
  const froms = [];
  const lines = yamlText.split('\n');
  let inExtraResources = false;
  for (const line of lines) {
    if (/^extraResources:/.test(line)) { inExtraResources = true; continue; }
    if (inExtraResources) {
      if (/^\S/.test(line)) break; // следующий топ-уровневый ключ — секция закончилась
      const m = line.match(/-\s*from:\s*(\S+)/);
      if (m) froms.push(m[1]);
    }
  }
  return froms;
}

test('electron-builder extraResources covers every root-level sibling file server.js requires', () => {
  const yamlText = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const froms = parseExtraResourcesFroms(yamlText);
  assert.ok(froms.length > 0, 'sanity check: the extraResources parser must find at least one entry');

  const serverText = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  // ./name без дальнейших слэшей — то есть именно корневой файл-соседец
  // server.js, не routes/* или public/* (у тех своя, уже покрытая, entry).
  const re = /require\(\s*['"]\.\/([a-zA-Z0-9_-]+)['"]\s*\)/g;
  const siblings = new Set();
  let m;
  while ((m = re.exec(serverText))) siblings.add(m[1]);
  assert.ok(siblings.size > 0, "sanity check: server.js must require at least one root-level sibling (e.g. './db')");

  for (const name of siblings) {
    const fileName = `${name}.js`;
    assert.ok(
      fs.existsSync(path.join(repoRoot, fileName)),
      `server.js requires './${name}' but ${fileName} doesn't exist at the repo root`
    );
    const covered = froms.includes(`../${fileName}`);
    assert.ok(
      covered,
      `server.js requires './${name}' (${fileName} at the repo root) but electron-builder.yml's ` +
      `extraResources has no '- from: ../${fileName}' entry — the packaged desktop app will ` +
      `crash-loop on startup with "Cannot find module './${name}'". Add the entry alongside the ` +
      `existing server.js/db.js ones.`
    );
  }
});
