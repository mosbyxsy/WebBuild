import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import yauzl from 'yauzl';
import { build, loadConfig } from '../lib/extb/index.js';
import { runCli } from '../lib/extb/cli-runner.js';

// 使用极小的串行测试运行器，避免引入需要额外转译进程的测试框架。
// 每个测试直接导入 lib/ 发布代码，因此测试对象与 npm tarball 中的运行代码一致。
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

async function withTemporaryDirectory(run) {
  // 每个场景使用独立临时目录，并在成功或失败后统一清理，防止测试相互污染。
  const directory = await mkdtemp(path.join(os.tmpdir(), 'extb-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function write(directory, relativePath, content) {
  // 测试夹具统一使用 POSIX 相对路径，再转换成当前平台的真实路径。
  const filePath = path.join(directory, ...relativePath.split('/'));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

async function createExtension(directory, version = '1.2.3') {
  // 该夹具同时覆盖 manifest 引用、HTML 内联资源、独立 JS/CSS 和二进制资源。
  await write(
    directory,
    'manifest.json',
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Fixture Extension',
        version,
        action: { default_popup: 'popup.html' },
        background: { service_worker: 'scripts/background.js' },
      },
      null,
      2,
    ),
  );
  await write(
    directory,
    'popup.html',
    `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="styles/popup.css">
    <style> .inline { color: rgb(255, 0, 0); } </style>
  </head>
  <body>
    <p>Hello <strong>extension</strong></p>
    <script>function inlineValue() { return 2 + 2; } globalThis.inlineResult = inlineValue();</script>
    <script src="scripts/background.js"></script>
  </body>
</html>`,
  );
  await write(
    directory,
    'scripts/background.js',
    `/*! license */
// removable comment
function publicBackgroundName(inputValue) {
  const localLongName = inputValue + 1;
  return localLongName;
}
globalThis.runExtension = publicBackgroundName;
`,
  );
  await write(
    directory,
    'styles/popup.css',
    `.icon {
  color: rgb(255, 0, 0);
  background-image: url('../images/icon.bin');
}
`,
  );
  await write(directory, 'images/icon.bin', Buffer.from([0, 1, 2, 255, 128, 64]));
  // 这些开发文件没有进入依赖图，必须留在源码目录而不能出现在产物中。
  await write(directory, '.idea/workspace.xml', '<project />');
  await write(directory, 'notes.txt', 'development notes');
  await write(directory, 'scripts/unused.js', 'globalThis.shouldNotShip = true;');
}

async function zipEntries(zipPath) {
  // 懒读取 ZIP 中央目录即可验证条目，不需要把文件内容解压到磁盘。
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error('ZIP could not be opened'));
        return;
      }
      const entries = [];
      zipFile.once('error', reject);
      zipFile.once('end', () => resolve(entries));
      zipFile.on('entry', (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.readEntry();
    });
  });
}

test('uses safe configuration defaults', async () => {
  await withTemporaryDirectory(async (root) => {
    const resolved = await loadConfig({ cwd: root, configFile: false });
    assert.equal(resolved.root, root);
    assert.equal(resolved.outDir, path.join(root, 'dist'));
    assert.deepEqual(
      { level: resolved.minify.level, html: resolved.minify.html, js: resolved.minify.js, css: resolved.minify.css },
      { level: 'safe', html: 'safe', js: 'safe', css: 'safe' },
    );
    assert.equal(resolved.obfuscate.level, 'none');
    assert.deepEqual(resolved.transpile, { target: 'modern', exclude: [] });
    assert.deepEqual(resolved.transformExclude, []);
    assert.equal(resolved.zip.enabled, false);
  });
});

test('rejects removed boolean, enabled, and mode configuration with migration guidance', async () => {
  await withTemporaryDirectory(async (root) => {
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { minify: false } }),
      /minify 必须是压缩等级或对象/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { minify: { enabled: false } } }),
      /minify\.enabled 已移除/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { obfuscate: { mode: 'safe' } } }),
      /obfuscate\.enabled\/mode 已移除/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { transpile: true } }),
      /transpile 必须是 'modern'、'es5' 或对象/,
    );
    await assert.rejects(
      () => loadConfig({ cwd: root, configFile: false, overrides: { transpile: { enabled: true } } }),
      /transpile\.enabled 已移除/,
    );
  });
});

test('rejects ambiguous automatic config discovery', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeFile(path.join(root, 'extb.config.json'), '{}');
    await writeFile(path.join(root, 'extb.config.mjs'), 'export default {};');
    await assert.rejects(() => loadConfig({ cwd: root }), /多个 extb 配置文件/);
  });
});

test('rejects ambiguous shared build config discovery', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeFile(path.join(root, 'build.config.json'), '{}');
    await writeFile(path.join(root, 'build.config.mjs'), 'export default {};');
    await assert.rejects(() => loadConfig({ cwd: root }), /多个 build 配置文件/);
  });
});

