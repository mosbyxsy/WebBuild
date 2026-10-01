import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createZip } from './archive.js';
import { loadConfig } from './config.js';
import { collectRequiredSourceFiles } from './dependencies.js';
import { ExtbError, asErrorMessage } from './errors.js';
import { collectSourceFiles, findManifests, isPathInside, toPosixPath } from '../core/paths.js';
import { processTextFile } from '../core/processors.js';
import type { BuildOptions, BuildResult } from './types.js';

/** 这里只声明构建流程实际使用的 manifest 必填字段，不尝试复刻各浏览器完整 schema。 */
interface ExtensionManifest {
  manifest_version: number;
  name: string;
  version: string;
  [key: string]: unknown;
}

/** 只有这些后缀会以 UTF-8 文本读取；其他文件一律按二进制复制，避免损坏资源。 */
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css']);

/**
 * 对 manifest 做最小但必要的运行时校验，并把 unknown 收窄为 ExtensionManifest。
 * 浏览器专属字段由对应浏览器在加载/提交时验证，extb 不擅自删除未知字段。
 */
function assertManifest(value: unknown, manifestPath: string): asserts value is ExtensionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExtbError(`manifest 不是 JSON 对象: ${manifestPath}`);
  }
  const candidate = value as Record<string, unknown>;
  if (!Number.isInteger(candidate.manifest_version)) {
    throw new ExtbError(`manifest.manifest_version 必须是整数: ${manifestPath}`);
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ExtbError(`manifest.name 必须是非空字符串: ${manifestPath}`);
  }
  if (typeof candidate.version !== 'string' || candidate.version.trim() === '') {
    throw new ExtbError(`manifest.version 必须是非空字符串: ${manifestPath}`);
  }
}

/**
 * 把源码目录名和版本号转换成跨平台安全的 ZIP 文件名片段。
 * NFKD 归一化先拆分兼容字符，随后替换 Windows 等系统禁止的字符并清理尾部点/空格。
 */
function sanitizeFilePart(value: string): string {
  const sanitized = value
    .normalize('NFKD')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/-+/g, '-')
    .trim();
  return sanitized || 'extension';
}

/** 自定义 ZIP 只允许平面文件名，阻止 `../` 或绝对路径把归档写到输出目录之外。 */
function validateZipName(fileName: string): string {
  if (path.basename(fileName) !== fileName || !fileName.toLowerCase().endsWith('.zip')) {
    throw new ExtbError('zip.fileName 必须是以 .zip 结尾且不包含目录的文件名。');
  }
  return fileName;
}

/**
 * 确定本次构建使用哪个 manifest。
 *
 * 显式路径优先，并解析真实路径以消除符号链接歧义；否则递归搜索 root。自动搜索必须
 * 恰好得到一个候选，因为“随便选第一个”可能把另一个扩展覆盖到同一个 dist。
 */
async function resolveManifest(root: string, explicitManifest: string | undefined, excludes: readonly string[]): Promise<string> {
  if (explicitManifest !== undefined) {
    let manifestPath: string;
    try {
      manifestPath = await realpath(explicitManifest);
      const info = await stat(manifestPath);
      if (!info.isFile()) throw new Error('不是文件');
    } catch (error) {
      throw new ExtbError(`manifest 文件不存在或不可读: ${explicitManifest}`, { cause: error });
    }
    if (path.basename(manifestPath).toLowerCase() !== 'manifest.json') {
      throw new ExtbError(`manifest 文件名必须是 manifest.json: ${manifestPath}`);
    }
    return manifestPath;
  }

  let manifests: string[];
  try {
    manifests = await findManifests(root, excludes);
  } catch (error) {
    if (error instanceof ExtbError) throw error;
    throw new ExtbError(`查找 manifest.json 失败: ${asErrorMessage(error)}`, { cause: error });
  }
  if (manifests.length === 0) throw new ExtbError(`在 ${root} 中未找到 manifest.json。`);
  if (manifests.length > 1) {
    throw new ExtbError(
      `发现多个 manifest.json，请使用 --manifest 明确指定：\n${manifests.map((file) => `  - ${file}`).join('\n')}`,
    );
  }
  return manifests[0]!;
}

