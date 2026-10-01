import path from 'node:path';
import { transformAsync as transformWithBabel } from '@babel/core';
import presetEnv from '@babel/preset-env';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJavaScript } from 'terser';
import { WebBuildError } from './errors.js';
import { matchesAny } from './paths.js';
import type { CompressionLevel, ObfuscationLevel, ResolvedProcessingConfig } from './types.js';

/** 用于构建摘要的处理类别；copied 表示没有经过文本转换。 */
export type ProcessedKind = 'copied' | 'html' | 'js' | 'css';

/** 文本处理器返回内容和统计元数据，不直接负责写文件。 */
export interface ProcessedText {
  content: string;
  kind: ProcessedKind;
  obfuscated: boolean;
  transpiled: boolean;
}

/** 命中 minify.exclude 时强制返回 none，否则返回该资源类型配置的实际等级。 */
function levelFor(relativePath: string, level: CompressionLevel, config: ResolvedProcessingConfig): CompressionLevel {
  return matchesAny(relativePath, config.minify.exclude) ? 'none' : level;
}

/** 命中排除规则时关闭混淆，否则返回配置的混淆等级。 */
function obfuscationLevelFor(relativePath: string, config: ResolvedProcessingConfig): ObfuscationLevel {
  return matchesAny(relativePath, config.obfuscate.exclude) ? 'none' : config.obfuscate.level;
}

/** es5 目标本身即表示启用转译，同时当前文件不能命中排除规则。 */
function canTranspile(relativePath: string, config: ResolvedProcessingConfig): boolean {
  return (
    config.transpile.target === 'es5' &&
    !matchesAny(relativePath, config.transpile.exclude)
  );
}

/**
 * 使用 Babel preset-env 把现代 JavaScript 语法降级为 ES5。
 *
 * modules:false 会保留 import/export 和文件路径，避免把浏览器原生 ES module 错误改成
 * CommonJS；模块语法本身没有 ES5 等价物，但模块内部的箭头函数、class、可选链等仍会
 * 被降级。babelrc/configFile 关闭，确保用户项目中的 Babel 配置不会暗中改变打包结果。
 */
async function transpileJavaScriptToEs5(source: string): Promise<string> {
  const result = await transformWithBabel(source, {
    babelrc: false,
    configFile: false,
    comments: true,
    compact: false,
    sourceMaps: false,
    sourceType: 'unambiguous',
    presets: [
      [
        presetEnv,
        {
          bugfixes: true,
          modules: false,
          targets: { ie: '11' },
          useBuiltIns: false,
        },
      ],
    ],
  });
  if (result?.code === undefined || result.code === null) {
    throw new WebBuildError('Babel 未生成 JavaScript 输出。');
  }
  return result.code;
}

/**
 * 使用 Terser 对一个完整脚本或 HTML 内脚本片段进行转换。
 *
 * safe 压缩只依赖紧凑输出移除空白和普通注释；aggressive 压缩执行三轮 compress，
 * 但仍关闭 unsafe。混淆等级与压缩等级相互独立：safe 只改局部标识符，aggressive
 * 才允许顶层标识符以及函数、类名称被改写；任何等级都不混淆对象属性。
 */
async function transformJavaScript(
  source: string,
  minifyLevel: CompressionLevel,
  obfuscationLevel: ObfuscationLevel,
  transpile: boolean,
  reservedNames: string[],
  inline: boolean,
) {
  if (minifyLevel === 'none' && obfuscationLevel === 'none' && !transpile) return source;
  const aggressiveCompression = minifyLevel === 'aggressive';
  const aggressiveObfuscation = obfuscationLevel === 'aggressive';
  // 事件属性包含顶层 return，不能作为完整 Program 交给 Babel；独立脚本和 script 标签可转译。
  const input = transpile && !inline ? await transpileJavaScriptToEs5(source) : source;
  // 只转译时直接返回 Babel 输出，避免 `minify: none` 仍被 Terser 紧凑格式化。
  if (minifyLevel === 'none' && obfuscationLevel === 'none') return input;
  const result = await minifyJavaScript(input, {
    // aggressive 压缩仍关闭 unsafe 系列优化，避免擅自假设内建对象或 getter 没有副作用。
    compress: aggressiveCompression ? { passes: 3, unsafe: false } : false,
    ecma: transpile ? 5 : 2020,
    mangle: obfuscationLevel !== 'none'
      ? {
          eval: false,
          keep_classnames: !aggressiveObfuscation,
          keep_fnames: !aggressiveObfuscation,
          properties: false,
          reserved: reservedNames,
          toplevel: aggressiveObfuscation,
        }
      : false,
    keep_classnames: !aggressiveObfuscation,
    keep_fnames: !aggressiveObfuscation,
    // onclick 等事件属性允许顶层 return，Terser 需要 bare_returns 才能解析这类片段。
    parse: inline ? { bare_returns: true } : {},
    format: {
      beautify: false,
      ecma: transpile ? 5 : 2020,
      // 保留 /*! ... */ 形式的许可证或重要说明，删除普通开发注释。
      comments: /^!/,
    },
  });
  if (result.code === undefined) throw new WebBuildError('Terser 未生成 JavaScript 输出。');
  return result.code;
}