test('loads build config before the higher-priority extb config', async () => {
  await withTemporaryDirectory(async (root) => {
    await write(
      root,
      'build.config.json',
      JSON.stringify({
        outDir: './common-dist',
        include: ['common/**'],
        minify: 'aggressive',
        obfuscate: 'safe',
      }),
    );
    await write(
      root,
      'extb.config.json',
      JSON.stringify({
        outDir: './extension-dist',
        include: ['extension/**'],
        minify: { html: 'none' },
        obfuscate: 'aggressive',
      }),
    );

    const resolved = await loadConfig({ cwd: root });
    assert.equal(resolved.outDir, path.join(root, 'extension-dist'));
    assert.deepEqual(resolved.include, ['common/**', 'extension/**']);
    assert.deepEqual(
      { html: resolved.minify.html, js: resolved.minify.js, css: resolved.minify.css },
      { html: 'none', js: 'aggressive', css: 'aggressive' },
    );
    assert.equal(resolved.obfuscate.level, 'aggressive');
    assert.deepEqual(resolved.configFiles, [
      path.join(root, 'build.config.json'),
      path.join(root, 'extb.config.json'),
    ]);
    assert.equal(resolved.configFile, path.join(root, 'extb.config.json'));
  });
});

test('uses only an explicitly selected config file', async () => {
  await withTemporaryDirectory(async (root) => {
    await write(root, 'build.config.json', JSON.stringify({ minify: 'aggressive' }));
    await write(root, 'extb.config.json', JSON.stringify({ obfuscate: 'aggressive' }));
    await write(root, 'custom.config.json', JSON.stringify({ minify: 'none' }));

    const custom = path.join(root, 'custom.config.json');
    const resolved = await loadConfig({ cwd: root, configFile: custom });
    assert.equal(resolved.minify.level, 'none');
    assert.equal(resolved.obfuscate.level, 'none');
    assert.deepEqual(resolved.configFiles, [custom]);
  });
});

test('resolves config paths relative to the config file', async () => {
  await withTemporaryDirectory(async (root) => {
    const configDirectory = path.join(root, 'config');
    await mkdir(configDirectory);
    await writeFile(
      path.join(configDirectory, 'custom.json'),
      JSON.stringify({ root: '../extension', outDir: '../release', manifest: '../extension/manifest.json' }),
    );
    const resolved = await loadConfig({ cwd: root, configFile: './config/custom.json' });
    assert.equal(resolved.root, path.join(root, 'extension'));
    assert.equal(resolved.outDir, path.join(root, 'release'));
    assert.equal(resolved.manifest, path.join(root, 'extension', 'manifest.json'));
  });
});

test('finds a nested manifest, preserves paths, minifies files, copies binary data, and creates a ZIP', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'sample-extension');
    await createExtension(extension);
    const manifestBefore = await readFile(path.join(extension, 'manifest.json'));
    const binaryBefore = await readFile(path.join(extension, 'images/icon.bin'));

    const result = await build({ cwd: root, zip: true });
    assert.equal(result.outDir, path.join(root, 'dist'));
    assert.equal(result.zipPath, path.join(root, 'dist', 'sample-extension-1.2.3.zip'));
    assert.deepEqual(await readFile(path.join(result.outDir, 'manifest.json')), manifestBefore);
    assert.deepEqual(await readFile(path.join(result.outDir, 'images/icon.bin')), binaryBefore);
    await assert.rejects(() => readFile(path.join(result.outDir, '.idea/workspace.xml')));
    await assert.rejects(() => readFile(path.join(result.outDir, 'notes.txt')));
    await assert.rejects(() => readFile(path.join(result.outDir, 'scripts/unused.js')));

    const html = await readFile(path.join(result.outDir, 'popup.html'), 'utf8');
    const javaScript = await readFile(path.join(result.outDir, 'scripts/background.js'), 'utf8');
    const css = await readFile(path.join(result.outDir, 'styles/popup.css'), 'utf8');
    assert.match(html, /src="scripts\/background\.js"/);
    assert.match(html, /href="styles\/popup\.css"/);
    assert.match(javaScript, /publicBackgroundName/);
    assert.match(javaScript, /\/\*! license \*\//);
    assert.doesNotMatch(javaScript, /removable comment/);
    assert.match(css, /url\(['"]?\.\.\/images\/icon\.bin['"]?\)/);
    assert.ok(css.length < 100);

    const entries = await zipEntries(result.zipPath);
    assert.deepEqual(
      entries.sort(),
      ['images/icon.bin', 'manifest.json', 'popup.html', 'scripts/background.js', 'styles/popup.css'].sort(),
    );
    assert.ok(entries.every((entry) => !entry.endsWith('.zip')));
    assert.deepEqual(result.files, { copied: 2, html: 1, js: 1, css: 1, obfuscated: 0, transpiled: 0 });
    assert.ok(result.bytesAfter < result.bytesBefore);
  });
});

test('ignores the default output directory when discovering a manifest on repeated builds', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await createExtension(extension);

    const first = await build({ cwd: root, zip: false });
    assert.equal(first.manifestPath, path.join(extension, 'manifest.json'));
    // 第一次构建已经在 root/dist 中生成了第二份 manifest；再次构建仍必须选中源码。
    const second = await build({ cwd: root, zip: false });
    assert.equal(second.manifestPath, path.join(extension, 'manifest.json'));
    assert.equal(second.outDir, path.join(root, 'dist'));
  });
});

