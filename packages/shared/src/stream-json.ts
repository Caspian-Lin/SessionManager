/**
 * Streaming and line-by-line JSON parsing utilities for large conversation exports.
 */

/**
 * Iterates through a Buffer line by line without allocating intermediate arrays.
 * Handles both LF (\n) and CRLF (\r\n) line terminators.
 */
export function* iterJsonLines(buf: Buffer): Iterable<string> {
  let start = 0;
  const len = buf.length;

  for (let i = 0; i < len; i++) {
    if (buf[i] === 0x0a) {
      let lineEnd = i;
      if (lineEnd > start && buf[lineEnd - 1] === 0x0d) {
        lineEnd--;
      }
      if (lineEnd > start) {
        const line = buf.toString('utf8', start, lineEnd).trim();
        if (line.length > 0) {
          yield line;
        }
      }
      start = i + 1;
    }
  }

  if (start < len) {
    let lineEnd = len;
    if (lineEnd > start && buf[lineEnd - 1] === 0x0d) {
      lineEnd--;
    }
    if (lineEnd > start) {
      const line = buf.toString('utf8', start, lineEnd).trim();
      if (line.length > 0) {
        yield line;
      }
    }
  }
}

/**
 * Streams elements from a top-level JSON array without loading the full parsed AST
 * into memory at once. It scans top-level element boundaries while respecting
 * string escaping and bracket depth, and yields parsed elements of type T.
 */
export function* streamTopLevelJsonArray<T>(input: string | Buffer): Iterable<T> {
  const str = typeof input === 'string' ? input : input.toString('utf8');
  let pos = 0;
  const len = str.length;

  // Skip leading BOM and whitespace
  while (pos < len && (str.charCodeAt(pos) === 0xfeff || /\s/.test(str[pos]!))) {
    pos++;
  }

  if (pos >= len || str[pos] !== '[') {
    // If input does not start with '[', attempt a standard parse if it is an array
    const parsed = JSON.parse(str);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        yield item as T;
      }
      return;
    }
    throw new Error('Input is not a top-level JSON array starting with "["');
  }

  pos++; // Skip opening '['

  while (pos < len) {
    // Skip whitespace and element-delimiting commas
    while (pos < len && (str[pos] === ',' || /\s/.test(str[pos]!))) {
      pos++;
    }

    if (pos >= len || str[pos] === ']') {
      break;
    }

    const elemStart = pos;
    let depthBrace = 0;
    let depthBracket = 0;
    let inString = false;
    let escape = false;

    while (pos < len) {
      const ch = str[pos]!;

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depthBrace++;
        } else if (ch === '}') {
          depthBrace--;
        } else if (ch === '[') {
          depthBracket++;
        } else if (ch === ']') {
          if (depthBracket === 0 && depthBrace === 0) {
            // End of the enclosing array reached
            break;
          }
          depthBracket--;
        } else if (ch === ',') {
          if (depthBrace === 0 && depthBracket === 0) {
            // End of the current top-level array element reached
            break;
          }
        }
      }
      pos++;
    }

    const elemStr = str.slice(elemStart, pos).trim();
    if (elemStr.length > 0) {
      yield JSON.parse(elemStr) as T;
    }

    if (pos < len && str[pos] === ']') {
      break;
    }
  }
}
