/**
 * Structured logger with scoped tags and level filtering.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown> | undefined;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: 'json' | 'text';
  writer?: (entry: LogEntry) => void;
}

export interface Logger {
  readonly scope: string;
  readonly level: LogLevel;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(childScope: string): Logger;
}

function resolveDefaultLogLevel(): LogLevel {
  const envLevel = (
    process.env['SM_LOG_LEVEL'] ??
    process.env['LOG_LEVEL'] ??
    ''
  ).toLowerCase();

  if (envLevel === 'debug' || envLevel === 'info' || envLevel === 'warn' || envLevel === 'error' || envLevel === 'silent') {
    return envLevel;
  }
  if (process.env['DEBUG']) {
    return 'debug';
  }
  return 'info';
}

class StandardLogger implements Logger {
  public readonly scope: string;
  public readonly level: LogLevel;
  private readonly format: 'json' | 'text';
  private readonly writer: (entry: LogEntry) => void;

  constructor(scope: string, options: LoggerOptions = {}) {
    this.scope = scope;
    this.level = options.level ?? resolveDefaultLogLevel();
    this.format = options.format ?? 'text';
    this.writer = options.writer ?? this.defaultWriter.bind(this);
  }

  private isLevelEnabled(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= LOG_LEVEL_SEVERITY[this.level];
  }

  private defaultWriter(entry: LogEntry): void {
    if (this.format === 'json') {
      const line = JSON.stringify(entry);
      if (entry.level === 'error') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
      return;
    }

    // Human-readable format
    const metaStr = entry.meta && Object.keys(entry.meta).length > 0
      ? ' ' + JSON.stringify(entry.meta)
      : '';
    const line = `[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.message}${metaStr}`;
    if (entry.level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope: this.scope,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };
    this.writer(entry);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  child(childScope: string): Logger {
    return new StandardLogger(`${this.scope}:${childScope}`, {
      level: this.level,
      format: this.format,
      writer: this.writer,
    });
  }
}

export function createLogger(scope: string, options?: LoggerOptions): Logger {
  return new StandardLogger(scope, options);
}