test('ignores a custom output directory and stale temporary output during manifest discovery', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    const customOutput = path.join(root, 'artifacts', 'browser-package');
    await createExtension(extension);
    // 模拟上一次自定义输出和异常中断留下的备份，两者都包含合法 manifest。
    await createExtension(customOutput);
    await createExtension(path.join(root, '.browser-package.extb-backup-stale'));

    const result = await build({
      cwd: root,
      outDir: customOutput,
      zip: false,
    });
    assert.equal(result.manifestPath, path.join(extension, 'manifest.json'));
    assert.equal(result.outDir, customOutput);
  });
});

test('reports multiple manifests and accepts an explicit manifest', async () => {
  await withTemporaryDirectory(async (root) => {
    await createExtension(path.join(root, 'one'));
    await createExtension(path.join(root, 'two'));
    await assert.rejects(() => build({ cwd: root, zip: false }), /多个 manifest\.json/);

    const result = await build({
      cwd: root,
      manifest: './two/manifest.json',
      outDir: './selected',
      minify: 'none',
      zip: false,
    });
    assert.equal(result.sourceDir, path.join(root, 'two'));
    assert.match(await readFile(path.join(result.outDir, 'scripts/background.js'), 'utf8'), /removable comment/);
  });
});

test('recursively follows JavaScript modules, runtime URLs, workers, DNR redirects, and resource globs', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 3,
        name: 'Dependency Graph',
        version: '1.0.0',
        default_locale: 'en',
        background: { service_worker: 'main.mjs', type: 'module' },
        declarative_net_request: {
          rule_resources: [{ id: 'rules', enabled: true, path: 'rules/rules.json' }],
        },
        web_accessible_resources: [{ resources: ['public/*'], matches: ['<all_urls>'] }],
      }),
    );
    await write(
      extension,
      'main.mjs',
      `import { value } from './scripts/helper.mjs';
       const worker = new Worker('./workers/task.js');
       globalThis.icon = chrome.runtime.getURL('assets/icon.svg');
       globalThis.value = value;
       void worker;`,
    );
    await write(extension, 'scripts/helper.mjs', `export const value = fetch('../data/value.json');`);
    await write(extension, 'workers/task.js', `importScripts('../workers/vendor.js');`);
    await write(extension, 'workers/vendor.js', `globalThis.vendorLoaded = true;`);
    await write(extension, 'assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await write(extension, 'data/value.json', '{"value":1}');
    await write(
      extension,
      'rules/rules.json',
      JSON.stringify([{ id: 1, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/redirect.html' } } }]),
    );
    await write(extension, 'redirect.html', '<!doctype html><link rel="stylesheet" href="redirect.css">');
    await write(extension, 'redirect.css', '.redirect{background:url("assets/redirect.png")}');
    await write(extension, 'assets/redirect.png', Buffer.from([1, 2, 3]));
    await write(extension, 'public/nested/exposed.js', 'globalThis.exposed = true;');
    await write(extension, '_locales/en/messages.json', '{"name":{"message":"Dependency Graph"}}');
    await write(extension, 'private/not-required.txt', 'do not ship');

    const result = await build({ cwd: root, root: './extension', zip: false });
    for (const required of [
      'main.mjs',
      'scripts/helper.mjs',
      'workers/task.js',
      'workers/vendor.js',
      'assets/icon.svg',
      'data/value.json',
      'rules/rules.json',
      'redirect.html',
      'redirect.css',
      'assets/redirect.png',
      'public/nested/exposed.js',
      '_locales/en/messages.json',
    ]) {
      await readFile(path.join(result.outDir, ...required.split('/')));
    }
    await assert.rejects(() => readFile(path.join(result.outDir, 'private/not-required.txt')));
  });
});

test('supports include globs for dynamic resources and continues tracing included entries', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({ manifest_version: 3, name: 'Dynamic Resources', version: '1.0.0', background: { service_worker: 'loader.js' } }),
    );
    await write(extension, 'loader.js', "const name = 'settings'; chrome.runtime.getURL(`data/${name}.json`);");
    await write(extension, 'data/settings.json', '{"enabled":true}');
    await write(extension, 'dynamic/page.html', '<script src="page.js"></script>');
    await write(extension, 'dynamic/page.js', 'globalThis.dynamicPage = true;');
    await write(extension, 'unrelated.txt', 'do not ship');

    const result = await build({
      cwd: root,
      root: './extension',
      include: ['data/**', 'dynamic/page.html'],
      zip: false,
    });
    await readFile(path.join(result.outDir, 'data/settings.json'));
    await readFile(path.join(result.outDir, 'dynamic/page.html'));
    await readFile(path.join(result.outDir, 'dynamic/page.js'));
    await assert.rejects(() => readFile(path.join(result.outDir, 'unrelated.txt')));
  });
});

test('fails instead of producing an incomplete package when a required resource is missing', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({ manifest_version: 3, name: 'Missing Resource', version: '1.0.0', action: { default_popup: 'missing.html' } }),
    );
    await assert.rejects(() => build({ cwd: root, root: './extension', zip: false }), /必需资源不存在.*missing\.html/s);
  });
});

