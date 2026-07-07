/**
 * Parse model JSON output defensively. JSON mode *should* guarantee valid
 * JSON, but in practice (2026-07-08, Vertex gemini-3.5-flash vision): fenced
 * output, thought fragments, or trailing text after the closing brace all
 * happen. Never trust, always salvage.
 */
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

  // Extract the outermost {...} span — drops prose before/after the object
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