/**
 * 当目标目录位于扫描根目录内部时，把它转换成相对 root 的 glob 并加入排除列表。
 *
 * manifest 自动发现发生在源码根目录确定之前，因此不能复用后续相对 sourceDir 的排除项；
 * 这里专门按搜索 root 计算一次，确保默认 dist 和任意自定义输出目录中的旧 manifest
 * 都不会被误认为另一个扩展。输出等于 root 或位于 root 外部时不生成无意义规则。
 */
function excludeNestedDirectory(root: string, directory: string, excludes: readonly string[]): string[] {
  const next = [...excludes];
  if (!isPathInside(path.resolve(root), path.resolve(directory))) return next;
  const relativeDirectory = toPosixPath(path.relative(root, directory));
  next.push(relativeDirectory, `${relativeDirectory}/**`);
  return next;
}

/**
 * 输出可以位于源码内部（默认的 source/dist 会在扫描时排除），但不能等于源码目录，
 * 也不能成为源码目录的父级，否则原子替换输出时会移动或删除源码本身。
 */
function validateOutputPath(sourceDir: string, outDir: string): void {
  if (sourceDir === outDir || isPathInside(outDir, sourceDir)) {
    throw new ExtbError(`输出目录不能等于源码目录或包含源码目录: ${outDir}`);
  }
}

/**
 * 用“旧目录 -> 备份，临时目录 -> 正式目录”的同级重命名实现原子式发布。
 *
 * 临时目录与输出目录位于同一父目录，通常处于同一文件系统，rename 因而不需要逐文件
 * 复制。若提升新目录失败，会立即把备份改回原名；若只是在最后清理备份时失败，则保留
 * 已经完整生成的新输出并明确告知备份位置。
 */
