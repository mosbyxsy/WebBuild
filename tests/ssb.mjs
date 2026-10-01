import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build, loadConfig } from '../lib/ssb/index.js';
import { normalizeOptionalLevels, runCli } from '../lib/ssb/cli-runner.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ssb-test-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createSite(site) {
  await write(site, 'index.html', `<!doctype html>
    <html><head>
      <link rel="stylesheet" href="styles/main.css">
      <link rel="manifest" href="site.webmanifest">
      <script type="importmap">{"imports":{"alias":"./scripts/alias.js"}}</script>
    </head><body style="background-image:url('images/bg.bin')">
      <a href="pages/about.html">About</a>
      <img src="images/logo.bin" srcset="images/logo.bin 1x, images/logo2.bin 2x">
      <script type="module" src="scripts/main.js"></script>
    </body></html>`);
  await write(site, 'contact.html', '<!doctype html><title> Contact </title>');
  await write(site, 'pages/about.html', '<script src="../scripts/about.js"></script>');
  await write(site, 'styles/main.css', `@import './theme.css'; body { color: red; src: url('../fonts/site.bin'); }`);
  await write(site, 'styles/theme.css', 'h1 { margin: 0 0 0 0; }');
  await write(site, 'scripts/main.js', `import './util.js'; fetch('../data/info.json'); new Worker('./worker.js');`);
  await write(site, 'scripts/util.js', 'export const value = 1;');
  await write(site, 'scripts/worker.js', `importScripts('./worker-helper.js');`);
  await write(site, 'scripts/worker-helper.js', 'self.ready = true;');
  await write(site, 'scripts/about.js', 'console.log("about");');
  await write(site, 'scripts/alias.js', 'export default 1;');
  await write(site, 'site.webmanifest', JSON.stringify({ icons: [{ src: 'images/icon.bin' }] }));
  for (const file of ['images/bg.bin', 'images/logo.bin', 'images/logo2.bin', 'images/icon.bin', 'fonts/site.bin']) {
    await write(site, file, Buffer.from([0, 1, 2, 255]));
  }
  await write(site, 'data/info.json', '{"ok":true}');
  await write(site, 'dynamic/generated.json', '{"dynamic":true}');
  await write(site, 'unused.txt', 'do not package');
}

test('auto-discovers top-level HTML and recursively collects local dependencies', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await createSite(site);
    const result = await build({ cwd: root, root: './site', include: ['dynamic/*.json'] });
    assert.deepEqual(result.entryPaths, ['contact.html', 'index.html']);
    for (const expected of [
      'index.html', 'contact.html', 'pages/about.html', 'styles/main.css', 'styles/theme.css',
      'scripts/main.js', 'scripts/util.js', 'scripts/worker.js', 'scripts/worker-helper.js',
      'scripts/about.js', 'scripts/alias.js', 'site.webmanifest', 'images/icon.bin',
      'images/logo2.bin', 'fonts/site.bin', 'data/info.json', 'dynamic/generated.json',
    ]) assert.ok(result.includedFiles.includes(expected), expected);
    assert.equal(await readFile(path.join(result.outDir, 'images/logo.bin'), 'hex'), '000102ff');
    await assert.rejects(() => readFile(path.join(result.outDir, 'unused.txt')));
  });
});

test('explicit CLI entries replace config entries and optional levels do not consume HTML', async () => {
  assert.deepEqual(
    normalizeOptionalLevels(['node', 'ssb', '--minify-html', 'index.html']),
    ['node', 'ssb', '--minify-html=safe', 'index.html'],
  );
  assert.deepEqual(
    normalizeOptionalLevels(['node', 'ssb', '--minify', 'custom-entry']),
    ['node', 'ssb', '--minify=safe', 'custom-entry'],
  );
  assert.deepEqual(
    normalizeOptionalLevels(['node', 'ssb', '--optimize', 'index.html']),
    ['node', 'ssb', '--optimize=safe', 'index.html'],
  );
  let received;
  await runCli(['node', 'ssb', '--minify-html', 'index.html', '--entry', 'pages/*.html'], {
    build: async (options) => {
      received = options;
      return {
        dryRun: true, sourceDir: 'x', outDir: 'y', entryPaths: [], includedFiles: [],
        files: { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 }, bytesBefore: 0, bytesAfter: 0,
      };
    },
    write: () => undefined,
  });
  assert.deepEqual(received.entries, ['index.html', 'pages/*.html']);
  assert.deepEqual(received.minify, { html: 'safe' });
});

