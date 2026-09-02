/** Opt-in diagnostics go to the existing process log, never to conversation journals. */
export function debugLog(event: string, error: unknown, secrets: string[] = []): void {
  if (!/^(1|true)$/i.test(process.env.DEXCODE_DEBUG ?? '')) return;
  let detail = error instanceof Error ? error.message : String(error);
  const sensitive = Object.entries(process.env)
    .filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .flatMap(([, value]) => value && value.length >= 4 ? [value] : []);
  for (const value of [...secrets, ...sensitive]) if (value) detail = detail.split(value).join('[redacted]');
  detail = detail.replace(/Bearer\s+\S+|\bsk-[\w-]+/gi, '[redacted]')
    .replace(/(api[_-]?key|token|password|secret)(["'\s:=]+)[^\s,;"']+/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 2_000);
  try { console.error(JSON.stringify({ type: event, detail })); } catch { /* Logging is best effort. */ }
}
