import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import {
  collectNonEmpty,
  createCommonOverrides,
  hasLongOption,
  normalizeOptionalLevels,
  parseCompressionLevel,
  parseJavaScriptTarget,
  parseObfuscationLevel,
  validateCommonCliArguments,
} from '../core/cli.js';
import type { CommonCliOptions } from '../core/cli.js';
import { build } from './build.js';
import { loadConfig } from './config.js';
import { ExtbError } from './errors.js';
import type {
  BuildOptions,
  BuildResult,
  ZipOptions,
} from './types.js';

export { normalizeOptionalLevels } from '../core/cli.js';

/** Commander 解析后的扁平参数结构；尚未转换为公开的嵌套配置结构。 */
interface CliOptions extends CommonCliOptions {
  defaults?: boolean;
  showConfig?: boolean;
  config?: string | false;
  manifest?: string;
  outDir?: string;
  zip?: boolean;
  zipName?: string;
  json?: boolean;
  dryRun?: boolean;
  listFiles?: boolean;
  quiet?: boolean;
}

/** package.json 是版本号的唯一来源，避免发布时忘记同步 CLI 中的硬编码值。 */
const packageMetadata = createRequire(import.meta.url)('../../package.json') as { version: string };

/**
 * 读取真实归一化默认值，再把机器相关的绝对路径替换成适合阅读和复制的相对路径。
 * configFile:false 保证该命令不会受当前项目 extb.config.* 影响。
 */
async function createDefaultConfigSnapshot(): Promise<Record<string, unknown>> {
  const defaults = await loadConfig({ configFile: false });
  return {
    root: '.',
    outDir: './dist',
    exclude: defaults.exclude,
    include: defaults.include,
    transformExclude: defaults.transformExclude,
    minify: defaults.minify,
    obfuscate: defaults.obfuscate,
    transpile: defaults.transpile,
    zip: defaults.zip,
  };
}

/**
 * 使用与 build() 相同的拆分方式解析最终配置，但停在配置归一化阶段。
 * dryRun 是一次构建的执行模式而非 ExtbConfig 字段，因此不传入配置合并器。
 */
async function resolveFinalCliConfig(root: string | undefined, options: CliOptions, args: readonly string[]) {
  const { cwd, configFile, dryRun: _dryRun, ...overrides } = createBuildOptions(root, options, args);
  return loadConfig({
    ...(cwd === undefined ? {} : { cwd }),
    ...(configFile === undefined ? {} : { configFile }),
    overrides,
  });
}

/**
 * CLI 的可注入依赖，只用于隔离副作用和测试。
 * 正常 bin 入口不传此参数，会使用真实 build() 和 process.stdout。
 */
export interface CliDependencies {
  build?: (options?: BuildOptions) => Promise<BuildResult>;
  write?: (text: string) => void;
  commandName?: 'extb';
}

/**
 * 校验 Commander 无法表达的跨选项冲突。
 *
 * 这些组合如果静默采用某一侧，会产生“命令成功但没有按预期处理”的结果，因此在真正
 * 调用 build() 前直接失败。校验放在 action 内，确保 `--help` 始终可以正常显示。
 */
function validateCliArguments(args: readonly string[]): void {
  validateCommonCliArguments(args);
  if (hasLongOption(args, '--zip-name') && hasLongOption(args, '--no-zip')) {
    throw new ExtbError('参数 --zip-name 与 --no-zip 不能同时使用。');
  }
}

/** 将字节数转换为适合终端阅读的二进制单位。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 将 CLI 的扁平选项转换成 BuildOptions。
 *
 * 只写入用户明确提供的值非常重要：undefined 必须继续保持“未指定”，才能让配置文件
 * 或内置默认值生效。带等级的正向选项与对应 --no-* 会被 Commander 汇总到同一字段，
 * 因此还要检查原始 argv 才能区分“未指定”和显式覆盖。
 */
export function createBuildOptions(
  root: string | undefined,
  options: CliOptions,
  args: readonly string[],
): BuildOptions {
  const result: BuildOptions = { ...createCommonOverrides(options, args) };
  if (root !== undefined) result.root = root;
  if (options.config !== undefined) result.configFile = options.config;
  if (options.manifest !== undefined) result.manifest = options.manifest;
  if (options.outDir !== undefined) result.outDir = options.outDir;
  if (options.dryRun === true) result.dryRun = true;
  if (options.zip !== undefined || options.zipName !== undefined) {
    const zip: ZipOptions = {};
    if (options.zip !== undefined) zip.enabled = options.zip;
    if (options.zipName !== undefined) {
      zip.fileName = options.zipName;
      // CLI 中指定归档名称本身就是生成 ZIP 的明确意图；显式 --no-zip 会在冲突校验时报错。
      if (options.zip === undefined) zip.enabled = true;
    }
    result.zip = zip;
  }
  return result;
}