test('loads TypeScript config and applies programmatic overrides', async () => {
  await withTemporaryDirectory(async (root) => {
    await createExtension(path.join(root, 'extension'));
    await write(
      root,
      'extb.config.ts',
      `export default {
        root: './extension',
        outDir: './from-config',
        minify: 'none',
        zip: false,
      };`,
    );
    const loaded = await loadConfig({ cwd: root });
    assert.equal(loaded.root, path.join(root, 'extension'));
    assert.equal(loaded.minify.js, 'none');

    const result = await build({
      cwd: root,
      outDir: './from-options',
      minify: { js: 'safe', html: 'none', css: 'none' },
    });
    assert.equal(result.outDir, path.join(root, 'from-options'));
    assert.equal(result.zipPath, undefined);
    assert.match(await readFile(path.join(result.outDir, 'popup.html'), 'utf8'), /\n  <head>/);
    assert.doesNotMatch(await readFile(path.join(result.outDir, 'scripts/background.js'), 'utf8'), /removable comment/);
    assert.match(await readFile(path.join(result.outDir, 'styles/popup.css'), 'utf8'), /\n  color:/);
  });
});

test('accumulates and deduplicates rule arrays across configuration layers', async () => {
  await withTemporaryDirectory(async (root) => {
    await write(
      root,
      'extb.config.json',
      JSON.stringify({
        include: ['shared/**', 'config-only/**'],
        exclude: ['shared.tmp', 'config.tmp'],
        transformExclude: ['vendor/**'],
        minify: { exclude: ['generated/**'] },
        obfuscate: { exclude: ['vendor/**'], reservedNames: ['publicApi'] },
        transpile: { exclude: ['legacy/**'] },
      }),
    );
    const loaded = await loadConfig({
      cwd: root,
      overrides: {
        include: ['shared/**', 'cli-only/**'],
        exclude: ['shared.tmp', 'cli.tmp'],
        transformExclude: ['vendor/**', 'raw/**'],
        minify: { exclude: ['generated/**', 'raw-js/**'] },
        obfuscate: { exclude: ['third-party/**'], reservedNames: ['publicApi', 'externalApi'] },
        transpile: { exclude: ['legacy/**', 'modern-only/**'] },
      },
    });

    assert.deepEqual(loaded.include, ['shared/**', 'config-only/**', 'cli-only/**']);
    assert.equal(loaded.exclude.filter((value) => value === 'shared.tmp').length, 1);
    assert.ok(loaded.exclude.includes('config.tmp'));
    assert.ok(loaded.exclude.includes('cli.tmp'));
    assert.deepEqual(loaded.transformExclude, ['vendor/**', 'raw/**']);
    assert.deepEqual(loaded.minify.exclude, ['generated/**', 'raw-js/**', 'vendor/**', 'raw/**']);
    assert.deepEqual(loaded.obfuscate.exclude, ['vendor/**', 'third-party/**', 'raw/**']);
    assert.deepEqual(loaded.obfuscate.reservedNames, ['publicApi', 'externalApi']);
    assert.deepEqual(loaded.transpile.exclude, ['legacy/**', 'modern-only/**', 'vendor/**', 'raw/**']);
  });
});

test('obfuscates local identifiers while preserving behavior and public names', async () => {
  await withTemporaryDirectory(async (root) => {
    await createExtension(path.join(root, 'extension'));
    const result = await build({
      cwd: root,
      root: './extension',
      obfuscate: { level: 'safe', reservedNames: ['inputValue'] },
      zip: false,
    });
    const output = await readFile(path.join(result.outDir, 'scripts/background.js'), 'utf8');
    assert.match(output, /publicBackgroundName/);
    assert.match(output, /inputValue/);
    assert.doesNotMatch(output, /localLongName/);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    assert.equal(context.runExtension(5), 6);
    assert.equal(result.files.obfuscated, 2);
  });
});

test('transpiles modern JavaScript syntax to ES5 while preserving behavior', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 2,
        name: 'ES5 Fixture',
        version: '1.0.0',
        background: { scripts: ['modern.js'] },
        browser_action: { default_popup: 'popup.html' },
      }),
    );
    await write(
      extension,
      'modern.js',
      `const readValue = (input = {}) => {
        const record = { ...input };
        return record?.value ?? 7;
      };
      globalThis.es5Result = readValue({ value: 3 });`,
    );
    await write(
      extension,
      'popup.html',
      `<script>const inlineModernFunction = (value = 4) => value + 1;
      globalThis.inlineEs5Result = inlineModernFunction();</script>`,
    );

    const result = await build({ cwd: root, root: './extension', transpile: 'es5', zip: false });
    const output = await readFile(path.join(result.outDir, 'modern.js'), 'utf8');
    const htmlOutput = await readFile(path.join(result.outDir, 'popup.html'), 'utf8');
    assert.doesNotMatch(output, /\bconst\b|=>|\?\.|\?\?/);
    assert.doesNotMatch(htmlOutput, /\bconst\b|=>/);
    assert.match(output, /\bvar\b/);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    vm.runInContext(htmlOutput.match(/<script>(.*?)<\/script>/s)[1], context);
    assert.equal(context.es5Result, 3);
    assert.equal(context.inlineEs5Result, 5);
    assert.equal(result.files.transpiled, 2);
  });
});