/**
 * 根据等级生成 CleanCSS 选项。safe 只启用 level 1；aggressive 额外启用 level 2
 * 规则合并和结构优化。所有等级都禁止 @import 内联和 URL 重写。
 */
function cleanCssOptions(level: CompressionLevel): CleanCSS.OptionsOutput {
  return {
    inline: ['none'],
    level: level === 'aggressive' ? { 1: {}, 2: {} } : 1,
    rebase: false,
  };
}

function transformCss(source: string, level: CompressionLevel): string {
  if (level === 'none') return source;
  const result = new CleanCSS(cleanCssOptions(level)).minify(source);
  if (result.errors.length > 0) throw new WebBuildError(`CSS 压缩失败: ${result.errors.join('; ')}`);
  return result.styles;
}

/**
 * HTML 是复合资源：除了压缩标签和空白，还可能包含 script、style 和事件属性。
 * 因此即使 HTML 本身压缩关闭，只要 JS/CSS/混淆任一项开启，仍需让 HTML 解析器处理
 * 对应的内联片段。只有 HTML aggressive 才开启属性级清理，可选标签删除始终关闭。
 */
async function transformHtml(source: string, relativePath: string, config: ResolvedProcessingConfig): Promise<string> {
  const htmlLevel = levelFor(relativePath, config.minify.html, config);
  const jsLevel = levelFor(relativePath, config.minify.js, config);
  const cssLevel = levelFor(relativePath, config.minify.css, config);
  const obfuscationLevel = obfuscationLevelFor(relativePath, config);
  const transpile = canTranspile(relativePath, config);
  const aggressiveHtml = htmlLevel === 'aggressive';
  if (
    htmlLevel === 'none' &&
    jsLevel === 'none' &&
    cssLevel === 'none' &&
    obfuscationLevel === 'none' &&
    !transpile
  ) return source;

  return minifyHtml(source, {
    // conservativeCollapse 会保留一个必要空格，降低内联元素文字粘连风险。
    collapseWhitespace: htmlLevel !== 'none',
    conservativeCollapse: !aggressiveHtml,
    continueOnParseError: false,
    keepClosingSlash: true,
    minifyCSS: cssLevel === 'none' ? false : cleanCssOptions(cssLevel),
    minifyJS:
      jsLevel !== 'none' || obfuscationLevel !== 'none' || transpile
        ? async (text: string, inline: boolean) =>
            // 事件属性是上下文相关的代码片段，因此允许压缩和转译，但不做标识符混淆。
            transformJavaScript(
              text,
              jsLevel,
              inline ? 'none' : obfuscationLevel,
              transpile,
              config.obfuscate.reservedNames,
              inline,
            )
        : false,
    preserveLineBreaks: false,
    preventAttributesEscaping: false,
    processConditionalComments: false,
    removeAttributeQuotes: aggressiveHtml,
    removeComments: htmlLevel !== 'none',
    removeEmptyAttributes: false,
    removeOptionalTags: false,
    removeRedundantAttributes: aggressiveHtml,
    removeScriptTypeAttributes: aggressiveHtml,
    removeStyleLinkTypeAttributes: aggressiveHtml,
    sortAttributes: false,
    sortClassName: false,
    useShortDoctype: aggressiveHtml,
  });
}

/**
 * 按扩展名分派文本文件处理器。
 *
 * manifest、图片、字体、WASM 等不在这里处理，由构建层按字节复制。返回的 kind 和
 * obfuscated 只服务于构建统计，调用方不需要重新推断实际采用了哪个转换器。
 */
export async function processTextFile(
  source: string,
  relativePath: string,
  config: ResolvedProcessingConfig,
): Promise<ProcessedText> {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const obfuscationLevel = obfuscationLevelFor(relativePath, config);

  if (extension === '.html' || extension === '.htm') {
    const active =
      levelFor(relativePath, config.minify.html, config) !== 'none' ||
      levelFor(relativePath, config.minify.js, config) !== 'none' ||
      levelFor(relativePath, config.minify.css, config) !== 'none';
    const transpile = canTranspile(relativePath, config);
    return {
      content: await transformHtml(source, relativePath, config),
      kind: active || obfuscationLevel !== 'none' || transpile ? 'html' : 'copied',
      obfuscated: obfuscationLevel !== 'none',
      transpiled: canTranspile(relativePath, config),
    };
  }

  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const minifyLevel = levelFor(relativePath, config.minify.js, config);
    const transpile = canTranspile(relativePath, config);
    return {
      content: await transformJavaScript(
        source,
        minifyLevel,
        obfuscationLevel,
        transpile,
        config.obfuscate.reservedNames,
        false,
      ),
      kind: minifyLevel !== 'none' || obfuscationLevel !== 'none' || transpile ? 'js' : 'copied',
      obfuscated: obfuscationLevel !== 'none',
      transpiled: transpile,
    };
  }

  if (extension === '.css') {
    const minifyLevel = levelFor(relativePath, config.minify.css, config);
    return {
      content: transformCss(source, minifyLevel),
      kind: minifyLevel === 'none' ? 'copied' : 'css',
      obfuscated: false,
      transpiled: false,
    };
  }

  return { content: source, kind: 'copied', obfuscated: false, transpiled: false };
}
