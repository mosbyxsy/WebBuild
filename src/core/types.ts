/**
 * 两种构建模式共享的公共类型。
 *
 * 这里刻意不出现 manifest、HTML 入口和 ZIP 等模式专属概念，使 core 层既可供
 * extb 使用，也可供 ssb 使用。带 `Resolved` 前缀的类型表示所有默认值已经补齐，
 * 构建和转换阶段可以直接读取字段，不必反复处理 undefined。
 */

/** 压缩强度：关闭、保守处理、积极优化。 */
export type CompressionLevel = 'none' | 'safe' | 'aggressive';
/** 标识符混淆强度；它与压缩等级独立，不能互相推断。 */
export type ObfuscationLevel = 'none' | 'safe' | 'aggressive';
/** JavaScript 输出语法目标。modern 保留现代语法，es5 启用 Babel 降级。 */
export type JavaScriptTarget = 'modern' | 'es5';

/** 压缩配置。level 是总等级，html/js/css 可对单一资源类型再次覆盖。 */
export interface MinifyOptions {
  level?: CompressionLevel;
  html?: CompressionLevel;
  js?: CompressionLevel;
  css?: CompressionLevel;
  exclude?: string[];
}

/** JavaScript 标识符混淆配置。reservedNames 用于保护反射或外部协议依赖的名称。 */
export interface ObfuscateOptions {
  level?: ObfuscationLevel;
  exclude?: string[];
  reservedNames?: string[];
}

/** JavaScript 语法转译配置；exclude 只跳过 Babel，不等同于跳过压缩。 */
export interface TranspileOptions {
  target?: JavaScriptTarget;
  exclude?: string[];
}

/**
 * 两个命令都接受的配置字段。
 * include 强制加入静态分析无法发现的资源；exclude 完全不打包；
 * transformExclude 仍打包文件，但保持其原始字节内容。
 */
export interface CommonBuildConfig {
  root?: string;
  outDir?: string;
  include?: string[];
  exclude?: string[];
  transformExclude?: string[];
  minify?: CompressionLevel | MinifyOptions;
  obfuscate?: ObfuscationLevel | ObfuscateOptions;
  transpile?: JavaScriptTarget | TranspileOptions;
}

/** 已归一化的压缩配置，每个资源类型都有明确的最终等级。 */
export interface ResolvedMinifyOptions {
  level: CompressionLevel;
  html: CompressionLevel;
  js: CompressionLevel;
  css: CompressionLevel;
  exclude: string[];
}

/** 已归一化的混淆配置。 */
export interface ResolvedObfuscateOptions {
  level: ObfuscationLevel;
  exclude: string[];
  reservedNames: string[];
}

/** 已归一化的转译配置。 */
export interface ResolvedTranspileOptions {
  target: JavaScriptTarget;
  exclude: string[];
}

/** 公共处理器只依赖这些字段，不感知 manifest、entries 或 ZIP。 */
export interface ResolvedProcessingConfig {
  minify: ResolvedMinifyOptions;
  obfuscate: ResolvedObfuscateOptions;
  transpile: ResolvedTranspileOptions;
}

export interface BuildFileCounts {
  /** 未经过文本转换、按字节复制的文件数。 */
  copied: number;
  /** 至少执行过一种 HTML/内联资源转换的 HTML 文件数。 */
  html: number;
  /** 至少执行过压缩、混淆或转译的独立 JavaScript 文件数。 */
  js: number;
  /** 执行过 CSS 压缩的文件数。 */
  css: number;
  /** 实际启用过标识符混淆的文件数。 */
  obfuscated: number;
  /** 实际经过 Babel ES5 转译的文件数。 */
  transpiled: number;
}
