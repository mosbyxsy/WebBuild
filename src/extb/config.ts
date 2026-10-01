import path from 'node:path';
import { isPlainObject, mergeCommonConfig } from '../core/config.js';
import {
  BUILD_CONFIG_FILE_NAMES,
  discoverConfigFiles,
  modeConfigFileNames,
  pathExists,
  readConfigFile,
} from '../core/config-files.js';
import { ExtbError } from './errors.js';
import type {
  ExtbConfig,
  LoadConfigOptions,
  ResolvedConfig,
  ResolvedZipOptions,
  ZipOptions,
} from './types.js';

export const CONFIG_FILE_NAMES = modeConfigFileNames('extb');
/** 所有配置文件都不应成为浏览器扩展运行时资源，因此统一加入默认排除列表。 */
const ALL_CONFIG_FILE_NAMES = [
  ...modeConfigFileNames('extb'),
  ...modeConfigFileNames('ssb'),
  ...BUILD_CONFIG_FILE_NAMES,
];

/** 默认跳过版本库、依赖、工具配置、系统垃圾文件以及未完成的原子输出目录。 */
export const DEFAULT_EXCLUDES = [
  '.git', '.git/**', '.hg', '.hg/**', '.svn', '.svn/**',
  'node_modules', 'node_modules/**',
  ...ALL_CONFIG_FILE_NAMES.flatMap((name) => [name, `**/${name}`]),
  '.DS_Store', '**/.DS_Store', 'Thumbs.db', '**/Thumbs.db', '*.log', '**/*.log',
  '.*.extb-tmp-*', '.*.extb-tmp-*/**', '.*.extb-backup-*', '.*.extb-backup-*/**',
] as const;

/** 运行时原样返回输入，主要为 extb.config.ts 提供完整的 TypeScript 类型提示。 */
export function defineConfig(config: ExtbConfig): ExtbConfig {
  return config;
}

/** 配置文件中的路径以配置文件目录为基准；CLI/API 路径则由调用方传入 cwd。 */
function resolveConfigPaths(config: ExtbConfig, baseDir: string): ExtbConfig {
  const resolved: ExtbConfig = { ...config };
  if (config.root !== undefined) resolved.root = path.resolve(baseDir, config.root);
  if (config.manifest !== undefined) resolved.manifest = path.resolve(baseDir, config.manifest);
  if (config.outDir !== undefined) resolved.outDir = path.resolve(baseDir, config.outDir);
  return resolved;
}

/** 把布尔简写或 ZIP 对象应用到当前已解析值，并校验自定义文件名。 */
function applyZip(current: ResolvedZipOptions, input: boolean | ZipOptions | undefined): ResolvedZipOptions {
  if (input === undefined) return current;
  if (typeof input === 'boolean') return { ...current, enabled: input };
  if (!isPlainObject(input)) throw new ExtbError('zip 必须是布尔值或对象。');
  const next: ResolvedZipOptions = {
    ...current,
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
  };
  if (input.fileName !== undefined) {
    if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
      throw new ExtbError('zip.fileName 必须是非空字符串。');
    }
    next.fileName = input.fileName;
  }
  return next;
}

/** 合并公共字段与 extb 专属字段，记录实际参与合并的配置文件。 */
function mergeConfig(
  cwd: string,
  discoveryRoot: string,
  fileConfigs: ExtbConfig[],
  overrides: ExtbConfig,
  configFiles: string[],
): ResolvedConfig {
  const common = mergeCommonConfig(discoveryRoot, fileConfigs, overrides, DEFAULT_EXCLUDES);
  const fileManifest = fileConfigs.reduce<string | undefined>((current, config) => config.manifest ?? current, undefined);
  const manifest = overrides.manifest ?? fileManifest;
  let zip: ResolvedZipOptions = { enabled: false };
  for (const config of fileConfigs) zip = applyZip(zip, config.zip);
  zip = applyZip(zip, overrides.zip);

  const resolved: ResolvedConfig = { cwd, ...common, zip, configFiles };
  if (manifest !== undefined) resolved.manifest = manifest;
  const configFile = configFiles.at(-1);
  if (configFile !== undefined) resolved.configFile = configFile;
  return resolved;
}

/**
 * 解析 extb 最终配置。
 * 自动模式依次加载 build.config.*、extb.config.*；显式 configFile 只加载该文件；
 * false 则完全跳过配置文件。最后再应用 overrides，形成 CLI/API 最高优先级。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const discoveryRoot = path.resolve(cwd, options.root ?? options.overrides?.root ?? '.');
  const configFiles = options.configFile === false
    ? []
    : typeof options.configFile === 'string'
      ? [path.resolve(cwd, options.configFile)]
      : await discoverConfigFiles(discoveryRoot, 'extb');

  const fileConfigs: ExtbConfig[] = [];
  for (const configFile of configFiles) {
    if (!(await pathExists(configFile))) throw new ExtbError(`配置文件不存在: ${configFile}`);
    fileConfigs.push(resolveConfigPaths(await readConfigFile<ExtbConfig>(configFile), path.dirname(configFile)));
  }
  const overrides = resolveConfigPaths(options.overrides ?? {}, cwd);
  if (options.root !== undefined) overrides.root = path.resolve(cwd, options.root);
  return mergeConfig(cwd, discoveryRoot, fileConfigs, overrides, configFiles);
}
