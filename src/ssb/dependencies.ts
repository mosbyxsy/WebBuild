import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { Parser } from 'htmlparser2';
import { minimatch } from 'minimatch';
import { SsbError, asErrorMessage } from './errors.js';
import type { SourceFile } from '../core/paths.js';

/**
 * 一条等待解析的站点资源引用。
 * from/reason 不只用于调试：缺失文件报错会准确指出引用页面和产生引用的语法位置。
 */
interface DependencyReference {
  value: string;
  from: string;
  reason: string;
  rootRelative?: boolean;
  moduleSpecifier?: boolean;
  htmlBase?: string;
  webManifest?: boolean;
}

/** 依赖分析输入。inventory 已应用 exclude，entries/include 则负责选择可达资源。 */
interface DependencyCollectionOptions {
  inventory: readonly SourceFile[];
  entries: readonly string[];
  include: readonly string[];
}

// 固定的虚拟同源地址让标准 URL 类处理 `..`、查询串、片段和 <base>，不会发起网络请求。
const SITE_ORIGIN = 'https://ssb.invalid';
/** minimatch 支持的主要通配符字符，用于区分精确入口与 glob。 */
const GLOB_MAGIC = /[*?\[\]{}()]/;

/** 将静态成员表达式还原为点分名称，供 fetch/importScripts 等调用识别使用。 */
function memberName(node: acorn.AnyNode): string | undefined {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MetaProperty') return `${node.meta.name}.${node.property.name}`;
  if (node.type !== 'MemberExpression' || node.optional) return undefined;
  const object = memberName(node.object);
  if (object === undefined) return undefined;
  if (!node.computed && node.property.type === 'Identifier') return `${object}.${node.property.name}`;
  const property = literalString(node.property);
  return property === undefined ? undefined : `${object}.${property}`;
}

/** 只提取编译期确定的字符串；带表达式的模板字符串由 include 显式补充。 */
function literalString(node: acorn.AnyNode | null | undefined): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }
  return undefined;
}

/** 同时兼容 ES module 和普通 script；两种模式都失败时报告真正的源码相对路径。 */
function parseJavaScript(source: string, relativePath: string): acorn.Node {
  const options: acorn.Options = { ecmaVersion: 'latest', allowHashBang: true };
  try {
    return acorn.parse(source, { ...options, sourceType: 'module' });
  } catch (moduleError) {
    try {
      return acorn.parse(source, { ...options, sourceType: 'script' });
    } catch (scriptError) {
      throw new SsbError(`分析 JavaScript 依赖失败 ${relativePath}: ${asErrorMessage(scriptError)}`, {
        cause: moduleError,
      });
    }
  }
}

/**
 * 使用 AST 收集 import/export、动态 import、fetch、Worker 和 importScripts 引用。
 * 裸模块名视为 npm/导入映射标识符，不直接当作磁盘相对路径。
 */
function collectJavaScriptReferences(source: string, relativePath: string): DependencyReference[] {
  const ast = parseJavaScript(source, relativePath);
  const references: DependencyReference[] = [];
  const add = (value: string | undefined, reason: string, moduleSpecifier = false) => {
    if (value !== undefined) references.push({ value, from: relativePath, reason, moduleSpecifier });
  };

  walk.simple(ast, {
    ImportDeclaration(node) {
      add(literalString(node.source), 'JavaScript import', true);
    },
    ExportNamedDeclaration(node) {
      add(literalString(node.source), 'JavaScript export', true);
    },
    ExportAllDeclaration(node) {
      add(literalString(node.source), 'JavaScript export', true);
    },
    ImportExpression(node) {
      add(literalString(node.source), 'JavaScript dynamic import', true);
    },
    CallExpression(node) {
      const callee = memberName(node.callee);
      const first = node.arguments[0];
      const value = first?.type === 'SpreadElement' ? undefined : literalString(first);
      if (callee === 'fetch' || callee?.endsWith('.fetch')) add(value, 'fetch() 本地资源');
      if (callee === 'importScripts' || callee?.endsWith('.importScripts')) add(value, 'importScripts()');
    },
    NewExpression(node) {
      const callee = memberName(node.callee);
      const first = node.arguments[0];
      const value = first?.type === 'SpreadElement' ? undefined : literalString(first);
      if (callee === 'Worker' || callee === 'SharedWorker') add(value, `new ${callee}()`);
      if (callee === 'URL' && node.arguments.length > 1) {
        const second = node.arguments[1];
        if (second?.type === 'MemberExpression' && memberName(second) === 'import.meta.url') {
          add(value, 'new URL(..., import.meta.url)');
        }
      }
    },
  });
  return references;
}

