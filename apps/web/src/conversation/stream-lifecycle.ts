export function abortStreamOnPageHide(controller: AbortController): () => void {
  const abort = () => controller.abort();
  window.addEventListener('beforeunload', abort);
  window.addEventListener('pagehide', abort);
  return () => {
    window.removeEventListener('beforeunload', abort);
    window.removeEventListener('pagehide', abort);
  };
}
