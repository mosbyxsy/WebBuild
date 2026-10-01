import type { BuildFileCounts, CommonBuildConfig, ResolvedProcessingConfig } from '../core/types.js';

export type {
  BuildFileCounts,
  CompressionLevel,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscateOptions,
  ObfuscationLevel,
  ResolvedMinifyOptions,
  ResolvedObfuscateOptions,
  ResolvedTranspileOptions,
  TranspileOptions,
} from '../core/types.js';

/** ZIP 输出配置；fileName 一旦指定，CLI 会把它视为明确启用归档。 */
export interface ZipOptions {
  enabled?: boolean;
  fileName?: string;
}

/** extb 配置文件/API 接受的字段，在公共配置上增加 manifest 与 ZIP。 */
export interface ExtbConfig extends CommonBuildConfig {
  manifest?: string;
  zip?: boolean | ZipOptions;
}

/** 单次构建调用参数；cwd、configFile、dryRun 属于执行上下文，不进入配置文件。 */
export interface BuildOptions extends ExtbConfig {
  cwd?: string;
  configFile?: string | false;
  dryRun?: boolean;
}

/** 仅解析配置时的控制参数。configFile=false 表示完全关闭配置发现。 */
export interface LoadConfigOptions {
  cwd?: string;
  root?: string;
  configFile?: string | false;
  overrides?: ExtbConfig;
}

/** 补齐默认值后的 ZIP 配置。 */
export interface ResolvedZipOptions {
  enabled: boolean;
  fileName?: string;
}

/** extb 最终配置；configFiles 按低到高优先级排列。 */
export interface ResolvedConfig extends ResolvedProcessingConfig {
  cwd: string;
  root: string;
  manifest?: string;
  outDir: string;
  exclude: string[];
  include: string[];
  transformExclude: string[];
  zip: ResolvedZipOptions;
  configFiles: string[];
  configFile?: string;
}

/**
 * 一次扩展构建的机器可读结果。
 * dry-run 时不会提供 zipPath，但 plannedZipPath 会报告实际构建原本要生成的位置。
 */
export interface BuildResult {
  dryRun: boolean;
  manifestPath: string;
  sourceDir: string;
  outDir: string;
  zipPath?: string;
  plannedZipPath?: string;
  includedFiles: string[];
  files: BuildFileCounts;
  bytesBefore: number;
  bytesAfter: number;
}