/** 收集 CSS url() 与 @import 依赖；htmlBase 用于内联 style 的 URL 基准修正。 */
function collectCssReferences(source: string, relativePath: string, htmlBase?: string): DependencyReference[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const references: DependencyReference[] = [];
  const add = (value: string, reason: string) => references.push({
    value,
    from: relativePath,
    reason,
    ...(htmlBase === undefined ? {} : { htmlBase }),
  });

  const urlPattern = /url\(\s*(?:(["'])(.*?)\1|([^\s)'";]+))\s*\)/gi;
  for (const match of withoutComments.matchAll(urlPattern)) {
    const value = match[2] ?? match[3];
    if (value !== undefined) add(value, 'CSS url()');
  }
  const importPattern = /@import\s+(?:url\(\s*)?(?:(["'])(.*?)\1|([^\s)'";]+))/gi;
  for (const match of withoutComments.matchAll(importPattern)) {
    const value = match[2] ?? match[3];
    if (value !== undefined) add(value, 'CSS @import');
  }
  return references;
}

/** 只把明确指向 .html/.htm 的 a/area 链接纳入依赖图，普通外链不复制。 */
function isHtmlNavigation(value: string): boolean {
  const clean = value.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
  return clean.endsWith('.html') || clean.endsWith('.htm');
}

/**
 * 解析 import map JSON，并递归提取 imports/scopes 中的目标地址。
 * 映射键是模块标识符而非资源地址，因此只遍历对象值。
 */
function collectImportMapReferences(source: string, relativePath: string, htmlBase?: string): DependencyReference[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new SsbError(`解析 import map 失败 ${relativePath}: ${asErrorMessage(error)}`, { cause: error });
  }
  const references: DependencyReference[] = [];
  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      references.push({
        value: item,
        from: relativePath,
        reason: 'HTML import map',
        ...(htmlBase === undefined ? {} : { htmlBase }),
      });
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) visit(child);
    }
  };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    visit(object.imports);
    visit(object.scopes);
  }
  return references;
}

/**
 * 解析 HTML 的外部资源、页面导航、srcset、内联 CSS/JS 和 import map。
 * script type 不是 JavaScript/importmap 时保留页面文件本身，但不误解析其文本内容。
 */
