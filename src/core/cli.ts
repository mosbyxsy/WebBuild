import { InvalidArgumentError } from 'commander';
import { WebBuildError } from './errors.js';
import type {
  CommonBuildConfig,
  CompressionLevel,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscateOptions,
  ObfuscationLevel,
  TranspileOptions,
} from './types.js';

export interface CommonCliOptions {
  minify?: CompressionLevel | false;
  minifyHtml?: CompressionLevel | false;
  minifyJs?: CompressionLevel | false;
  minifyCss?: CompressionLevel | false;
  optimize?: CompressionLevel | false;
  obfuscate?: ObfuscationLevel | false;
  target?: JavaScriptTarget;
  keepName?: string[];
  include?: string[];
  exclude?: string[];
  transform?: true | string[];
}

/** Commander 可接受的等级集合，同时用于参数校验和可选参数预处理。 */
const COMPRESSION_LEVELS = new Set<CompressionLevel>(['none', 'safe', 'aggressive']);
const OBFUSCATION_LEVELS = new Set<ObfuscationLevel>(['none', 'safe', 'aggressive']);
const OPTIONAL_LEVEL_FLAGS = new Map<string, ReadonlySet<string>>([
  ['--optimize', COMPRESSION_LEVELS],
  ['--minify', COMPRESSION_LEVELS],
  ['--minify-html', COMPRESSION_LEVELS],
  ['--minify-js', COMPRESSION_LEVELS],
  ['--minify-css', COMPRESSION_LEVELS],
  ['--obfuscate', OBFUSCATION_LEVELS],
]);

/** Commander 的重复选项收集器：拒绝空值并维持命令行出现顺序。 */
export function collectNonEmpty(value: string, previous: unknown): string[] {
  if (value.trim() === '') throw new InvalidArgumentError('不能是空字符串');
  return [...(Array.isArray(previous) ? previous as string[] : []), value];
}

/** Commander 自定义解析器：把字符串收窄为 CompressionLevel。 */
export function parseCompressionLevel(value: string): CompressionLevel {
  if (!COMPRESSION_LEVELS.has(value as CompressionLevel)) {
    throw new InvalidArgumentError("只能是 'none'、'safe' 或 'aggressive'");
  }
  return value as CompressionLevel;
}

/** Commander 自定义解析器：把字符串收窄为 ObfuscationLevel。 */
export function parseObfuscationLevel(value: string): ObfuscationLevel {
  if (!OBFUSCATION_LEVELS.has(value as ObfuscationLevel)) {
    throw new InvalidArgumentError("只能是 'none'、'safe' 或 'aggressive'");
  }
  return value as ObfuscationLevel;
}

/** Commander 自定义解析器：只接受工具明确支持的输出目标。 */
export function parseJavaScriptTarget(value: string): JavaScriptTarget {
  if (value !== 'modern' && value !== 'es5') {
    throw new InvalidArgumentError("只能是 'modern' 或 'es5'");
  }
  return value;
}

/**
 * 预处理带可选 level 的选项。
 * Commander 会把 `--minify ./site` 中的 `./site` 当成 level；这里仅在下一项确实是合法
 * 等级时才消费它，否则把裸选项改写为 `--minify=safe`，让位置参数仍由命令正常解析。
 */
export function normalizeOptionalLevels(argv: readonly string[]): string[] {
  const normalized = [...argv];
  for (let index = 2; index < normalized.length; index += 1) {
    const argument = normalized[index]!;
    const levels = OPTIONAL_LEVEL_FLAGS.get(argument);
    if (levels === undefined) continue;
    const next = normalized[index + 1];
    if (next !== undefined && levels.has(next)) {
      index += 1;
      continue;
    }
    normalized[index] = `${argument}=safe`;
  }
  return normalized;
}

