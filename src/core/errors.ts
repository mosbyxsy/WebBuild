/**
 * 两种构建模式及公共核心的错误工具。
 * 所有预期内的用户输入、配置和构建错误都继承 WebBuildError；底层异常通过
 * ErrorOptions.cause 保留下来，CLI 显示简洁消息时，API 调用方仍能读取完整原因链。
 */
export class WebBuildError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebBuildError';
  }
}

/** 把 catch 中的 unknown 安全转换为可展示文本，兼容第三方库直接抛字符串的情况。 */
export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
