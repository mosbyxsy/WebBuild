/**
 * extb 的领域错误。
 *
 * 使用独立错误类型便于调用方区分“构建失败”和普通编程异常；cause 会保留底层
 * 文件系统或第三方压缩器抛出的原始错误，方便继续诊断。
 */
import { WebBuildError } from '../core/errors.js';
export { asErrorMessage } from '../core/errors.js';

export class ExtbError extends WebBuildError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExtbError';
  }
}
