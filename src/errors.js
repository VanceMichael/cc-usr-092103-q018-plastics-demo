// 领域错误：所有业务校验失败都抛出带 code 的 DomainError，便于上层按码处理。
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function assertDomain(condition, code, message) {
  if (!condition) {
    throw new DomainError(code, message);
  }
}
