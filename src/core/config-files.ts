import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createJiti } from 'jiti';
import { WebBuildError, asErrorMessage } from './errors.js';

/** 支持自动加载的配置文件扩展名，排列顺序也用于生成稳定的候选列表。 */
export const CONFIG_EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'] as const;
/** 两种命令共同读取的低优先级配置文件名。 */
export const BUILD_CONFIG_FILE_NAMES = CONFIG_EXTENSIONS.map((extension) => `build.config.${extension}`);

/** 根据命令模式生成 extb.config.* 或 ssb.config.* 的完整候选文件名。 */
export function modeConfigFileNames(mode: 'extb' | 'ssb'): string[] {
  return CONFIG_EXTENSIONS.map((extension) => `${mode}.config.${extension}`);
}

/** 仅检查路径可访问性；不存在和无权限都统一返回 false，由调用方生成领域错误。 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从同一配置族中选择唯一文件。
 * 同时存在 .ts 和 .json 等多个变体时不猜测优先级，要求用户删除重复项或显式指定。
 */
function selectUniqueConfig(root: string, names: Set<string>, family: string, candidates: readonly string[]): string | undefined {
  const matches = candidates.filter((name) => names.has(name)).map((name) => path.join(root, name));
  if (matches.length > 1) {
    throw new WebBuildError(
      `发现多个 ${family} 配置文件，请删除重复文件或使用 --config 明确指定：\n${matches.map((file) => `  - ${file}`).join('\n')}`,
    );
  }
  return matches[0];
}

/** 自动配置顺序固定为 build.config.* < 模式专属配置。 */
export async function discoverConfigFiles(root: string, mode: 'extb' | 'ssb'): Promise<string[]> {
  let names: Set<string>;
  try {
    names = new Set(await readdir(root));
  } catch (error) {
    throw new WebBuildError(`无法读取根目录 ${root}: ${asErrorMessage(error)}`, { cause: error });
  }
  const common = selectUniqueConfig(root, names, 'build', BUILD_CONFIG_FILE_NAMES);
  const specific = selectUniqueConfig(root, names, mode, modeConfigFileNames(mode));
  return [common, specific].filter((file): file is string => file !== undefined);
}

/**
 * 加载 JSON 或 JavaScript/TypeScript 配置。
 * jiti 负责 ESM、CommonJS 和 TypeScript 的兼容加载；关闭模块缓存后，同一进程中的
 * 测试、watch 或二次调用能够读取刚修改的配置，而不会复用上次导出值。
 */
export async function readConfigFile<T extends object>(filePath: string): Promise<T> {
  let value: unknown;
  try {
    if (path.extname(filePath).toLowerCase() === '.json') {
      value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } else {
      const jiti = createJiti(import.meta.url, { moduleCache: false });
      value = await jiti.import(filePath, { default: true });
    }
  } catch (error) {
    throw new WebBuildError(`加载配置文件 ${filePath} 失败: ${asErrorMessage(error)}`, { cause: error });
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebBuildError(`配置文件 ${filePath} 必须导出一个对象。`);
  }
  return value as T;
}
