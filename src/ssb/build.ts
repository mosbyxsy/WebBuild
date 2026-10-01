import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { collectRequiredSourceFiles } from './dependencies.js';
import { SsbError, asErrorMessage } from './errors.js';
import { collectSourceFiles, isPathInside, toPosixPath } from '../core/paths.js';
import { processTextFile } from '../core/processors.js';
import type { BuildOptions, BuildResult } from './types.js';

/** 仅这些类型以 UTF-8 文本处理；图片、字体、WASM 等始终按字节复制。 */
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.css']);

/** 若输出位于源码树内，把它动态加入扫描排除项，避免重复构建时递归复制旧 dist。 */
function excludeNestedDirectory(root: string, directory: string, excludes: readonly string[]): string[] {
  const next = [...excludes];
  if (!isPathInside(path.resolve(root), path.resolve(directory))) return next;
  const relative = toPosixPath(path.relative(root, directory));
  next.push(relative, `${relative}/**`);
  return next;
}

/** 禁止输出目录等于源码或包含源码，防止原子替换时移动/删除整个源码目录。 */
function validateOutputPath(root: string, outDir: string): void {
  if (root === outDir || isPathInside(outDir, root)) {
    throw new SsbError(`输出目录不能等于源码根目录或包含源码根目录: ${outDir}`);
  }
}

/**
 * 把 CLI/配置入口转换成源码根目录内的 POSIX 相对路径。
 * 相对入口可以保留 glob；绝对入口必须是明确文件且必须仍位于 root 内。
 */
function normalizeEntry(entry: string, root: string): string {
  if (entry.trim() === '') throw new SsbError('HTML 入口不能是空字符串。');
  if (path.isAbsolute(entry)) {
    if (/[*?\[\]{}()]/.test(entry)) throw new SsbError(`绝对入口不支持 glob: ${entry}`);
    const relative = path.relative(root, entry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SsbError(`HTML 入口必须位于源码根目录内: ${entry}`);
    }
    return toPosixPath(relative);
  }
  const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new SsbError(`HTML 入口越过源码根目录: ${entry}`);
  return normalized;
}

/**
 * 原子发布临时目录：先备份旧输出，再提升完整的新输出。
 * 提升失败时恢复备份；只有新目录完整就位后才清理旧目录，因此转换失败不会破坏产物。
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
        throw new SsbError(`替换输出失败且无法恢复旧输出，备份位于 ${backupDir}: ${asErrorMessage(restoreError)}`, {
          cause: error,
        });
      }
    }
    throw new SsbError(`替换输出目录失败: ${asErrorMessage(error)}`, { cause: error });
  }
  if (backedUp) {
    try {
      await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      throw new SsbError(`新输出已生成，但无法清理旧输出备份 ${backupDir}: ${asErrorMessage(error)}`, { cause: error });
    }
  }
}

/**
 * ssb 完整构建入口：加载配置、建立文件库存、确定 HTML 入口、计算依赖闭包、转换资源，
 * 最后原子替换输出目录。dryRun 会执行所有分析和转换验证，但完全不创建输出目录。
 */
export async function build(options: BuildOptions = {}): Promise<BuildResult> {
  // 执行上下文字段与可写入配置文件的字段分离，剩余字段才作为最高优先级 overrides。
  const { cwd, configFile, dryRun = false, ...overrides } = options;
  const config = await loadConfig({
    ...(cwd === undefined ? {} : { cwd }),
    ...(configFile === undefined ? {} : { configFile }),
    overrides,
  });
  const root = path.resolve(config.root);
  const outDir = path.resolve(config.outDir);
  validateOutputPath(root, outDir);
  const excludes = excludeNestedDirectory(root, outDir, config.exclude);
  const inventory = await collectSourceFiles(root, excludes);

  let entries = config.entries.map((entry) => normalizeEntry(entry, root));
  if (entries.length === 0) {
    // 零配置模式只选择 root 直属 HTML，避免无意中把示例、测试或旧输出中的页面当入口。
    entries = inventory
      .map((file) => file.relativePath)
      .filter((relativePath) => !relativePath.includes('/') && /\.html?$/i.test(relativePath));
    if (entries.length === 0) {
      throw new SsbError(`在 ${root} 根目录下未找到 HTML 文件，请通过位置参数、--entry 或配置 entries 指定入口。`);
    }
  }

  // 依赖分析只返回入口可达或 include 强制加入的文件，未引用源码不会进入产物。
  const collected = await collectRequiredSourceFiles({ inventory, entries, include: config.include });
  let stageDir: string | undefined;
  let backupDir: string | undefined;
  if (!dryRun) {
    // 临时目录和正式输出位于同一父目录，以便 rename 在同一文件系统内原子完成。
    const parentDir = path.dirname(outDir);
    const outName = path.basename(outDir);
    const token = randomUUID();
    stageDir = path.join(parentDir, `.${outName}.ssb-tmp-${token}`);
    backupDir = path.join(parentDir, `.${outName}.ssb-backup-${token}`);
    await mkdir(parentDir, { recursive: true });
    await mkdir(stageDir);
  }

  const counts = { copied: 0, html: 0, js: 0, css: 0, obfuscated: 0, transpiled: 0 };
  let bytesBefore = 0;
  let bytesAfter = 0;
  try {
    for (const file of collected.files) {
      const destination = stageDir === undefined ? undefined : path.join(stageDir, ...file.relativePath.split('/'));
      if (destination !== undefined) await mkdir(path.dirname(destination), { recursive: true });
      bytesBefore += file.size;
      const extension = path.posix.extname(file.relativePath).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) {
        // 二进制和未知文本格式绝不解码重写，保证 hash、字体和图片内容不变。
        if (destination !== undefined) await copyFile(file.sourcePath, destination);
        bytesAfter += file.size;
        counts.copied += 1;
        continue;
      }
      try {
        const source = await readFile(file.sourcePath, 'utf8');
        const processed = await processTextFile(source, file.relativePath, config);
        if (processed.kind === 'copied') {
          // 即使是已读取的文本，只要没有启用任何转换，也优先 copyFile 保持原始字节/BOM。
          if (destination !== undefined) await copyFile(file.sourcePath, destination);
          bytesAfter += file.size;
          counts.copied += 1;
        } else {
          if (destination !== undefined) await writeFile(destination, processed.content, 'utf8');
          bytesAfter += Buffer.byteLength(processed.content);
          counts[processed.kind] += 1;
        }
        if (processed.obfuscated) counts.obfuscated += 1;
        if (processed.transpiled) counts.transpiled += 1;
      } catch (error) {
        throw new SsbError(`处理 ${file.relativePath} 失败: ${asErrorMessage(error)}`, { cause: error });
      }
    }
    if (stageDir !== undefined && backupDir !== undefined) await replaceDirectory(stageDir, outDir, backupDir);
  } catch (error) {
    // 构建失败只清理本次唯一临时目录；旧 outDir 尚未被替换，仍保持可用。
    if (stageDir !== undefined) await rm(stageDir, { recursive: true, force: true });
    throw error;
  }

  return {
    dryRun,
    sourceDir: root,
    outDir,
    entryPaths: collected.entryPaths,
    includedFiles: collected.files.map((file) => file.relativePath),
    files: counts,
    bytesBefore,
    bytesAfter,
  };
}