test('maps global, per-type, obfuscation, and target CLI options independently', async () => {
  let received;
  await runCli(['node', 'ssb', '--no-minify', '--minify-js', 'aggressive', '--no-obfuscate', '--target', 'es5', 'index.html'], {
    build: async (options) => {
      received = options;
      return {
        dryRun: false, sourceDir: 'x', outDir: 'y', entryPaths: [], includedFiles: [],
        files: { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 }, bytesBefore: 0, bytesAfter: 0,
      };
    },
    write: () => undefined,
  });
  assert.deepEqual(received.minify, { level: 'none', js: 'aggressive' });
  assert.deepEqual(received.obfuscate, { level: 'none' });
  assert.deepEqual(received.transpile, { target: 'es5' });

  await runCli(['node', 'ssb', '--obfuscate', 'none', 'index.html'], {
    build: async (options) => {
      received = options;
      return {
        dryRun: false, sourceDir: 'x', outDir: 'y', entryPaths: [], includedFiles: [],
        files: { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 }, bytesBefore: 0, bytesAfter: 0,
      };
    },
    write: () => undefined,
  });
  assert.deepEqual(received.obfuscate, { level: 'none' });

  await runCli([
    'node', 'ssb', '--obfuscate', 'safe', '--no-minify-css', '--optimize', 'aggressive', 'index.html',
  ], {
    build: async (options) => {
      received = options;
      return {
        dryRun: false, sourceDir: 'x', outDir: 'y', entryPaths: [], includedFiles: [],
        files: { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 }, bytesBefore: 0, bytesAfter: 0,
      };
    },
    write: () => undefined,
  });
  assert.deepEqual(received.minify, { level: 'aggressive', css: 'none' });
  assert.deepEqual(received.obfuscate, { level: 'safe' });

  await runCli(['node', 'ssb', '--no-optimize', 'index.html'], {
    build: async (options) => {
      received = options;
      return {
        dryRun: false, sourceDir: 'x', outDir: 'y', entryPaths: [], includedFiles: [],
        files: { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 }, bytesBefore: 0, bytesAfter: 0,
      };
    },
    write: () => undefined,
  });
  assert.deepEqual(received.minify, { level: 'none' });
  assert.deepEqual(received.obfuscate, { level: 'none' });
});

