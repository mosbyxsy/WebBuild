// ssb 的稳定公共入口。构建内部的 AST/HTML 解析器和 CLI 实现不在这里导出，
// 以便后续优化内部算法而不扩大 npm 包的兼容性承诺。
export { build } from './build.js';
export { CONFIG_FILE_NAMES, DEFAULT_EXCLUDES, defineConfig, loadConfig } from './config.js';
export { SsbError } from './errors.js';
export type {
  BuildFileCounts,
  BuildOptions,
  BuildResult,
  CompressionLevel,
  JavaScriptTarget,
  LoadConfigOptions,
  MinifyOptions,
  ObfuscateOptions,
  ObfuscationLevel,
  ResolvedConfig,
  ResolvedMinifyOptions,
  ResolvedObfuscateOptions,
  ResolvedTranspileOptions,
  SsbConfig,
  TranspileOptions,
} from './types.js';
