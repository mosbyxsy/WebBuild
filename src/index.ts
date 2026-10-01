/** 根入口提供命名空间；具体 API 推荐从 /extb 或 /ssb 子路径导入。 */
import type { CommonBuildConfig } from './core/types.js';

export * as extb from './extb/index.js';
export * as ssb from './ssb/index.js';
export { BUILD_CONFIG_FILE_NAMES, CONFIG_EXTENSIONS } from './core/config-files.js';
export { WebBuildError } from './core/errors.js';
export type {
  BuildFileCounts,
  CommonBuildConfig,
  CompressionLevel,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscateOptions,
  ObfuscationLevel,
  TranspileOptions,
} from './core/types.js';

/** 为两个命令共享的 build.config.* 提供类型提示。 */
export function defineConfig<T extends CommonBuildConfig>(config: T): T {
  return config;
}
