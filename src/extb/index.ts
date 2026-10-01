// 这是 npm 包唯一的公共入口。只从这里导出承诺稳定的运行时 API 和类型，
// CLI 解析器、文件遍历器及各种压缩器仍保持为内部实现细节。
export { build } from './build.js';
export { CONFIG_FILE_NAMES, DEFAULT_EXCLUDES, defineConfig, loadConfig } from './config.js';
export { ExtbError } from './errors.js';
export type {
  BuildFileCounts,
  BuildOptions,
  BuildResult,
  CompressionLevel,
  ExtbConfig,
  LoadConfigOptions,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscationLevel,
  ObfuscateOptions,
  ResolvedConfig,
  ResolvedMinifyOptions,
  ResolvedObfuscateOptions,
  ResolvedTranspileOptions,
  ResolvedZipOptions,
  TranspileOptions,
  ZipOptions,
} from './types.js';