/**
 * 创建并执行一次独立的 CLI 解析过程。
 *
 * 每次调用都新建 Command，避免测试或嵌入式调用之间残留上一次解析状态。argv 使用
 * Node 模式，格式与 process.argv 相同：前两项是 node 路径和脚本路径。
 */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<void> {
  const normalizedArgv = normalizeOptionalLevels(argv);
  const args = normalizedArgv.slice(2);
  const buildExtension = dependencies.build ?? build;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));

  const program = new Command()
    .name(dependencies.commandName ?? 'extb')
    .description('压缩并打包浏览器扩展源码目录')
    .optionsGroup('通用选项：')
    .version(packageMetadata.version, '-v, --version', '显示版本号')
    .helpOption('-h, --help', '显示帮助信息')
    .option('--defaults', '以 JSON 显示内置默认配置并退出')
    .option('--show-config', '以 JSON 显示合并后的最终配置并退出')
    // Commander 默认会先打印错误再抛异常；关闭内部 stderr 后统一由 bin 入口输出一次。
    .configureOutput({ writeOut: write, writeErr: () => undefined })
    // 覆盖 Commander 默认的 process.exit()，让嵌入式 API 和测试都能安全调用帮助/版本参数。
    .exitOverride()
    .argument('[root]', '查找 manifest.json 的根目录（默认：当前目录）')
    .optionsGroup('输入选项：')
    .option('-c, --config <file>', '指定配置文件（默认：依次读取 build.config.*、extb.config.*）')
    .option('--no-config', '禁用配置文件自动发现和加载（默认：启用）')
    .option('-m, --manifest <file>', '指定 manifest.json 路径（默认：递归查找唯一文件）')
    .optionsGroup('输出选项：')
    .option('-o, --out-dir <dir>', '输出目录（默认：<root>/dist）')
    .option('--zip', '生成 ZIP（默认：关闭）')
    .option('--no-zip', '不生成 ZIP，用于覆盖配置文件')
    .option('--zip-name <name>', '自定义并生成 ZIP（文件名必须以 .zip 结尾）')
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
    .option('--exclude <glob>', '从扩展包中完全排除文件，可重复使用（默认：无）', collectNonEmpty)
    .option('--include <glob>', '强制加入静态分析无法发现的资源，可重复使用（默认：无）', collectNonEmpty)
    .option('--no-transform <glob>', '打包文件但保持内容不变，可重复使用（默认：无）', collectNonEmpty)
    .optionsGroup('报告选项：')
    .option('--dry-run', '完整预演构建但不写入文件（默认：关闭）')
    .option('--list-files', '输出最终打包文件列表（默认：关闭）')
    .option('--quiet', '成功时不输出任何内容（默认：关闭）')
    .option('--json', '以 JSON 输出构建结果（默认：可读文本）')
    .allowExcessArguments(false);

  program.action(async (root: string | undefined, rawOptions: CliOptions) => {
    validateCliArguments(args);
    // 与 --help/--version 一样，--defaults 是终止型信息选项，不进入项目配置或构建流程。
    if (rawOptions.defaults) {
      write(`${JSON.stringify(await createDefaultConfigSnapshot(), null, 2)}\n`);
      return;
    }
    // 最终配置会加载配置文件并应用 CLI 覆盖，但不会继续查找 manifest 或执行构建。
    if (rawOptions.showConfig) {
      write(`${JSON.stringify(await resolveFinalCliConfig(root, rawOptions, args), null, 2)}\n`);
      return;
    }
    const result = await buildExtension(createBuildOptions(root, rawOptions, args));
    if (rawOptions.quiet) return;
    if (rawOptions.json) {
      write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    // 空扩展理论上不会出现（manifest 本身至少一个文件），仍防止除以零产生 NaN。
    const ratio = result.bytesBefore === 0 ? 0 : 1 - result.bytesAfter / result.bytesBefore;
    write(
      [
        result.dryRun ? `extb: 预演完成，未写入 ${result.outDir}` : `extb: 已输出到 ${result.outDir}`,
        `文件: ${result.files.copied} 个；HTML ${result.files.html}；JS ${result.files.js}；CSS ${result.files.css}；混淆 ${result.files.obfuscated}；转译 ${result.files.transpiled}`,
        `体积: ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}（减少 ${(ratio * 100).toFixed(1)}%）`,
        ...(result.zipPath === undefined ? [] : [`ZIP: ${result.zipPath}`]),
        ...(result.plannedZipPath === undefined ? [] : [`计划 ZIP: ${result.plannedZipPath}`]),
        ...(rawOptions.listFiles
          ? [
              `包含文件 (${result.includedFiles.length}):`,
              ...result.includedFiles.map((file) => `  ${file}`),
            ]
          : []),
      ].join('\n') + '\n',
    );
  });

  try {
    await program.parseAsync(normalizedArgv, { from: 'node' });
  } catch (error) {
    // --help 和 --version 已经完成输出，属于正常结束；其他参数错误继续交给 bin 入口处理。
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return;
    }
    throw error;
  }
}
