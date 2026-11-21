/**
 * Output tokens as billed. Gemini charges thinking tokens at the output rate but
 * reports them separately from the visible answer (`thoughtsTokenCount`), so
 * counting only `candidatesTokenCount` under-records the cost of a call.
 */
export function billedOutputTokens(usage?: {
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
}): number | undefined {
  if (usage?.candidatesTokenCount == null && usage?.thoughtsTokenCount == null)
    return undefined;
  return (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
}

/** Characters per token used to estimate a request before it is sent: on the high side on purpose. */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/**
 * Input tokens a generate request may use, estimated before it is sent, for the reservation its
 * worst-case cost takes (AiUsageService.admit). `fileTokens` is what its attached files may cost,
 * counted from the files themselves (fileInputTokens in file-tokens.ts). What is recorded
 * afterwards is Google's own count.
 */
export function estimatedInputTokens(
  prompt: string,
  opts?: { system?: string; fileTokens?: number },
): number {
  const chars = prompt.length + (opts?.system?.length ?? 0);
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE) + (opts?.fileTokens ?? 0);
}
