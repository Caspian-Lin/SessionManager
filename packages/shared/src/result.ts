/**
 * Result<T, E> discriminated union pattern for robust error handling without exceptions.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof Error) {
    throw result.error;
  }
  throw new Error(String(result.error));
}

export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

export function mapResult<T, U, E>(result: Result<T, E>, fn: (val: T) => U): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  if (!result.ok) {
    return err(fn(result.error));
  }
  return result;
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (val: T) => Result<U, E>): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

export function tryCatch<T, E = Error>(fn: () => T, onError?: (err: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (caught) {
    if (onError) {
      return err(onError(caught));
    }
    return err((caught instanceof Error ? caught : new Error(String(caught))) as E);
  }
}

export async function tryCatchAsync<T, E = Error>(
  fn: () => Promise<T>,
  onError?: (err: unknown) => E
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (caught) {
    if (onError) {
      return err(onError(caught));
    }
    return err((caught instanceof Error ? caught : new Error(String(caught))) as E);
  }
}
