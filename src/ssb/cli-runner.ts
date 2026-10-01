import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import {
  collectNonEmpty,
  createCommonOverrides,
  normalizeOptionalLevels,
  parseCompressionLevel,
  parseJavaScriptTarget,
  parseObfuscationLevel,
  validateCommonCliArguments,
} from '../core/cli.js';
import type { CommonCliOptions } from '../core/cli.js';
import { build } from './build.js';
import { loadConfig } from './config.js';
import type {
  BuildOptions,
  BuildResult,
} from './types.js';

export { normalizeOptionalLevels } from '../core/cli.js';

/** Commander 解析得到的扁平参数，稍后转换为嵌套 BuildOptions。 */
interface CliOptions extends CommonCliOptions {
  defaults?: boolean;
  showConfig?: boolean;
  root?: string;
  entry?: string[];
  config?: string | false;
  outDir?: string;
  dryRun?: boolean;
  listFiles?: boolean;
  json?: boolean;
  quiet?: boolean;
}

/** 版本号只从 package.json 读取，避免 CLI 与发布版本不一致。 */
const packageMetadata = createRequire(import.meta.url)('../../package.json') as { version: string };

/** 可注入 build 和输出函数，使 CLI 行为可以脱离真实文件系统进行单元测试。 */
export interface CliDependencies {
  build?: (options?: BuildOptions) => Promise<BuildResult>;
  write?: (text: string) => void;
}

/** 执行两个命令共享的冲突参数校验，并为后续 ssb 专属校验保留扩展点。 */
function validateCliArguments(args: readonly string[]): void {
  validateCommonCliArguments(args);
}

/**
 * 把位置入口、重复 --entry 和公共处理参数转换为 BuildOptions。
 * 只写入用户明确提供的值，使配置文件和内置默认值仍能参与后续合并。
 */
export function createBuildOptions(entries: readonly string[], options: CliOptions, args: readonly string[]): BuildOptions {
  const result: BuildOptions = { ...createCommonOverrides(options, args) };
  if (options.root !== undefined) result.root = options.root;
  const cliEntries = [...entries, ...(options.entry ?? [])];
  if (cliEntries.length > 0) result.entries = cliEntries;
  if (options.config !== undefined) result.configFile = options.config;
  if (options.outDir !== undefined) result.outDir = options.outDir;
  if (options.dryRun) result.dryRun = true;
  return result;
}

/** 读取真实默认配置，但把机器相关绝对路径替换成便于展示的相对形式。 */
async function createDefaultConfigSnapshot(): Promise<Record<string, unknown>> {
  const defaults = await loadConfig({ configFile: false });
  return {
    root: '.', entries: [], outDir: './dist', exclude: defaults.exclude, include: defaults.include,
    transformExclude: defaults.transformExclude, minify: defaults.minify, obfuscate: defaults.obfuscate,
    transpile: defaults.transpile,
  };
}

