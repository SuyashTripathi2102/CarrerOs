/**
 * Parse model JSON output defensively. JSON mode *should* guarantee valid
 * JSON, but in practice (2026-07-08, Vertex gemini-3.5-flash vision): fenced
 * output, thought fragments, or trailing text after the closing brace all
 * happen. Never trust, always salvage.
 */
/**
 * The first complete `{...}` object, counting depth outside of string literals
 * so that braces in prose ("we use {} for blocks") and escaped quotes inside
 * reasoning text cannot throw off the scan.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function parseModelJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to salvage attempts
  }

  // Strip markdown fences (```json ... ```)
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // fall through
  }

  // First BALANCED {...} object. lastIndexOf('}') is wrong when the model
  // emits duplicated closers — seen 2026-07-09, "...}\n ]\n}\n ]\n}" — which
  // aborted a 312-job reconcile mid-run.
  const balanced = firstBalancedObject(unfenced) ?? firstBalancedObject(text);
  if (balanced) {
    try {
      return JSON.parse(balanced) as T;
    } catch {
      // fall through
    }
  }

  // Last resort: outermost span, for prose wrapped around a valid object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
      // fall through
    }
  }

  throw new Error(
    `Model returned invalid JSON (len=${text.length}). ` +
      `head: ${JSON.stringify(text.slice(0, 160))} ` +
      `tail: ${JSON.stringify(text.slice(-160))}`,
  );
}
