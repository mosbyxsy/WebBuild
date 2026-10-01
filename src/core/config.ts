import path from 'node:path';
import { WebBuildError } from './errors.js';
import type {
  CommonBuildConfig,
  CompressionLevel,
  JavaScriptTarget,
  MinifyOptions,
  ObfuscateOptions,
  ObfuscationLevel,
  ResolvedMinifyOptions,
  ResolvedObfuscateOptions,
  ResolvedProcessingConfig,
  ResolvedTranspileOptions,
  TranspileOptions,
} from './types.js';

export interface ResolvedCommonConfig extends ResolvedProcessingConfig {
  root: string;
  outDir: string;
  include: string[];
  exclude: string[];
  transformExclude: string[];
}

/**
 * 严格判断普通配置对象，拒绝数组、Date、类实例等带自定义原型的值。
 * 这样配置合并只处理可预测的键值结构，不会意外执行原型上的行为。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** 校验字符串数组并返回副本，避免后续合并意外修改用户传入的原数组。 */
export function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new WebBuildError(`${label} 必须是非空字符串数组。`);
  }
  return [...value];
}

/** 按配置层出现顺序合并 glob/名称规则，并用 Set 保留首个值、删除重复项。 */
export function mergeRules(...layers: string[][]): string[] {
  return [...new Set(layers.flat())];
}

/** 校验压缩等级；单独保留 label 可精确报告是总开关还是某个分项出错。 */
function compressionLevel(value: unknown, label: string): CompressionLevel {
  if (value !== 'none' && value !== 'safe' && value !== 'aggressive') {
    throw new WebBuildError(`${label} 只能是 'none'、'safe' 或 'aggressive'。`);
  }
  return value;
}

/** 校验混淆等级。 */
function obfuscationLevel(value: unknown, label: string): ObfuscationLevel {
  if (value !== 'none' && value !== 'safe' && value !== 'aggressive') {
    throw new WebBuildError(`${label} 只能是 'none'、'safe' 或 'aggressive'。`);
  }
  return value;
}

/** 校验 JavaScript 输出目标。 */
function javaScriptTarget(value: unknown, label: string): JavaScriptTarget {
  if (value !== 'modern' && value !== 'es5') {
    throw new WebBuildError(`${label} 只能是 'modern' 或 'es5'。`);
  }
  return value;
}

/**
 * 在一个已解析压缩配置上应用下一层输入。
 * 字符串等级同时设置总等级与三个分项；对象中的 level 先设置三项，再由 html/js/css
 * 做更细粒度覆盖，因此 `{ level: 'safe', js: 'aggressive' }` 能得到预期结果。
 */
function applyMinify(
  current: ResolvedMinifyOptions,
  input: CompressionLevel | MinifyOptions | undefined,
): ResolvedMinifyOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') {
    const level = compressionLevel(input, 'minify');
    return { ...current, level, html: level, js: level, css: level };
  }
  if (!isPlainObject(input)) throw new WebBuildError('minify 必须是压缩等级或对象。');
  if ('enabled' in input) {
    throw new WebBuildError("minify.enabled 已移除，请使用 minify.level: 'none' | 'safe' | 'aggressive'。");
  }
  let next = { ...current };
  if (input.level !== undefined) {
    const level = compressionLevel(input.level, 'minify.level');
    next = { ...next, level, html: level, js: level, css: level };
  }
  if (input.html !== undefined) next.html = compressionLevel(input.html, 'minify.html');
  if (input.js !== undefined) next.js = compressionLevel(input.js, 'minify.js');
  if (input.css !== undefined) next.css = compressionLevel(input.css, 'minify.css');
  if (input.exclude !== undefined) {
    next.exclude = mergeRules(current.exclude, stringArray(input.exclude, 'minify.exclude'));
  }
  return next;
}

