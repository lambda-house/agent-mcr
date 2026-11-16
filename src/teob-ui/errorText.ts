/** What a failed request says to a person. A model provider refusing the organisation's key comes back as the HTTP
 *  client's raw line ("unexpected HTTP status: 401 Unauthorized for request POST https://openrouter.ai/…"); that one
 *  is said in words, and every other message is shown as the service wrote it. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/unexpected HTTP status: 40[13]\b/.test(raw) && /openrouter|\/api\/v1\//i.test(raw))
    return 'The model provider refused the key. An owner replaces it in Settings › Model key.'
  return raw
}
