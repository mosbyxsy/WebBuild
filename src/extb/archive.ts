import { createWriteStream } from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { ExtbError } from './errors.js';

/**
 * 将已经写入临时输出目录的文件流式打包为 ZIP。
 *
 * relativeFiles 是构建前确定的白名单，而不是再次扫描 directory。这样生成中的 ZIP
 * 不会把自己打进去，也不会因为并发出现的临时文件而污染产物。ZIP 条目名由上游统一
 * 转换为 POSIX 路径，可在 Windows、macOS 和 Linux 上得到相同目录结构。
 */
export async function createZip(
  directory: string,
  zipPath: string,
  relativeFiles: readonly string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // wx 要求目标不存在，可防止自定义 ZIP 名称静默覆盖同名源码文件。
    const output = createWriteStream(zipPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });

    // 必须等待输出流 close；archive.finalize() 完成只代表归档器停止写入，不代表文件已落盘。
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.on('warning', (warning) => {
      // archiver 把个别缺失文件作为 warning；其他 warning 仍应使构建失败。
      if ((warning as NodeJS.ErrnoException).code !== 'ENOENT') reject(warning);
    });

    archive.pipe(output);
    for (const relativePath of relativeFiles) {
      archive.file(path.join(directory, ...relativePath.split('/')), { name: relativePath });
    }
    // finalize 返回 Promise，但流事件仍是最终完成信号；这里仅把异步拒绝转发给外层。
    void archive.finalize().catch(reject);
  }).catch((error: unknown) => {
    throw new ExtbError(`创建 ZIP 失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  });
}