function collectHtmlReferences(source: string, relativePath: string): DependencyReference[] {
  const raw: DependencyReference[] = [];
  const inlineCss: string[] = [];
  const inlineScripts: string[] = [];
  const importMaps: string[] = [];
  let htmlBase: string | undefined;
  let activeScript: { kind: 'script' | 'importmap' | 'ignore'; text: string } | undefined;
  let activeStyle: string | undefined;

  const add = (value: string | undefined, reason: string, webManifest = false) => {
    if (value !== undefined && value.trim() !== '') raw.push({
      value,
      from: relativePath,
      reason,
      ...(htmlBase === undefined ? {} : { htmlBase }),
      ...(webManifest ? { webManifest: true } : {}),
    });
  };

  const parser = new Parser({
    onopentag(name, attributes) {
      const tag = name.toLowerCase();
      if (tag === 'base' && htmlBase === undefined && attributes.href !== undefined) htmlBase = attributes.href;

      const sourceTags = new Set(['script', 'img', 'source', 'audio', 'video', 'iframe', 'embed', 'input', 'track']);
      if (sourceTags.has(tag)) add(attributes.src, `HTML <${tag}> src`);
      if (tag === 'link') {
        const manifest = attributes.rel?.toLowerCase().split(/\s+/).includes('manifest') ?? false;
        add(attributes.href, `HTML <link> href`, manifest);
      }
      if (tag === 'object') add(attributes.data, 'HTML <object> data');
      if (tag === 'video') add(attributes.poster, 'HTML <video> poster');
      if (tag === 'image' || tag === 'use') add(attributes.href ?? attributes['xlink:href'], `HTML <${tag}> href`);
      if ((tag === 'a' || tag === 'area') && attributes.href !== undefined && isHtmlNavigation(attributes.href)) {
        add(attributes.href, `HTML <${tag}> 页面链接`);
      }
      if (attributes.srcset !== undefined && !attributes.srcset.trimStart().startsWith('data:')) {
        for (const candidate of attributes.srcset.split(',')) {
          const resource = candidate.trim().split(/\s+/, 1)[0];
          if (resource) add(resource, `HTML <${tag}> srcset`);
        }
      }
      if (attributes.style !== undefined) inlineCss.push(attributes.style);

      if (tag === 'script') {
        const type = attributes.type?.trim().toLowerCase();
        const kind = type === 'importmap'
          ? 'importmap'
          : type === undefined || type === '' || type === 'module' || type.includes('javascript')
            ? 'script'
            : 'ignore';
        activeScript = { kind, text: '' };
      } else if (tag === 'style') {
        activeStyle = '';
      }
    },
    ontext(text) {
      if (activeScript !== undefined) activeScript.text += text;
      if (activeStyle !== undefined) activeStyle += text;
    },
    onclosetag(name) {
      const tag = name.toLowerCase();
      if (tag === 'script' && activeScript !== undefined) {
        if (activeScript.text.trim() !== '') {
          if (activeScript.kind === 'script') inlineScripts.push(activeScript.text);
          if (activeScript.kind === 'importmap') importMaps.push(activeScript.text);
        }
        activeScript = undefined;
      } else if (tag === 'style' && activeStyle !== undefined) {
        inlineCss.push(activeStyle);
        activeStyle = undefined;
      }
    },
  }, { decodeEntities: true, lowerCaseAttributeNames: true, lowerCaseTags: true });
  parser.end(source);

  for (const css of inlineCss) raw.push(...collectCssReferences(css, relativePath, htmlBase));
  for (const script of inlineScripts) {
    for (const reference of collectJavaScriptReferences(script, relativePath)) {
      raw.push(htmlBase === undefined ? reference : { ...reference, htmlBase });
    }
  }
  for (const importMap of importMaps) raw.push(...collectImportMapReferences(importMap, relativePath, htmlBase));
  return raw;
}

/** 从 Web App Manifest 中收集 icons、screenshots 和 shortcut icons。 */
function collectWebManifestReferences(source: string, relativePath: string): DependencyReference[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new SsbError(`解析 Web App Manifest 失败 ${relativePath}: ${asErrorMessage(error)}`, { cause: error });
  }
  const references: DependencyReference[] = [];
  const addImages = (items: unknown, reason: string) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const src = (item as Record<string, unknown>).src;
        if (typeof src === 'string') references.push({ value: src, from: relativePath, reason });
      }
    }
  };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const manifest = value as Record<string, unknown>;
    addImages(manifest.icons, 'Web App Manifest icons');
    addImages(manifest.screenshots, 'Web App Manifest screenshots');
    if (Array.isArray(manifest.shortcuts)) {
      for (const shortcut of manifest.shortcuts) {
        if (shortcut !== null && typeof shortcut === 'object' && !Array.isArray(shortcut)) {
          addImages((shortcut as Record<string, unknown>).icons, 'Web App Manifest shortcut icons');
        }
      }
    }
  }
  return references;
}

/** 把用户输入 glob/路径统一成以源码根为基准的 POSIX 形式。 */
function normalizePattern(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 使用浏览器 URL 规则把引用转换为源码根内相对路径。
 * data/blob 等内联协议与跨域 URL 不需要复制；试图越过 root 的路径直接失败，防止读取
 * 工作区外文件。查询串和 hash 仅影响运行时请求，不属于物理文件名。
 */
function resolveReference(reference: DependencyReference): string | undefined {
  const value = reference.value.trim().replace(/\\/g, '/');
  if (value === '' || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return undefined;
  if (reference.moduleSpecifier && !value.startsWith('.') && !value.startsWith('/')) return undefined;

  let baseUrl = new URL(reference.rootRelative ? '/' : `/${reference.from}`, SITE_ORIGIN);
  if (!reference.rootRelative && reference.htmlBase !== undefined) {
    try {
      baseUrl = new URL(reference.htmlBase, baseUrl);
    } catch {
      throw new SsbError(`HTML base URL 无效: ${reference.htmlBase}\n来源: ${reference.from}`);
    }
  }
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new SsbError(`资源 URL 无效（${reference.reason}）: ${reference.value}\n来源: ${reference.from}`);
  }
  if (url.origin !== SITE_ORIGIN) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch (error) {
    throw new SsbError(`资源路径包含无效 URL 编码（${reference.reason}）: ${reference.value}`, { cause: error });
  }
  const relative = path.posix.normalize(decoded);
  if (relative === '' || relative === '.') return undefined;
  if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new SsbError(`资源路径越过源码根目录: ${reference.value}\n来源: ${reference.from}（${reference.reason}）`);
  }
  return relative;
}

