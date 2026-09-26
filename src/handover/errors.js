// 领域错误类型：消息面向展会现场操作人员，使用中文。

export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

// 时段冲突、重复扫码、重复同意、重复处置等幂等/排他冲突。
export class ConflictError extends DomainError {
  constructor(code, message) {
    super(code, message);
    this.name = 'ConflictError';
  }
}

// 越权导出等授权失败。
export class AuthorizationError extends DomainError {
  constructor(code, message) {
    super(code, message);
    this.name = 'AuthorizationError';
  }
}