test('loads TypeScript config and lets programmatic options override entries and levels', async () => {
  await withTemporaryDirectory(async (root) => {
    await mkdir(path.join(root, 'site'));
    await write(root, 'ssb.config.ts', `export default {
      root: './site', entries: ['from-config.html'], outDir: './release',
      include: ['shared/**', 'config-only/**'],
      exclude: ['shared.tmp', 'config.tmp'],
      transformExclude: ['vendor/**'],
      minify: { level: 'aggressive', html: 'none', exclude: ['generated/**'] },
      obfuscate: { level: 'safe', exclude: ['vendor/**'], reservedNames: ['configApi'] },
      transpile: { target: 'es5', exclude: ['legacy/**'] }
    };`);
    const loaded = await loadConfig({
      cwd: root,
      overrides: {
        entries: ['from-api.html'],
        include: ['shared/**', 'api-only/**'],
        exclude: ['shared.tmp', 'api.tmp'],
        transformExclude: ['vendor/**', 'raw/**'],
        minify: { js: 'none', exclude: ['generated/**', 'raw-js/**'] },
        obfuscate: { exclude: ['third-party/**'], reservedNames: ['configApi', 'publicApi'] },
        transpile: { exclude: ['legacy/**', 'modern-only/**'] },
      },
    });
    assert.equal(loaded.root, path.join(root, 'site'));
    assert.equal(loaded.outDir, path.join(root, 'release'));
    assert.deepEqual(loaded.entries, ['from-api.html']);
    assert.deepEqual(
      { html: loaded.minify.html, js: loaded.minify.js, css: loaded.minify.css },
      { html: 'none', js: 'none', css: 'aggressive' },
    );
    assert.equal(loaded.obfuscate.level, 'safe');
    assert.deepEqual(loaded.include, ['shared/**', 'config-only/**', 'api-only/**']);
    assert.equal(loaded.exclude.filter((value) => value === 'shared.tmp').length, 1);
    assert.ok(loaded.exclude.includes('config.tmp'));
    assert.ok(loaded.exclude.includes('api.tmp'));
    assert.deepEqual(loaded.transformExclude, ['vendor/**', 'raw/**']);
    assert.deepEqual(loaded.minify.exclude, ['generated/**', 'raw-js/**', 'vendor/**', 'raw/**']);
    assert.deepEqual(loaded.obfuscate.exclude, ['vendor/**', 'third-party/**', 'raw/**']);
    assert.deepEqual(loaded.obfuscate.reservedNames, ['configApi', 'publicApi']);
    assert.deepEqual(loaded.transpile, {
      target: 'es5',
      exclude: ['legacy/**', 'modern-only/**', 'vendor/**', 'raw/**'],
    });

    const shorthand = await loadConfig({ cwd: root, overrides: { transpile: 'modern' } });
    assert.equal(shorthand.transpile.target, 'modern');
  });
});

test('loads build config before the higher-priority ssb config', async () => {
  await withTemporaryDirectory(async (root) => {
    await write(root, 'build.config.json', JSON.stringify({
      outDir: './common-dist',
      entries: ['common.html'],
      include: ['common/**'],
      minify: 'aggressive',
      obfuscate: 'safe',
    }));
    await write(root, 'ssb.config.json', JSON.stringify({
      outDir: './site-dist',
      entries: ['site.html'],
      include: ['site/**'],
      minify: { css: 'none' },
      obfuscate: 'aggressive',
    }));

    const resolved = await loadConfig({ cwd: root });
    assert.equal(resolved.outDir, path.join(root, 'site-dist'));
    assert.deepEqual(resolved.entries, ['site.html']);
    assert.deepEqual(resolved.include, ['common/**', 'site/**']);
    assert.deepEqual(
      { html: resolved.minify.html, js: resolved.minify.js, css: resolved.minify.css },
      { html: 'aggressive', js: 'aggressive', css: 'none' },
    );
    assert.equal(resolved.obfuscate.level, 'aggressive');
    assert.deepEqual(resolved.configFiles, [
      path.join(root, 'build.config.json'),
      path.join(root, 'ssb.config.json'),
    ]);
    assert.equal(resolved.configFile, path.join(root, 'ssb.config.json'));
  });
});

test('uses only an explicitly selected config file', async () => {
  await withTemporaryDirectory(async (root) => {
    await write(root, 'build.config.json', JSON.stringify({ minify: 'aggressive' }));
    await write(root, 'ssb.config.json', JSON.stringify({ obfuscate: 'aggressive' }));
    await write(root, 'custom.config.json', JSON.stringify({ minify: 'none' }));

    const custom = path.join(root, 'custom.config.json');
    const resolved = await loadConfig({ cwd: root, configFile: custom });
    assert.equal(resolved.minify.level, 'none');
    assert.equal(resolved.obfuscate.level, 'none');
    assert.deepEqual(resolved.configFiles, [custom]);
  });
});

