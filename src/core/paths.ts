import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { WebBuildError, asErrorMessage } from './errors.js';

/**
 * 一个待打包文件的物理位置与包内逻辑位置。
 * sourcePath 可能是符号链接解析后的目标，而 relativePath 始终保持用户看到的链接路径。
 */
export interface SourceFile {
  sourcePath: string;
  relativePath: string;
  size: number;
}

/**
 * ZIP 和 glob 统一使用 `/`，避免 Windows 的反斜杠导致匹配失败或生成非标准 ZIP 条目。
 */
export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * 判断 child 是否严格位于 parent 内部。
 * 相同路径返回 false，且显式排除 `..` 和绝对路径结果，避免简单字符串前缀的误判。
 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 按平台大小写规则匹配任意一个用户 glob，并允许匹配点文件。 */
export function matchesAny(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true, nocase: process.platform === 'win32' }));
}

/**
 * 目录除了匹配自身，还以尾随 `/` 再匹配一次，使 `vendor/**` 能在进入 vendor 前被剪枝，
 * 避免无意义地遍历体积很大的排除目录。
 */
function isExcluded(relativePath: string, patterns: readonly string[], directory: boolean): boolean {
  if (matchesAny(relativePath, patterns)) return true;
  return directory && matchesAny(`${relativePath}/`, patterns);
}

/**
 * 递归遍历一个物理目录，同时累积其在扩展包中的逻辑目录。
 *
 * physicalDirectory 用于读取磁盘；logicalDirectory 用于生成输出相对路径。两者分离后，
 * 即使目录来自符号链接，也可以把目标内容复制到符号链接原本所在的位置。
 */
async function collectDirectory(
  physicalDirectory: string,
  logicalDirectory: string,
  sourceRealPath: string,
  excludes: readonly string[],
  ancestors: ReadonlySet<string>,
  output: SourceFile[],
): Promise<void> {
  let directory;
  try {
    directory = await opendir(physicalDirectory);
  } catch (error) {
    throw new WebBuildError(`无法读取目录 ${physicalDirectory}: ${asErrorMessage(error)}`, { cause: error });
  }

  const entries = [];
  for await (const entry of directory) entries.push(entry);
  // 固定遍历顺序，让测试、统计和 ZIP 条目顺序尽可能稳定。
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const physicalPath = path.join(physicalDirectory, entry.name);
    const logicalPath = logicalDirectory ? path.join(logicalDirectory, entry.name) : entry.name;
    const relativePath = toPosixPath(logicalPath);
    const entryLstat = await lstat(physicalPath);

    if (entryLstat.isSymbolicLink()) {
      // 不允许链接逃逸源码根目录，否则一次构建可能无意中打包密钥或用户文件。
      const target = await realpath(physicalPath);
      if (target !== sourceRealPath && !isPathInside(sourceRealPath, target)) {
        throw new WebBuildError(`符号链接指向源码目录之外: ${path.join(sourceRealPath, logicalPath)} -> ${target}`);
      }
      const targetStat = await stat(target);
      if (isExcluded(relativePath, excludes, targetStat.isDirectory())) continue;
      if (targetStat.isDirectory()) {
        // ancestors 存储当前递归链上的真实路径，只阻止循环，不阻止合法地从不同位置复用目录。
        if (ancestors.has(target)) throw new WebBuildError(`检测到循环符号链接: ${path.join(sourceRealPath, logicalPath)}`);
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(target);
        await collectDirectory(target, logicalPath, sourceRealPath, excludes, nextAncestors, output);
      } else if (targetStat.isFile()) {
        output.push({ sourcePath: target, relativePath, size: targetStat.size });
      }
      continue;
    }

    if (entryLstat.isDirectory()) {
      if (isExcluded(relativePath, excludes, true)) continue;
      const target = await realpath(physicalPath);
      if (ancestors.has(target)) throw new WebBuildError(`检测到循环目录: ${physicalPath}`);
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(target);
      await collectDirectory(physicalPath, logicalPath, sourceRealPath, excludes, nextAncestors, output);
    } else if (entryLstat.isFile() && !isExcluded(relativePath, excludes, false)) {
      output.push({ sourcePath: physicalPath, relativePath, size: entryLstat.size });
    }
  }
}

/**
 * 收集源码目录内的所有普通文件。
 * 返回前不读取文件内容，也不创建输出，因此可同时用于 manifest 发现和正式构建。
 */
export async function collectSourceFiles(sourceDirectory: string, excludes: readonly string[]): Promise<SourceFile[]> {
  const sourceRealPath = await realpath(sourceDirectory);
  const output: SourceFile[] = [];
  await collectDirectory(sourceRealPath, '', sourceRealPath, excludes, new Set([sourceRealPath]), output);
  return output;
}

/** 从收集结果中筛选文件名为 manifest.json 的候选项，匹配时忽略大小写。 */
export async function findManifests(root: string, excludes: readonly string[]): Promise<string[]> {
  const files = await collectSourceFiles(root, excludes);
  return files
    .filter((file) => path.posix.basename(file.relativePath).toLowerCase() === 'manifest.json')
    .map((file) => file.sourcePath);
}