test('supports aggressive compression and top-level identifier obfuscation', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 3,
        name: 'Aggressive Fixture',
        version: '1.0.0',
        background: { service_worker: 'aggressive.js' },
      }),
    );
    const source = `function calculatePublicResult(inputValue) {
      const veryLongIntermediateName = inputValue * 2;
      if (false) console.log('dead code');
      return veryLongIntermediateName;
    }
    globalThis.aggressiveResult = calculatePublicResult(4);`;
    await write(extension, 'aggressive.js', source);

    const result = await build({
      cwd: root,
      root: './extension',
      minify: { js: 'aggressive' },
      obfuscate: { level: 'aggressive' },
      zip: false,
    });
    const output = await readFile(path.join(result.outDir, 'aggressive.js'), 'utf8');
    assert.doesNotMatch(output, /calculatePublicResult|veryLongIntermediateName|dead code/);
    assert.ok(output.length < source.length / 2);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    assert.equal(context.aggressiveResult, 8);
    assert.equal(result.files.obfuscated, 1);
  });
});

test('keeps aggressive compression and aggressive obfuscation independently configurable', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 3,
        name: 'Independent Levels',
        version: '1.0.0',
        background: { service_worker: 'main.js' },
      }),
    );
    await write(
      extension,
      'main.js',
      `function calculatePublicResult(inputValue) {
        const verboseLocalValue = inputValue * 2;
        if (false) console.log('dead code');
        return verboseLocalValue;
      }
      globalThis.result = calculatePublicResult(4);
      globalThis.functionName = calculatePublicResult.name;`,
    );

    const compressed = await build({
      cwd: root,
      root: extension,
      outDir: './compressed',
      minify: { js: 'aggressive' },
      obfuscate: 'none',
    });
    const compressedCode = await readFile(path.join(compressed.outDir, 'main.js'), 'utf8');
    assert.doesNotMatch(compressedCode, /dead code/);
    const compressedContext = vm.createContext({});
    vm.runInContext(compressedCode, compressedContext);
    assert.equal(compressedContext.result, 8);
    assert.equal(compressedContext.functionName, 'calculatePublicResult');

    const obfuscated = await build({
      cwd: root,
      root: extension,
      outDir: './obfuscated',
      minify: { js: 'none' },
      obfuscate: 'aggressive',
    });
    const obfuscatedCode = await readFile(path.join(obfuscated.outDir, 'main.js'), 'utf8');
    assert.match(obfuscatedCode, /dead code/);
    assert.doesNotMatch(obfuscatedCode, /function calculatePublicResult/);
    const obfuscatedContext = vm.createContext({});
    vm.runInContext(obfuscatedCode, obfuscatedContext);
    assert.equal(obfuscatedContext.result, 8);
    assert.notEqual(obfuscatedContext.functionName, 'calculatePublicResult');
  });
});

test('applies aggressive HTML and CSS optimization only at the aggressive level', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 3,
        name: 'Markup Levels',
        version: '1.0.0',
        action: { default_popup: 'popup.html' },
      }),
    );
    await write(
      extension,
      'popup.html',
      '<!DOCTYPE html><link rel="stylesheet" type="text/css" href="style.css"><div class="a">A</div>',
    );
    await write(extension, 'style.css', '.a { color: red; } .b { color: red; }');

    const safe = await build({ cwd: root, root: extension, outDir: './safe', minify: 'safe' });
    const safeHtml = await readFile(path.join(safe.outDir, 'popup.html'), 'utf8');
    const safeCss = await readFile(path.join(safe.outDir, 'style.css'), 'utf8');
    assert.match(safeHtml, /type="text\/css"/);
    assert.match(safeHtml, /class="a"/);
    assert.doesNotMatch(safeCss, /\.a,\.b/);

    const aggressive = await build({ cwd: root, root: extension, outDir: './aggressive', minify: 'aggressive' });
    const aggressiveHtml = await readFile(path.join(aggressive.outDir, 'popup.html'), 'utf8');
    const aggressiveCss = await readFile(path.join(aggressive.outDir, 'style.css'), 'utf8');
    assert.doesNotMatch(aggressiveHtml, /type=/);
    assert.match(aggressiveHtml, /class=a/);
    assert.match(aggressiveCss, /\.a,\.b\{color:red\}/);
  });
});

test('keeps the previous output when processing fails', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await createExtension(extension);
    await write(extension, 'scripts/background.js', 'function broken( {');
    await write(root, 'dist/sentinel.txt', 'keep me');
    await assert.rejects(() => build({ cwd: root, zip: false }), /scripts\/background\.js/);
    assert.equal(await readFile(path.join(root, 'dist/sentinel.txt'), 'utf8'), 'keep me');
  });
});

test('rejects output directories that contain the source directory', async () => {
  await withTemporaryDirectory(async (root) => {
    await createExtension(path.join(root, 'extension'));
    await assert.rejects(
      () => build({ cwd: root, root: './extension', outDir: root, zip: false }),
      /输出目录不能/,
    );
  });
});