test('rejects removed enabled and mode configuration fields', async () => {
  await withTemporaryDirectory(async (root) => {
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { minify: { enabled: false } } }),
      /minify\.enabled 已移除/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { obfuscate: { mode: 'safe' } } }),
      /obfuscate\.enabled\/mode 已移除/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { transpile: { enabled: true } } }),
      /transpile\.enabled 已移除/,
    );
  });
});

test('keeps minification and obfuscation independent', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<script src="main.js"></script>');
    await write(site, 'main.js', `function publicFunction(inputValue) {
      const veryLongLocalName = inputValue + 1;
      if (false) console.log('dead');
      return veryLongLocalName;
    }
    globalThis.result = publicFunction(2);`);
    const result = await build({
      cwd: root, root: site,
      minify: { level: 'none', js: 'aggressive' },
      obfuscate: { level: 'safe' },
    });
    const output = await readFile(path.join(result.outDir, 'main.js'), 'utf8');
    assert.match(output, /publicFunction/);
    assert.doesNotMatch(output, /veryLongLocalName|dead/);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    assert.equal(context.result, 3);
  });
});

test('uses the effective per-file obfuscation level for excluded files', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<script src="main.js"></script>');
    await write(site, 'main.js', 'function publicFunction(value) { return value + 1; } globalThis.result = publicFunction(2);');
    const result = await build({
      cwd: root,
      root: site,
      minify: { js: 'aggressive' },
      obfuscate: { level: 'aggressive', exclude: ['main.js'] },
    });
    const output = await readFile(path.join(result.outDir, 'main.js'), 'utf8');
    assert.match(output, /publicFunction/);
  });
});

