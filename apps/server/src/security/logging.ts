/** Operational logs carry fixed categories. Driver errors can embed SQL, paths and data. */
export function errorCategory(error: unknown): string {
  const codeOf = (value: unknown) => value && typeof value === 'object' && 'code' in value ? value.code : undefined;
  const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
  const code = codeOf(error) ?? codeOf(cause);
  switch (code) {
    case 'ENOENT': return 'FILE_MISSING';
    case 'EISDIR': return 'FILE_TYPE';
    case 'EACCES':
    case 'EPERM': return 'FILE_ACCESS';
    case 'ENOSPC': return 'STORAGE_FULL';
    case 'EIO': return 'STORAGE_IO';
    case '23505':
    case '23503': return 'DATABASE_CONSTRAINT';
    case '40001':
    case '40P01': return 'DATABASE_TRANSACTION';
    case 'ETIMEDOUT':
    case 'ECONNREFUSED':
    case 'ECONNRESET': return 'CONNECTION';
    case 'EADDRINUSE': return 'ADDRESS_IN_USE';
    default: return 'INTERNAL';
  }
}

export const operationalLogOptions = {
  serializers: {
    // Request records are emitted separately from route templates and numeric status.
    req: () => ({}),
    res: () => ({}),
    err: (error: unknown) => ({ type: 'OperationalError', message: errorCategory(error), stack: '' }),
  },
};