/** 把字节数格式化为终端友好的二进制单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 创建并执行一次全新的 ssb 命令解析。
 * 每次都新建 Command，避免测试或嵌入式重复调用时复用 Commander 的内部状态。
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
  // 先修正 `--minify ./site` 一类可选等级歧义，再交给 Commander 解析位置参数。
  const normalizedArgv = normalizeOptionalLevels(argv);
  const args = normalizedArgv.slice(2);
  const buildSite = dependencies.build ?? build;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const program = new Command()
    .name('ssb')
    .description('递归收集、压缩并输出静态站点资源')
    .optionsGroup('通用选项：')
    .version(packageMetadata.version, '-v, --version', '显示版本号')
    .helpOption('-h, --help', '显示帮助信息')
    .option('--defaults', '以 JSON 显示内置默认配置并退出')
    .option('--show-config', '以 JSON 显示合并后的最终配置并退出')
    .argument('[entries...]', 'HTML 入口文件或 glob，可指定多个')
    .optionsGroup('输入选项：')
    .option('-r, --root <dir>', '源码根目录（默认：当前目录）')
    .option('-e, --entry <file-or-glob>', '添加 HTML 入口，可重复使用', collectNonEmpty)
    .option('-c, --config <file>', '指定配置文件（默认：依次读取 build.config.*、ssb.config.*）')
    .option('--no-config', '禁用配置文件自动发现和加载（默认：启用）')
    .optionsGroup('输出选项：')
    .option('-o, --out-dir <dir>', '输出目录（默认：<root>/dist）')
    .optionsGroup('代码处理选项：')
    .option('--optimize [level]', '同时设置压缩和混淆等级（省略：safe）', parseCompressionLevel)
    .option('--no-optimize', '同时禁用压缩和混淆，等价于 --optimize=none')
    .option('--minify [level]', '设置全部压缩等级：none、safe、aggressive（省略：safe）', parseCompressionLevel)
    .option('--no-minify', '禁用全部压缩，等价于 --minify=none')
    .option('--minify-html [level]', '设置 HTML 压缩等级（省略：safe）', parseCompressionLevel)
    .option('--no-minify-html', '禁用 HTML 压缩')
    .option('--minify-js [level]', '设置 JavaScript 压缩等级（省略：safe）', parseCompressionLevel)
    .option('--no-minify-js', '禁用 JavaScript 压缩')
    .option('--minify-css [level]', '设置 CSS 压缩等级（省略：safe）', parseCompressionLevel)
    .option('--no-minify-css', '禁用 CSS 压缩')
    .option('--obfuscate [level]', '设置 JS 混淆等级：none、safe、aggressive（省略：safe；默认：none）', parseObfuscationLevel)
    .option('--no-obfuscate', '禁用 JavaScript 混淆，等价于 --obfuscate=none')
    .option('--target <target>', 'JavaScript 输出目标：modern 或 es5（默认：modern）', parseJavaScriptTarget)
    .option('--keep-name <name>', '混淆时保留标识符名称，可重复使用', collectNonEmpty)
    .optionsGroup('资源选择选项：')
    .option('--exclude <glob>', '从站点包中完全排除文件，可重复使用（默认：无）', collectNonEmpty)
    .option('--include <glob>', '强制加入静态分析无法发现的资源，可重复使用（默认：无）', collectNonEmpty)
    .option('--no-transform <glob>', '打包文件但保持内容不变，可重复使用（默认：无）', collectNonEmpty)
    .optionsGroup('报告选项：')
    .option('--dry-run', '完整预演构建但不写入文件（默认：关闭）')
    .option('--list-files', '输出最终打包文件列表（默认：关闭）')
    .option('--quiet', '成功时不输出任何内容（默认：关闭）')
    .option('--json', '以 JSON 输出构建结果（默认：可读文本）')
    .configureOutput({ writeOut: write, writeErr: () => undefined })
    .exitOverride()
    .allowExcessArguments(false);

  program.action(async (entries: string[], rawOptions: CliOptions) => {
    validateCliArguments(args);
    // defaults/show-config 都是只读信息命令，不进入依赖分析和输出阶段。
    if (rawOptions.defaults) {
      write(`${JSON.stringify(await createDefaultConfigSnapshot(), null, 2)}\n`);
      return;
    }
    const buildOptions = createBuildOptions(entries, rawOptions, args);
    if (rawOptions.showConfig) {
      const { cwd, configFile, dryRun: _dryRun, ...overrides } = buildOptions;
      const resolved = await loadConfig({
        ...(cwd === undefined ? {} : { cwd }),
        ...(configFile === undefined ? {} : { configFile }),
        overrides,
      });
      write(`${JSON.stringify(resolved, null, 2)}\n`);
      return;
    }
    const result = await buildSite(buildOptions);
    // quiet 的语义是成功时完全静默；错误仍由 bin 顶层 catch 输出到 stderr。
    if (rawOptions.quiet) return;
    if (rawOptions.json) {
      write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const ratio = result.bytesBefore === 0 ? 0 : 1 - result.bytesAfter / result.bytesBefore;
    write([
      result.dryRun ? `ssb: 预演完成，未写入 ${result.outDir}` : `ssb: 已输出到 ${result.outDir}`,
      `入口: ${result.entryPaths.length}；文件: ${result.includedFiles.length}；HTML ${result.files.html}；JS ${result.files.js}；CSS ${result.files.css}；混淆 ${result.files.obfuscated}；转译 ${result.files.transpiled}`,
      `体积: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}（减少 ${(ratio * 100).toFixed(1)}%）`,
      ...(rawOptions.listFiles ? ['包含文件：', ...result.includedFiles.map((file) => `  ${file}`)] : []),
    ].join('\n') + '\n');
  });

  try {
    await program.parseAsync(normalizedArgv, { from: 'node' });
  } catch (error) {
    // help/version 通过 exitOverride 表现为异常，但它们已经完成输出，属于正常终止。
    if (error instanceof CommanderError && (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')) return;
    throw error;
  }
}