test('runs the compiled CLI and honors negated flags', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await createExtension(extension);
    await write(extension, 'dynamic.json', '{"included":true}');
    let stdout = '';
    await runCli(
      [
        process.execPath,
        'extb',
        extension,
        '--out-dir',
        path.join(root, 'cli-output'),
        '--no-minify',
        '--no-zip',
        '--include',
        'dynamic.json',
      ],
      { write: (text) => (stdout += text) },
    );
    assert.match(stdout, /extb: 已输出到/);
    assert.match(await readFile(path.join(root, 'cli-output', 'scripts/background.js'), 'utf8'), /removable comment/);
    assert.equal(await readFile(path.join(root, 'cli-output', 'dynamic.json'), 'utf8'), '{"included":true}');
    await assert.rejects(() => readFile(path.join(root, 'cli-output', 'extension-1.2.3.zip')));
  });
});

test('keeps ZIP disabled by default and lets zip-name enable it explicitly', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await createExtension(extension);

    const defaultResult = await build({ cwd: root, root: extension });
    assert.equal(defaultResult.zipPath, undefined);

    let stdout = '';
    await runCli(
      [
        process.execPath,
        'extb',
        extension,
        '--manifest',
        path.join(extension, 'manifest.json'),
        '--out-dir',
        path.join(root, 'zip-output'),
        '--zip-name',
        'custom-release.zip',
      ],
      { commandName: 'extb', write: (text) => (stdout += text) },
    );
    await readFile(path.join(root, 'zip-output', 'custom-release.zip'));
    assert.match(stdout, /ZIP: .*custom-release\.zip/);
  });
});

test('dry-run validates and transforms the complete build without writing output', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    const plannedOutput = path.join(root, 'planned-output');
    await createExtension(extension);
    await write(plannedOutput, 'sentinel.txt', 'keep me');

    const result = await build({
      cwd: root,
      root: extension,
      outDir: plannedOutput,
      zip: true,
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.zipPath, undefined);
    assert.equal(result.plannedZipPath, path.join(plannedOutput, 'extension-1.2.3.zip'));
    assert.deepEqual(result.includedFiles, [
      'images/icon.bin',
      'manifest.json',
      'popup.html',
      'scripts/background.js',
      'styles/popup.css',
    ]);
    assert.ok(result.bytesAfter < result.bytesBefore);
    assert.equal(await readFile(path.join(plannedOutput, 'sentinel.txt'), 'utf8'), 'keep me');
    await assert.rejects(() => readFile(path.join(plannedOutput, 'manifest.json')));
    await assert.rejects(() => readFile(path.join(plannedOutput, 'extension-1.2.3.zip')));
  });
});

test('supports dry-run file listing and quiet successful builds in the CLI', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    const previewOutput = path.join(root, 'preview-output');
    await createExtension(extension);

    let stdout = '';
    await runCli(
      [
        process.execPath,
        'extb',
        extension,
        '--out-dir',
        previewOutput,
        '--dry-run',
        '--list-files',
        '--zip',
      ],
      { commandName: 'extb', write: (text) => (stdout += text) },
    );
    assert.match(stdout, /预演完成，未写入/);
    assert.match(stdout, /计划 ZIP:/);
    assert.match(stdout, /包含文件 \(5\):/);
    assert.match(stdout, /  manifest\.json/);
    assert.doesNotMatch(stdout, /unused\.js/);
    await assert.rejects(() => readFile(path.join(previewOutput, 'manifest.json')));

    stdout = '';
    const quietOutput = path.join(root, 'quiet-output');
    await runCli(
      [process.execPath, 'extb', extension, '--out-dir', quietOutput, '--quiet'],
      { commandName: 'extb', write: (text) => (stdout += text) },
    );
    assert.equal(stdout, '');
    await readFile(path.join(quietOutput, 'manifest.json'));
  });
});

test('parses optional processing levels without consuming the positional root', async () => {
  let receivedOptions;
  await assert.rejects(
    () =>
      runCli([process.execPath, 'extb', '--minify', 'extension'], {
        commandName: 'extb',
        build: async (options) => {
          receivedOptions = options;
          throw new Error('停止测试构建');
        },
      }),
    /停止测试构建/,
  );
  assert.equal(receivedOptions.root, 'extension');
  assert.deepEqual(receivedOptions.minify, { level: 'safe' });

  await assert.rejects(
    () =>
      runCli([process.execPath, 'extb', '--optimize', 'extension'], {
        commandName: 'extb',
        build: async (options) => {
          receivedOptions = options;
          throw new Error('停止测试构建');
        },
      }),
    /停止测试构建/,
  );
  assert.equal(receivedOptions.root, 'extension');
  assert.deepEqual(receivedOptions.minify, { level: 'safe' });
  assert.deepEqual(receivedOptions.obfuscate, { level: 'safe' });

  await assert.rejects(
    () =>
      runCli(
        [
          process.execPath,
          'extb',
          'extension',
          '--minify',
          'aggressive',
          '--minify-html',
          'safe',
          '--no-minify-js',
          '--obfuscate',
          'aggressive',
        ],
        {
          commandName: 'extb',
          build: async (options) => {
            receivedOptions = options;
            throw new Error('停止测试构建');
          },
        },
      ),
    /停止测试构建/,
  );
  assert.deepEqual(receivedOptions.minify, { level: 'aggressive', html: 'safe', js: 'none' });
  assert.deepEqual(receivedOptions.obfuscate, { level: 'aggressive' });

  await assert.rejects(
    () =>
      runCli(
        [
          process.execPath,
          'extb',
          'extension',
          '--obfuscate',
          'safe',
          '--no-minify-css',
          '--optimize',
          'aggressive',
        ],
        {
          commandName: 'extb',
          build: async (options) => {
            receivedOptions = options;
            throw new Error('停止测试构建');
          },
        },
      ),
    /停止测试构建/,
  );
  assert.deepEqual(receivedOptions.minify, { level: 'aggressive', css: 'none' });
  assert.deepEqual(receivedOptions.obfuscate, { level: 'safe' });

  await assert.rejects(
    () =>
      runCli([process.execPath, 'extb', 'extension', '--no-optimize'], {
        commandName: 'extb',
        build: async (options) => {
          receivedOptions = options;
          throw new Error('停止测试构建');
        },
      }),
    /停止测试构建/,
  );
  assert.deepEqual(receivedOptions.minify, { level: 'none' });
  assert.deepEqual(receivedOptions.obfuscate, { level: 'none' });

  await assert.rejects(
    () => runCli([process.execPath, 'extb', 'extension', '--minify=invalid']),
    /只能是 'none'、'safe' 或 'aggressive'/,
  );
  await assert.rejects(
    () => runCli([process.execPath, 'extb', 'extension', '--optimize=invalid']),
    /只能是 'none'、'safe' 或 'aggressive'/,
  );
});