/** 同时识别 `--name` 与 `--name=value` 两种长选项形式。 */
export function hasLongOption(args: readonly string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

/**
 * 在 Commander 解析前检查跨选项冲突。
 * 正反开关同时出现时直接报错，避免依赖参数顺序形成难以发现的隐式覆盖。
 */
export function validateCommonCliArguments(args: readonly string[]): void {
  const conflicts: Array<[string, string]> = [
    ['--optimize', '--no-optimize'],
    ['--minify', '--no-minify'],
    ['--minify-html', '--no-minify-html'],
    ['--minify-js', '--no-minify-js'],
    ['--minify-css', '--no-minify-css'],
    ['--obfuscate', '--no-obfuscate'],
    ['--defaults', '--show-config'],
    ['--quiet', '--json'],
    ['--quiet', '--list-files'],
    ['--json', '--list-files'],
  ];
  for (const [positive, negative] of conflicts) {
    if (hasLongOption(args, positive) && hasLongOption(args, negative)) {
      throw new WebBuildError(`参数 ${positive} 与 ${negative} 不能同时使用。`);
    }
  }
  const hasConfig = hasLongOption(args, '--config')
    || args.some((arg) => arg === '-c' || (arg.startsWith('-c') && !arg.startsWith('--') && arg.length > 2));
  if (hasConfig && hasLongOption(args, '--no-config')) {
    throw new WebBuildError('参数 --config 与 --no-config 不能同时使用。');
  }
}

/** 把公共 CLI 字段展开为公共配置覆盖项，具体参数固定覆盖 --optimize。 */
export function createCommonOverrides(options: CommonCliOptions, args: readonly string[]): CommonBuildConfig {
  const result: CommonBuildConfig = {};
  if (options.include !== undefined && options.include.length > 0) result.include = options.include;
  if (options.exclude !== undefined && options.exclude.length > 0) result.exclude = options.exclude;
  if (Array.isArray(options.transform) && options.transform.length > 0) result.transformExclude = options.transform;

  // Commander 的解析结果无法区分“默认 false”和用户显式写了 --no-*，所以必须结合原始 argv。
  const hasOptimize = hasLongOption(args, '--optimize') || hasLongOption(args, '--no-optimize');
  const optimizeLevel: CompressionLevel | undefined = hasOptimize
    ? options.optimize === false ? 'none' : options.optimize ?? 'safe'
    : undefined;

  // --optimize 先给压缩和混淆提供基线，后面的具体分项始终拥有更高语义优先级。
  const minify: MinifyOptions = {};
  let hasMinify = optimizeLevel !== undefined;
  if (optimizeLevel !== undefined) minify.level = optimizeLevel;
  if (hasLongOption(args, '--minify') || hasLongOption(args, '--no-minify')) {
    minify.level = options.minify === false ? 'none' : options.minify ?? 'safe';
    hasMinify = true;
  }
  const fields: Array<[keyof Pick<MinifyOptions, 'html' | 'js' | 'css'>, CompressionLevel | false | undefined, string, string]> = [
    ['html', options.minifyHtml, '--minify-html', '--no-minify-html'],
    ['js', options.minifyJs, '--minify-js', '--no-minify-js'],
    ['css', options.minifyCss, '--minify-css', '--no-minify-css'],
  ];
  for (const [field, value, positive, negative] of fields) {
    if (hasLongOption(args, positive) || hasLongOption(args, negative)) {
      minify[field] = value === false ? 'none' : value ?? 'safe';
      hasMinify = true;
    }
  }
  if (hasMinify) result.minify = minify;

  const hasObfuscate = hasLongOption(args, '--obfuscate') || hasLongOption(args, '--no-obfuscate');
  if (hasOptimize || hasObfuscate || (options.keepName !== undefined && options.keepName.length > 0)) {
    const obfuscate: ObfuscateOptions = {};
    if (optimizeLevel !== undefined) obfuscate.level = optimizeLevel;
    if (hasObfuscate) obfuscate.level = options.obfuscate === false ? 'none' : options.obfuscate ?? 'safe';
    if (options.keepName !== undefined && options.keepName.length > 0) obfuscate.reservedNames = options.keepName;
    result.obfuscate = obfuscate;
  }
  if (options.target !== undefined) {
    const transpile: TranspileOptions = { target: options.target };
    result.transpile = transpile;
  }
  return result;
}
