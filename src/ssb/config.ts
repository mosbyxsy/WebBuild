import path from 'node:path';
import { mergeCommonConfig, stringArray } from '../core/config.js';
import {
  BUILD_CONFIG_FILE_NAMES,
  discoverConfigFiles,
  modeConfigFileNames,
  pathExists,
  readConfigFile,
} from '../core/config-files.js';
import { SsbError } from './errors.js';
import type { LoadConfigOptions, ResolvedConfig, SsbConfig } from './types.js';

export const CONFIG_FILE_NAMES = modeConfigFileNames('ssb');
/** 构建工具的三类配置都不属于站点运行时资源。 */
const ALL_CONFIG_FILE_NAMES = [
  ...modeConfigFileNames('extb'),
  ...modeConfigFileNames('ssb'),
  ...BUILD_CONFIG_FILE_NAMES,
];

/** 默认排除版本库、依赖、工具配置、系统文件以及 ssb 原子输出的临时目录。 */
export const DEFAULT_EXCLUDES = [
  '.git', '.git/**', '.hg', '.hg/**', '.svn', '.svn/**',
  'node_modules', 'node_modules/**',
  ...ALL_CONFIG_FILE_NAMES.flatMap((name) => [name, `**/${name}`]),
  '.DS_Store', '**/.DS_Store', 'Thumbs.db', '**/Thumbs.db', '*.log', '**/*.log',
  '.*.ssb-tmp-*', '.*.ssb-tmp-*/**', '.*.ssb-backup-*', '.*.ssb-backup-*/**',
] as const;

/** 运行时不修改配置，仅为 ssb.config.ts 提供字段补全和类型检查。 */
export function defineConfig(config: SsbConfig): SsbConfig {
  return config;
}

/** 将配置文件中的 root/outDir 按配置文件所在目录解析为绝对路径。 */
function resolveConfigPaths(config: SsbConfig, baseDir: string): SsbConfig {
  const resolved: SsbConfig = { ...config };
  if (config.root !== undefined) resolved.root = path.resolve(baseDir, config.root);
  if (config.outDir !== undefined) resolved.outDir = path.resolve(baseDir, config.outDir);
  return resolved;
}

/**
 * 合并公共配置和站点入口。
 * entries 与 include 不同：它是一个整体选择，后一个配置层只要显式给出 entries 就覆盖
 * 前一层；CLI 位置参数同理覆盖配置文件中的入口列表。
 */
function mergeConfig(
  cwd: string,
  discoveryRoot: string,
  fileConfigs: SsbConfig[],
  overrides: SsbConfig,
  configFiles: string[],
): ResolvedConfig {
  const common = mergeCommonConfig(discoveryRoot, fileConfigs, overrides, DEFAULT_EXCLUDES);
  const fileEntries = fileConfigs.reduce<string[]>((current, config) => (
    config.entries === undefined ? current : stringArray(config.entries, 'entries')
  ), []);
  const entries = overrides.entries === undefined ? fileEntries : stringArray(overrides.entries, 'entries');
  const resolved: ResolvedConfig = { cwd, ...common, entries, configFiles };
  const configFile = configFiles.at(-1);
  if (configFile !== undefined) resolved.configFile = configFile;
  return resolved;
}

/**
 * 解析 ssb 最终配置。
 * 自动加载顺序为 build.config.* < ssb.config.*，随后由 overrides 覆盖；显式配置路径
 * 相对 cwd，而配置文件内部的 root/outDir 相对配置文件自身目录。
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const discoveryRoot = path.resolve(cwd, options.root ?? options.overrides?.root ?? '.');
  const configFiles = options.configFile === false
    ? []
    : typeof options.configFile === 'string'
      ? [path.resolve(cwd, options.configFile)]
      : await discoverConfigFiles(discoveryRoot, 'ssb');

  const fileConfigs: SsbConfig[] = [];
  for (const configFile of configFiles) {
    if (!(await pathExists(configFile))) throw new SsbError(`配置文件不存在: ${configFile}`);
    fileConfigs.push(resolveConfigPaths(await readConfigFile<SsbConfig>(configFile), path.dirname(configFile)));
  }
  const overrides = resolveConfigPaths(options.overrides ?? {}, cwd);
  if (options.root !== undefined) overrides.root = path.resolve(cwd, options.root);
  return mergeConfig(cwd, discoveryRoot, fileConfigs, overrides, configFiles);
}
