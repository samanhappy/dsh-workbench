/**
 * Domain errors for the host half.
 *
 * They live in their own module so the git runner, path guards and route
 * handlers can agree on one error vocabulary without importing each other.
 */

/** Invalid request input; carries the HTTP status the guard should answer with. */
export class RequestError extends Error {
  constructor(message, status = 400, code = 'bad-request') {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

/** A git invocation that could not run or exited non-zero. */
export class GitError extends Error {
  constructor(message, code = 'git-failed') {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}
