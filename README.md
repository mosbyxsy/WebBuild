# @mosbydev/web-build

一个 npm 包，两套依赖感知构建命令：

- `extb`：从 `manifest.json` 出发打包 Chrome、Edge、Firefox 等 WebExtension。
- `ssb`：从 HTML 入口出发打包无需框架编译的静态站点。

两种模式共享配置规范、CLI 等级语义、HTML/JavaScript/CSS 处理器、ES5 转译、路径安全检查和原子输出逻辑，但保留各自的入口发现与依赖分析规则。要求 Node.js 20 或更高版本。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [共同默认值](#共同默认值)
- [配置文件与优先级](#配置文件与优先级)
- [压缩、混淆与转译](#压缩混淆与转译)
- [extb 浏览器扩展模式](#extb-浏览器扩展模式)
- [ssb 静态站点模式](#ssb-静态站点模式)
- [公共 CLI 参数](#公共-cli-参数)
- [Node.js API](#nodejs-api)
- [开发与发布](#开发与发布)
- [限制](#限制)

## 安装

项目开发依赖：

```bash
npm install --save-dev @mosbydev/web-build
```

全局安装：

```bash
npm install --global @mosbydev/web-build
```

包只安装两个命令：

```text
extb
ssb
```

## 快速开始

构建浏览器扩展：

```bash
extb ./extension
```

构建静态站点：

```bash
ssb --root ./site
ssb --root ./site index.html "pages/*.html"
```

通过 npx 临时执行：

```bash
npx --package @mosbydev/web-build extb ./extension
npx --package @mosbydev/web-build ssb --root ./site
```

两种模式默认输出 `<root>/dist`。如果在同一个 root 先后运行两个命令，应分别指定 `--out-dir`，避免后一次构建替换前一次产物。

## 共同默认值

```ts
{
  root: process.cwd(),
  outDir: '<root>/dist',
  include: [],
  transformExclude: [],
  minify: {
    level: 'safe',
    html: 'safe',
    js: 'safe',
    css: 'safe',
    exclude: [],
  },
  obfuscate: {
    level: 'none',
    exclude: [],
    reservedNames: [],
  },
  transpile: {
    target: 'modern',
    exclude: [],
  },
}
```

extb 另外默认设置：

```ts
{ zip: { enabled: false } }
```

查看默认配置：

```bash
extb --defaults
ssb --defaults
```

## 配置文件与优先级

自动发现时，每个命令最多读取两个配置文件，并按以下顺序合并：

```text
内置默认值
  < build.config.*
  < extb.config.* 或 ssb.config.*
  < CLI / Node.js API 参数
```

支持的扩展名：

```text
.ts  .mts  .cts  .js  .mjs  .cjs  .json
```

例如执行 `extb` 时：

```text
build.config.ts   # 两个命令共享，低优先级
extb.config.ts    # 仅 extb 自动读取，高优先级
```

执行 `ssb` 时：

```text
build.config.ts   # 两个命令共享，低优先级
ssb.config.ts     # 仅 ssb 自动读取，高优先级
```

同一配置族出现多个扩展名会报错，例如不能同时存在 `build.config.ts` 与 `build.config.json`。配置文件只在 root 当前层发现，不向父目录查找。

显式配置会关闭自动组合，只加载指定文件：

```bash
extb . --config ./configs/release.ts
ssb --config ./configs/release.ts index.html
```

完全禁用配置加载：

```bash
extb . --no-config
ssb --no-config index.html
```

共享配置建议只使用公共字段：

```ts
// build.config.ts
import { defineConfig } from '@mosbydev/web-build';

export default defineConfig({
  outDir: './dist',
  exclude: ['tests/**', '**/*.map'],
  transformExclude: ['vendor/**'],
  minify: 'safe',
  obfuscate: 'none',
  transpile: 'modern',
});
```

扩展配置：

```ts
// extb.config.ts
import { defineConfig } from '@mosbydev/web-build/extb';

export default defineConfig({
  manifest: './extension/manifest.json',
  outDir: './release/extension',
  zip: true,
  minify: { js: 'aggressive' },
});
```

站点配置：

```ts
// ssb.config.ts
import { defineConfig } from '@mosbydev/web-build/ssb';

export default defineConfig({
  root: './site',
  entries: ['index.html', 'pages/*.html'],
  outDir: './release/site',
});
```

每个配置文件中的路径相对该配置文件自身目录；CLI 路径相对当前工作目录。规则数组跨配置层累加并去重，标量和分项等级由高优先级层覆盖。

查看最终配置而不执行构建：

```bash
extb . --show-config
ssb --show-config index.html
```

结果中的 `configFiles` 按实际合并顺序列出所有配置；`configFile` 保留为最高优先级配置路径。

## 压缩、混淆与转译

压缩和混淆统一使用三个等级：

```text
none | safe | aggressive
```

同时设置压缩与混淆：

```bash
extb . --optimize aggressive
ssb --optimize aggressive index.html
```

它等价于：

```bash
--minify aggressive --obfuscate aggressive
```

具体选项固定覆盖 `--optimize`，与书写顺序无关：

```bash
--optimize aggressive --obfuscate safe --no-minify-css
```

压缩等级：

| 等级 | HTML | JavaScript | CSS |
| --- | --- | --- | --- |
| `none` | 不压缩 | 不压缩 | 不压缩 |
| `safe` | 保守折叠空白 | 紧凑格式，不执行 compress 或改名 | CleanCSS Level 1 |
| `aggressive` | 额外清理冗余属性 | 三轮 compress，保持 `unsafe: false` | CleanCSS Level 1 + Level 2 |

混淆与压缩相互独立：

- `none`：不修改标识符。
- `safe`：只修改局部标识符，保留顶层、函数、类和属性名称。
- `aggressive`：允许修改顶层、函数和类名称，仍不混淆对象属性。

保留动态使用的名称：

```bash
--obfuscate aggressive --keep-name publicApi --keep-name messageHandler
```

ES5 转译：

```bash
--target es5
```

处理顺序固定为：

```text
依赖分析 → Babel 语法转译 → 压缩 → 混淆 → 原子输出
```

ES5 模式不提供 polyfill，不把 ES modules 转成 CommonJS，也不生成 bundle。HTML 事件属性最多只做文本压缩，不执行混淆或 ES5 转译。

## extb 浏览器扩展模式

extb 自动递归查找唯一的 `manifest.json`，并以 manifest 所在目录作为扩展源码根目录：

```bash
extb ./workspace
```

存在多个 manifest 时必须显式指定：

```bash
extb ./workspace --manifest ./workspace/extension/manifest.json
```

只输出 manifest 入口及其递归依赖，不复制 `.git`、`.idea`、未引用源码等无关文件。支持 HTML/CSS/JS 引用、content scripts、后台脚本、Worker、DNR 规则和 Web Accessible Resources。

默认只生成可直接加载的目录。需要 ZIP 时：

```bash
extb ./extension --zip
extb ./extension --zip-name release.zip
```

ZIP 根目录直接包含 `manifest.json`，ZIP 自身不会进入归档。

## ssb 静态站点模式

没有显式入口时，ssb 使用 root 直属的全部 `.html`、`.htm` 文件：

```bash
ssb --root ./site
```

显式入口会整体覆盖配置中的 `entries`：

```bash
ssb --root ./site index.html about.html
ssb --root ./site --entry "pages/*.html"
```

ssb 会递归追踪页面链接、HTML 资源、CSS `url()`/`@import`、ES modules、Worker、`fetch()`、import map 和 Web App Manifest。

## 公共 CLI 参数

```text
-c, --config <file>
--no-config
-o, --out-dir <dir>

--optimize [level]
--no-optimize
--minify [level]
--no-minify
--minify-html [level]
--no-minify-html
--minify-js [level]
--no-minify-js
--minify-css [level]
--no-minify-css
--obfuscate [level]
--no-obfuscate
--keep-name <name>
--target modern|es5

--include <glob>
--exclude <glob>
--no-transform <glob>

--defaults
--show-config
--dry-run
--list-files
--json
--quiet
-h, --help
-v, --version
```

裸 `--optimize`、`--minify*`、`--obfuscate` 使用 `safe`。`--no-*` 等价于相应等级 `none`。

报告参数冲突：

```text
--quiet × --json
--quiet × --list-files
--json  × --list-files
```

`--dry-run` 会完成依赖分析和代码转换验证，但不会创建或替换输出目录。

## Node.js API

浏览器扩展 API：

```ts
import { build, defineConfig, loadConfig } from '@mosbydev/web-build/extb';

const config = defineConfig({
  root: './extension',
  minify: 'aggressive',
  obfuscate: 'safe',
});

const resolved = await loadConfig({ overrides: config });
const result = await build(config);
```

静态站点 API：

```ts
import { build, defineConfig, loadConfig } from '@mosbydev/web-build/ssb';

const result = await build({
  root: './site',
  entries: ['index.html'],
  minify: 'safe',
});
```

也可以从根入口使用命名空间：

```ts
import { extb, ssb } from '@mosbydev/web-build';
```

## 开发与发布

```bash
npm run typecheck
npm test
npm pack
```

`prepack` 会清理 `lib`、重新编译并运行两种模式的全部测试。发布包只包含 `lib`、README 和 License。

## 限制

- 不编译 TypeScript、JSX、Sass 或框架单文件组件。
- 不合并 JavaScript/CSS，不解析 `node_modules` 裸模块。
- 运行时拼接的路径无法可靠静态分析，应使用 `--include`。
- 依赖 `eval`、反射、函数名称或源码字符串的代码在 aggressive 混淆下可能需要 `--keep-name` 或 `--no-transform`。
- 两种模式均拒绝越过源码根目录的资源和符号链接。

## License

MIT
