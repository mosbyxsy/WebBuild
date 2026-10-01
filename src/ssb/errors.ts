import { WebBuildError } from '../core/errors.js';
export { asErrorMessage } from '../core/errors.js';

/** ssb 领域错误，便于 API 调用方区分预期构建失败和普通程序异常。 */
export class SsbError extends WebBuildError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SsbError';
  }
}