test('transpiles standalone, inline, and module JavaScript to ES5 syntax', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', `<button onclick="const value = () => 1; return value()">Run</button>
      <script src="main.js"></script>
      <script>const inlineRead = (value = 4) => value + 1; globalThis.inlineResult = inlineRead();</script>
      <script type="module" src="module.js"></script>`);
    await write(site, 'main.js', `const readValue = (input = {}) => {
      const record = { ...input };
      return record?.value ?? 7;
    };
    globalThis.es5Result = readValue({ value: 3 });`);
    await write(site, 'module.js', `import './dep.js'; export const moduleValue = () => 1;`);
    await write(site, 'dep.js', `export const dependencyValue = 2;`);

    const result = await build({
      cwd: root,
      root: site,
      minify: 'none',
      transpile: { target: 'es5' },
    });
    const output = await readFile(path.join(result.outDir, 'main.js'), 'utf8');
    const html = await readFile(path.join(result.outDir, 'index.html'), 'utf8');
    const moduleOutput = await readFile(path.join(result.outDir, 'module.js'), 'utf8');
    assert.doesNotMatch(output, /\bconst\b|=>|\?\.|\?\?/);
    assert.match(html, /onclick="[^"]*=>/);
    assert.match(moduleOutput, /import ['"]\.\/dep\.js['"]/);
    assert.match(moduleOutput, /export var moduleValue/);
    assert.doesNotMatch(moduleOutput, /=>|\bconst\b/);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(inline);
    assert.doesNotMatch(inline, /\bconst\b|=>/);
    vm.runInContext(inline, context);
    assert.equal(context.es5Result, 3);
    assert.equal(context.inlineResult, 5);
    assert.equal(result.files.transpiled, 4);
  });
});

test('transpile.exclude skips only Babel while keeping JavaScript minification', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<script src="main.js"></script><script src="vendor.js"></script>');
    await write(site, 'main.js', 'const mainValue = () => 1; globalThis.mainValue = mainValue();');
    await write(site, 'vendor.js', '/* removable */\nconst vendorValue = () => 2; globalThis.vendorValue = vendorValue();');
    const result = await build({
      cwd: root,
      root: site,
      minify: { level: 'none', js: 'safe' },
      transpile: { target: 'es5', exclude: ['vendor.js'] },
    });
    const main = await readFile(path.join(result.outDir, 'main.js'), 'utf8');
    const vendor = await readFile(path.join(result.outDir, 'vendor.js'), 'utf8');
    assert.doesNotMatch(main, /=>|\bconst\b/);
    assert.match(vendor, /=>|\bconst\b/);
    assert.doesNotMatch(vendor, /removable/);
  });
});

test('copies transform-excluded files byte-for-byte', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    const source = '/* keep */\nfunction vendorLongName () { return 1; }\n';
    await write(site, 'index.html', '<script src="vendor.js"></script>');
    await write(site, 'vendor.js', source);
    const result = await build({
      cwd: root,
      root: site,
      minify: 'aggressive',
      transpile: { target: 'es5' },
      transformExclude: ['vendor.js'],
    });
    assert.equal(await readFile(path.join(result.outDir, 'vendor.js'), 'utf8'), source);
  });
});

test('fails on missing, excluded, and unmatched required resources', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<img src="missing.png">');
    await assert.rejects(() => build({ cwd: root, root: site }), /必需资源不存在.*missing\.png/s);
    await write(site, 'missing.png', 'x');
    await assert.rejects(() => build({ cwd: root, root: site, exclude: ['missing.png'] }), /已被排除/s);
    await assert.rejects(() => build({ cwd: root, root: site, include: ['dynamic/*.json'] }), /include 未匹配/);
  });
});

test('dry-run validates processing without writing output', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<title> Test </title>');
    const outDir = path.join(root, 'release');
    await write(outDir, 'sentinel.txt', 'keep');
    const result = await build({ cwd: root, root: site, outDir, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(await readFile(path.join(outDir, 'sentinel.txt'), 'utf8'), 'keep');
    await assert.rejects(() => readFile(path.join(outDir, 'index.html')));
  });
});

test('preserves the previous output when processing fails', async () => {
  await withTemporaryDirectory(async (root) => {
    const site = path.join(root, 'site');
    await write(site, 'index.html', '<script src="broken.js"></script>');
    await write(site, 'broken.js', 'function broken( {');
    await write(site, 'dist/sentinel.txt', 'keep');
    await assert.rejects(() => build({ cwd: root, root: site }), /broken\.js/);
    assert.equal(await readFile(path.join(site, 'dist/sentinel.txt'), 'utf8'), 'keep');
  });
});

test('supports help, version, defaults, JSON output, and rejects conflicting options', async () => {
  let stdout = '';
  await runCli(['node', 'ssb', '--help'], { write: (text) => { stdout += text; } });
  assert.match(stdout, /Usage: ssb/);
  assert.match(stdout, /--minify-html \[level\]/);
  assert.match(stdout, /--optimize \[level\]/);
  assert.match(stdout, /-v, --version/);

  stdout = '';
  await runCli(['node', 'ssb', '--defaults'], { write: (text) => { stdout += text; } });
  const defaults = JSON.parse(stdout);
  assert.equal(defaults.minify.level, 'safe');
  assert.equal(defaults.obfuscate.level, 'none');
  assert.deepEqual(defaults.transpile, { target: 'modern', exclude: [] });

  await assert.rejects(
    () => runCli(['node', 'ssb', '--minify-js', 'safe', '--no-minify-js'], { write: () => undefined }),
    /不能同时使用/,
  );
  await assert.rejects(
    () => runCli(['node', 'ssb', '--optimize', 'safe', '--no-optimize'], { write: () => undefined }),
    /不能同时使用/,
  );
  await assert.rejects(
    () => runCli(['node', 'ssb', '--target', 'es2015'], { write: () => undefined }),
    /只能是 'modern' 或 'es5'/,
  );
  await assert.rejects(
    () => runCli(['node', 'ssb', '--json', '--list-files'], { write: () => undefined }),
    /不能同时使用/,
  );
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`✗ ${name}\n${error instanceof Error ? error.stack : String(error)}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed}/${tests.length} tests failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${tests.length} tests passed\n`);
}