test('enables aggressive JavaScript processing and ES5 output through CLI flags', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await write(
      extension,
      'manifest.json',
      JSON.stringify({
        manifest_version: 3,
        name: 'CLI JavaScript Fixture',
        version: '1.0.0',
        background: { service_worker: 'main.js' },
      }),
    );
    await write(
      extension,
      'main.js',
      `const verboseTopLevelFunction = (input = 2) => {
        const verboseLocalValue = input + 1;
        return verboseLocalValue;
      };
      globalThis.cliResult = verboseTopLevelFunction();`,
    );
    let stdout = '';
    await runCli(
      [
        process.execPath,
        'extb',
        extension,
        '--out-dir',
        path.join(root, 'cli-js-output'),
        '--minify-js',
        'aggressive',
        '--obfuscate',
        'aggressive',
        '--target',
        'es5',
        '--no-zip',
      ],
      { write: (text) => (stdout += text) },
    );
    const output = await readFile(path.join(root, 'cli-js-output', 'main.js'), 'utf8');
    assert.doesNotMatch(output, /=>|\bconst\b|verboseTopLevelFunction|verboseLocalValue/);
    const context = vm.createContext({});
    vm.runInContext(output, context);
    assert.equal(context.cliResult, 3);
    assert.match(stdout, /混淆 1；转译 1/);
  });
});

test('supports no-config, no-transform, keep-name, and JSON CLI output', async () => {
  await withTemporaryDirectory(async (root) => {
    const extension = path.join(root, 'extension');
    await createExtension(extension);
    const originalPopup = await readFile(path.join(extension, 'popup.html'), 'utf8');
    // 无效配置用于证明 --no-config 确实跳过了自动发现，而不是碰巧加载成功。
    await write(extension, 'extb.config.json', '{ invalid json');

    let stdout = '';
    await runCli(
      [
        process.execPath,
        'extb',
        extension,
        '--no-config',
        '--obfuscate',
        '--keep-name',
        'localLongName',
        '--no-transform',
        'popup.html',
        '--no-zip',
        '--json',
      ],
      { commandName: 'extb', write: (text) => (stdout += text) },
    );

    const result = JSON.parse(stdout);
    assert.equal(result.dryRun, false);
    assert.equal(result.outDir, path.join(extension, 'dist'));
    assert.equal(result.zipPath, undefined);
    assert.equal(result.files.obfuscated, 1);
    assert.ok(result.includedFiles.includes('manifest.json'));
    assert.equal(await readFile(path.join(result.outDir, 'popup.html'), 'utf8'), originalPopup);
    assert.match(await readFile(path.join(result.outDir, 'scripts/background.js'), 'utf8'), /localLongName/);
    assert.doesNotMatch(stdout, /extb: 已输出到/);
  });
});

test('rejects contradictory CLI flags before starting a build', async () => {
  let buildCalls = 0;
  const buildStub = async () => {
    buildCalls += 1;
    throw new Error('冲突参数不应启动构建');
  };
  const conflicts = [
    ['--config', 'extb.config.ts', '--no-config'],
    ['--optimize', 'safe', '--no-optimize'],
    ['--minify', 'safe', '--no-minify'],
    ['--minify-html', 'safe', '--no-minify-html'],
    ['--minify-js', 'aggressive', '--no-minify-js'],
    ['--minify-css', 'safe', '--no-minify-css'],
    ['--obfuscate', 'aggressive', '--no-obfuscate'],
    ['--zip-name', 'release.zip', '--no-zip'],
    ['--quiet', '--json'],
    ['--quiet', '--list-files'],
    ['--json', '--list-files'],
    ['--defaults', '--show-config'],
  ];
  for (const flags of conflicts) {
    await assert.rejects(
      () => runCli([process.execPath, 'extb', ...flags], { commandName: 'extb', build: buildStub }),
      /不能同时使用/,
    );
  }
  assert.equal(buildCalls, 0);
});