async function replaceDirectory(stageDir: string, outDir: string, backupDir: string): Promise<void> {
  let backedUp = false;
  let promoted = false;
  try {
    try {
      await rename(outDir, backupDir);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(stageDir, outDir);
    promoted = true;
  } catch (error) {
    if (backedUp && !promoted) {
      try {
        await rename(backupDir, outDir);
      } catch (restoreError) {
        throw new ExtbError(
          `替换输出目录失败，且无法恢复旧输出。备份保留在 ${backupDir}: ${asErrorMessage(restoreError)}`,
          { cause: error },
        );
      }
    }
    throw new ExtbError(`替换输出目录失败: ${asErrorMessage(error)}`, { cause: error });
  }

  if (backedUp) {
    try {
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      throw new ExtbError(`新输出已生成，但无法清理旧输出备份 ${backupDir}: ${asErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

/**
 * 完整构建入口：加载配置、定位 manifest、收集源码、转换文件、生成 ZIP 并原子发布。
 * 在 replaceDirectory 成功之前，所有写操作都只发生在唯一的临时目录中。
 */
export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  // cwd/configFile/dryRun 是调用上下文，不属于写入配置文件的 ExtbConfig，需单独拆出。
  const { cwd, configFile, dryRun = false, ...overrides } = options;
  const config = await loadConfig({
    ...(cwd === undefined ? {} : { cwd }),
    ...(configFile === undefined ? {} : { configFile }),
    overrides,
  });

  const outDir = path.resolve(config.outDir);
  // manifest 的父目录才是扩展根；调用时的 root 只是自动搜索的边界。扫描前必须先排除
  // 已知输出目录，否则第二次构建会同时找到源码和上一次 dist 中的 manifest.json。
  const manifestExcludes = excludeNestedDirectory(config.root, outDir, config.exclude);
  const manifestPath = await resolveManifest(config.root, config.manifest, manifestExcludes);
  const sourceDir = path.dirname(manifestPath);
  validateOutputPath(sourceDir, outDir);

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new ExtbError(`读取 manifest 失败 ${manifestPath}: ${asErrorMessage(error)}`, { cause: error });
  }
  assertManifest(manifest, manifestPath);

  const excludes = [...config.exclude];
  if (isPathInside(sourceDir, outDir)) {
    // 输出在源码内部时加入动态排除项，避免把上一次 dist 再复制进新 dist。
    const relativeOut = toPosixPath(path.relative(sourceDir, outDir));
    excludes.push(relativeOut, `${relativeOut}/**`);
  }

  // 先建立可用文件索引，再从 manifest 入口计算静态依赖闭包；未进入闭包的开发文件不会输出。
  const inventory = await collectSourceFiles(sourceDir, excludes);
  const files = await collectRequiredSourceFiles({
    manifest,
    manifestPath,
    inventory,
    include: config.include,
  });

  // dry-run 不得创建任何目录；普通构建才准备同级临时/备份路径用于原子替换。
  let stageDir: string | undefined;
  let backupDir: string | undefined;
  if (!dryRun) {
    const parentDir = path.dirname(outDir);
    const outName = path.basename(outDir);
    const token = randomUUID();
    stageDir = path.join(parentDir, `.${outName}.extb-tmp-${token}`);
    backupDir = path.join(parentDir, `.${outName}.extb-backup-${token}`);
    await mkdir(parentDir, { recursive: true });
    await mkdir(stageDir, { recursive: false });
  }

  // bytesAfter 不包含 ZIP，便于与原始文件体积做有意义的压缩率比较。
  const counts = { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 };
  let bytesBefore = 0;
  let bytesAfter = 0;
  let zipPath: string | undefined;
  let plannedZipPath: string | undefined;

  try {
    for (const file of files) {
      const destination =
        stageDir === undefined ? undefined : path.join(stageDir, ...file.relativePath.split('/'));
      if (destination !== undefined) await mkdir(path.dirname(destination), { recursive: true });
      bytesBefore += file.size;

      if (!TEXT_EXTENSIONS.has(path.posix.extname(file.relativePath).toLowerCase())) {
        // manifest 和所有未知资源都走 copyFile，保证内容逐字节不变。
        if (destination !== undefined) await copyFile(file.sourcePath, destination);
        bytesAfter += file.size;
        counts.copied += 1;
        continue;
      }

      try {
        // 文本转换失败时附加包内相对路径，让 CLI 能直接指出问题源码。
        const source = await readFile(file.sourcePath, 'utf8');
        const processed = await processTextFile(source, file.relativePath, config);
        if (destination !== undefined) await writeFile(destination, processed.content, 'utf8');
        bytesAfter += Buffer.byteLength(processed.content);
        counts[processed.kind] += 1;
        if (processed.obfuscated) counts.obfuscated += 1;
        if (processed.transpiled) counts.transpiled += 1;
      } catch (error) {
        throw new ExtbError(`处理 ${file.relativePath} 失败: ${asErrorMessage(error)}`, { cause: error });
      }
    }

    if (config.zip.enabled) {
      // 默认不使用 manifest.name，因为它可能是 __MSG_name__ 或包含文件系统非法字符。
      const defaultZipName = `${sanitizeFilePart(path.basename(sourceDir))}-${sanitizeFilePart(manifest.version)}.zip`;
      const zipName = validateZipName(config.zip.fileName ?? defaultZipName);
      plannedZipPath = path.join(outDir, zipName);
      if (stageDir !== undefined) {
        const stageZipPath = path.join(stageDir, zipName);
        await createZip(
          stageDir,
          stageZipPath,
          files.map((file) => file.relativePath),
        );
        // ZIP 此时仍在 stageDir，返回值必须预先换算成原子替换后的正式路径。
        zipPath = plannedZipPath;
      }
    }

    if (stageDir !== undefined && backupDir !== undefined) {
      await replaceDirectory(stageDir, outDir, backupDir);
    }
  } catch (error) {
    // force 允许处理“压缩失败发生在目录尚未完整创建”的情况；原始异常继续向上抛出。
    if (stageDir !== undefined) await rm(stageDir, { recursive: true, force: true });
    throw error;
  }

  const result: BuildResult = {
    dryRun,
    manifestPath,
    sourceDir,
    outDir,
    includedFiles: files.map((file) => file.relativePath).sort((left, right) => left.localeCompare(right)),
    files: counts,
    bytesBefore,
    bytesAfter,
  };
  if (zipPath !== undefined) result.zipPath = zipPath;
  if (dryRun && plannedZipPath !== undefined) result.plannedZipPath = plannedZipPath;
  return result;
}
