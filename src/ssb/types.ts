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

/** ssb 配置文件/API 接受的字段；entries 是 HTML 入口文件或 glob。 */
export interface SsbConfig extends CommonBuildConfig {
  entries?: string[];
}

/** 单次站点构建参数；执行上下文字段不会写入或反向污染配置对象。 */
export interface BuildOptions extends SsbConfig {
  cwd?: string;
  configFile?: string | false;
  dryRun?: boolean;
}

/** 只加载并归一化配置时的参数。 */
export interface LoadConfigOptions {
  cwd?: string;
  root?: string;
  configFile?: string | false;
  overrides?: SsbConfig;
}

/** 默认值、配置文件和调用覆盖合并后的完整 ssb 配置。 */
export interface ResolvedConfig extends ResolvedProcessingConfig {
  cwd: string;
  root: string;
  entries: string[];
  outDir: string;
  include: string[];
  exclude: string[];
  transformExclude: string[];
  configFiles: string[];
  configFile?: string;
}

/** 站点构建结果；entryPaths 是展开 glob 后真正参与构建的 HTML 入口。 */
export interface BuildResult {
  dryRun: boolean;
  sourceDir: string;
  outDir: string;
  entryPaths: string[];
  includedFiles: string[];
  files: BuildFileCounts;
  bytesBefore: number;
  bytesAfter: number;
}