test('suppresses Commander duplicate error output', async () => {
  let stdout = '';
  await assert.rejects(
    () => runCli([process.execPath, 'extb', '--target', 'invalid'], { write: (text) => (stdout += text) }),
    /只能是 'modern' 或 'es5'/,
  );
  assert.equal(stdout, '');
});

test('prints built-in defaults through an option without starting a build', async () => {
  let stdout = '';
  let buildCalls = 0;
  await runCli([process.execPath, 'extb', '--defaults'], {
    commandName: 'extb',
    build: async () => {
      buildCalls += 1;
      throw new Error('--defaults 不应启动构建');
    },
    write: (text) => (stdout += text),
  });

  const defaults = JSON.parse(stdout);
  assert.equal(defaults.root, '.');
  assert.equal(defaults.outDir, './dist');
  assert.deepEqual(
    { level: defaults.minify.level, html: defaults.minify.html, js: defaults.minify.js, css: defaults.minify.css },
    { level: 'safe', html: 'safe', js: 'safe', css: 'safe' },
  );
  assert.equal(defaults.obfuscate.level, 'none');
  assert.deepEqual(defaults.transpile, { target: 'modern', exclude: [] });
  assert.deepEqual(defaults.zip, { enabled: false });
  assert.ok(defaults.exclude.includes('node_modules'));
  assert.equal(buildCalls, 0);
});

test('prints the merged final configuration without finding a manifest or starting a build', async () => {
  await withTemporaryDirectory(async (root) => {
    const configPath = path.join(root, 'custom.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        outDir: './release',
        include: ['from-config/**'],
        minify: 'none',
        zip: true,
      }),
    );

    let stdout = '';
    let buildCalls = 0;
    await runCli(
      [
        process.execPath,
        'extb',
        root,
        '--config',
        configPath,
        '--show-config',
        '--minify-js',
        '--no-zip',
        '--include',
        'from-cli/**',
      ],
      {
        commandName: 'extb',
        build: async () => {
          buildCalls += 1;
          throw new Error('--show-config 不应启动构建');
        },
        write: (text) => (stdout += text),
      },
    );

    const resolved = JSON.parse(stdout);
    assert.equal(resolved.root, root);
    assert.equal(resolved.outDir, path.join(root, 'release'));
    assert.equal(resolved.configFile, configPath);
    assert.deepEqual(resolved.include, ['from-config/**', 'from-cli/**']);
    assert.deepEqual(
      { level: resolved.minify.level, html: resolved.minify.html, js: resolved.minify.js, css: resolved.minify.css },
      { level: 'none', html: 'none', js: 'safe', css: 'none' },
    );
    assert.equal(resolved.zip.enabled, false);
    assert.equal(buildCalls, 0);
  });
});

test('keeps a directory named defaults available as the positional root', async () => {
  let receivedOptions;
  await assert.rejects(
    () =>
      runCli([process.execPath, 'extb', 'defaults'], {
        commandName: 'extb',
        build: async (options) => {
          receivedOptions = options;
          throw new Error('停止测试构建');
        },
      }),
    /停止测试构建/,
  );
  assert.equal(receivedOptions.root, 'defaults');
});

test('supports the extb command name with help and version flags', async () => {
  let buildCalls = 0;
  const buildStub = async () => {
    buildCalls += 1;
    throw new Error('帮助和版本参数不应启动构建');
  };

  let stdout = '';
  await runCli([process.execPath, 'extb', '--help'], {
    commandName: 'extb',
    build: buildStub,
    write: (text) => (stdout += text),
  });
  assert.match(stdout, /Usage: extb/);
  assert.match(stdout, /-h, --help/);
  assert.match(stdout, /-v, --version/);
  assert.match(stdout, /输入选项：/);
  assert.match(stdout, /--no-config/);
  assert.match(stdout, /--no-transform <glob>/);
  assert.match(stdout, /--keep-name <name>/);
  assert.match(stdout, /--json/);
  assert.match(stdout, /--dry-run/);
  assert.match(stdout, /--list-files/);
  assert.match(stdout, /--quiet/);
  assert.match(stdout, /--minify \[level\]/);
  assert.match(stdout, /--optimize \[level\]/);
  assert.match(stdout, /--minify-html \[level\]/);
  assert.match(stdout, /--minify-js \[level\]/);
  assert.match(stdout, /--minify-css \[level\]/);
  assert.match(stdout, /--obfuscate \[level\]/);
  assert.doesNotMatch(stdout, /--aggressive-js/);
  assert.match(stdout, /--defaults\s+以 JSON 显示内置默认配置并退出/);
  assert.match(stdout, /--show-config\s+以 JSON 显示合并后的最终配置并退出/);
  assert.doesNotMatch(stdout, /--transpile/);
  assert.match(stdout, /生成 ZIP（默认：关闭）/);
  assert.match(stdout, /默认：modern/);
  assert.match(stdout, /默认：可读文本/);

  // -v 是 --version 的常用短写；输出版本后应正常结束。
  stdout = '';
  await runCli([process.execPath, 'extb', '-v'], {
    commandName: 'extb',
    build: buildStub,
    write: (text) => (stdout += text),
  });
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(stdout.trim(), packageJson.version);

  assert.equal(buildCalls, 0);
});

let failed = 0;
// 串行执行可以避免多个构建同时占用 Windows 临时目录，并使失败输出保持确定顺序。
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