/** 在保留累计排除项和保留名称的前提下，应用下一层混淆配置。 */
function applyObfuscate(
  current: ResolvedObfuscateOptions,
  input: ObfuscationLevel | ObfuscateOptions | undefined,
): ResolvedObfuscateOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') return { ...current, level: obfuscationLevel(input, 'obfuscate') };
  if (!isPlainObject(input)) throw new WebBuildError('obfuscate 必须是混淆等级或对象。');
  if ('enabled' in input || 'mode' in input) {
    throw new WebBuildError("obfuscate.enabled/mode 已移除，请使用 obfuscate.level: 'none' | 'safe' | 'aggressive'。");
  }
  const next = { ...current };
  if (input.level !== undefined) next.level = obfuscationLevel(input.level, 'obfuscate.level');
  if (input.exclude !== undefined) {
    next.exclude = mergeRules(current.exclude, stringArray(input.exclude, 'obfuscate.exclude'));
  }
  if (input.reservedNames !== undefined) {
    next.reservedNames = mergeRules(current.reservedNames, stringArray(input.reservedNames, 'obfuscate.reservedNames'));
  }
  return next;
}

/** 应用下一层转译配置；target 后写覆盖，exclude 跨层累加。 */
function applyTranspile(
  current: ResolvedTranspileOptions,
  input: JavaScriptTarget | TranspileOptions | undefined,
): ResolvedTranspileOptions {
  if (input === undefined) return current;
  if (typeof input === 'string') return { ...current, target: javaScriptTarget(input, 'transpile') };
  if (!isPlainObject(input)) throw new WebBuildError("transpile 必须是 'modern'、'es5' 或对象。");
  if ('enabled' in input) {
    throw new WebBuildError("transpile.enabled 已移除，请使用 transpile.target: 'modern' | 'es5'。");
  }
  return {
    target: input.target === undefined ? current.target : javaScriptTarget(input.target, 'transpile.target'),
    exclude: input.exclude === undefined
      ? current.exclude
      : mergeRules(current.exclude, stringArray(input.exclude, 'transpile.exclude')),
  };
}

/** 按默认值 < build 配置 < 模式配置 < CLI/API 的顺序归一化公共字段。 */
export function mergeCommonConfig(
  discoveryRoot: string,
  fileConfigs: readonly CommonBuildConfig[],
  overrides: CommonBuildConfig,
  defaultExcludes: readonly string[],
): ResolvedCommonConfig {
  // root/outDir 是标量：后出现的文件配置覆盖先出现的配置，API/CLI 覆盖所有文件配置。
  const fileRoot = fileConfigs.reduce<string | undefined>((current, config) => config.root ?? current, undefined);
  const root = overrides.root ?? fileRoot ?? discoveryRoot;
  const fileOutDir = fileConfigs.reduce<string | undefined>((current, config) => config.outDir ?? current, undefined);
  const outDir = overrides.outDir ?? fileOutDir ?? path.join(root, 'dist');
  // 资源规则是集合语义：不同配置层的规则共同生效，而不是整组替换。
  const include = mergeRules(
    ...fileConfigs.map((config) => stringArray(config.include, 'include')),
    stringArray(overrides.include, 'include'),
  );
  const exclude = mergeRules(
    [...defaultExcludes],
    ...fileConfigs.map((config) => stringArray(config.exclude, 'exclude')),
    stringArray(overrides.exclude, 'exclude'),
  );
  const transformExclude = mergeRules(
    ...fileConfigs.map((config) => stringArray(config.transformExclude, 'transformExclude')),
    stringArray(overrides.transformExclude, 'transformExclude'),
  );

  // 从唯一的内置默认值起步，严格按传入顺序逐层应用，确保行为和文档中的优先级一致。
  let minify: ResolvedMinifyOptions = { level: 'safe', html: 'safe', js: 'safe', css: 'safe', exclude: [] };
  let obfuscate: ResolvedObfuscateOptions = { level: 'none', exclude: [], reservedNames: [] };
  let transpile: ResolvedTranspileOptions = { target: 'modern', exclude: [] };
  for (const config of fileConfigs) {
    minify = applyMinify(minify, config.minify);
    obfuscate = applyObfuscate(obfuscate, config.obfuscate);
    transpile = applyTranspile(transpile, config.transpile);
  }
  minify = applyMinify(minify, overrides.minify);
  obfuscate = applyObfuscate(obfuscate, overrides.obfuscate);
  transpile = applyTranspile(transpile, overrides.transpile);
  // no-transform 是“完全不改内容”的总规则，因此必须同时注入三种转换器的排除列表。
  minify.exclude = mergeRules(minify.exclude, transformExclude);
  obfuscate.exclude = mergeRules(obfuscate.exclude, transformExclude);
  transpile.exclude = mergeRules(transpile.exclude, transformExclude);

  return { root, outDir, include, exclude, transformExclude, minify, obfuscate, transpile };
}