/** 展开一个精确路径或 glob；Windows 下使用不区分大小写的文件系统语义。 */
function expandPattern(pattern: string, inventory: readonly SourceFile[]): SourceFile[] {
  const normalized = normalizePattern(pattern);
  if (!GLOB_MAGIC.test(normalized)) {
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return inventory.filter((file) => (process.platform === 'win32' ? file.relativePath.toLowerCase() : file.relativePath) === key);
  }
  return inventory.filter((file) => minimatch(file.relativePath, normalized, {
    dot: true,
    nocase: process.platform === 'win32',
  }));
}

/**
 * 把入口/include 模式展开为精确引用并加入待处理队列。
 * 入口强制要求 HTML，include 则允许任意资源；零匹配始终报错，避免配置拼写错误被忽略。
 */
function seedPatterns(
  patterns: readonly string[],
  label: string,
  inventory: readonly SourceFile[],
  queue: DependencyReference[],
  htmlOnly: boolean,
): string[] {
  const seeded: string[] = [];
  for (const pattern of patterns) {
    const matches = expandPattern(pattern, inventory);
    if (matches.length === 0) throw new SsbError(`${label} 未匹配任何文件: ${pattern}`);
    for (const file of matches) {
      if (htmlOnly && !/\.html?$/i.test(file.relativePath)) {
        throw new SsbError(`HTML 入口必须以 .html 或 .htm 结尾: ${file.relativePath}`);
      }
      queue.push({ value: file.relativePath, from: label, reason: `${label}: ${pattern}`, rootRelative: true });
      seeded.push(file.relativePath);
    }
  }
  return seeded;
}

/**
 * 从 HTML 入口和 include 开始，广度优先计算站点静态依赖闭包。
 * selected 决定最终输出，processed 防止循环引用重复读取，webManifests 标记由 link rel
 * 发现的普通 .json 文件，使其也能按照 Web App Manifest 继续追踪图片资源。
 */
export async function collectRequiredSourceFiles(options: DependencyCollectionOptions): Promise<{
  files: SourceFile[];
  entryPaths: string[];
}> {
  // Windows 文件查找不区分大小写，但返回值始终保留源文件真实相对路径。
  const inventoryByPath = new Map<string, SourceFile>();
  for (const file of options.inventory) {
    inventoryByPath.set(process.platform === 'win32' ? file.relativePath.toLowerCase() : file.relativePath, file);
  }
  const selected = new Map<string, SourceFile>();
  const processed = new Set<string>();
  const webManifests = new Set<string>();
  const queue: DependencyReference[] = [];
  const entryPaths = seedPatterns(options.entries, 'entry', options.inventory, queue, true);
  seedPatterns(options.include, 'include', options.inventory, queue, false);

  while (queue.length > 0) {
    const reference = queue.shift()!;
    const resolved = resolveReference(reference);
    if (resolved === undefined) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const file = inventoryByPath.get(key);
    if (file === undefined) {
      throw new SsbError(`必需资源不存在或已被排除: ${resolved}\n来源: ${reference.from}（${reference.reason}）`);
    }
    if (reference.webManifest) webManifests.add(file.relativePath);
    selected.set(file.relativePath, file);
    if (processed.has(file.relativePath)) continue;
    processed.add(file.relativePath);

    const extension = path.posix.extname(file.relativePath).toLowerCase();
    if (!['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.webmanifest'].includes(extension)) continue;
    const source = await readFile(file.sourcePath, 'utf8');
    if (extension === '.html' || extension === '.htm') {
      queue.push(...collectHtmlReferences(source, file.relativePath));
    } else if (extension === '.css') {
      queue.push(...collectCssReferences(source, file.relativePath));
    } else if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      queue.push(...collectJavaScriptReferences(source, file.relativePath));
    } else if (extension === '.webmanifest' || webManifests.has(file.relativePath)) {
      queue.push(...collectWebManifestReferences(source, file.relativePath));
    }
  }

  return {
    files: [...selected.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    entryPaths: [...new Set(entryPaths)].sort((left, right) => left.localeCompare(right)),
  };
}
