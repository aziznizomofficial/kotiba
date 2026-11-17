// How model downloads reach the network. (1.0.3, the owner's "downloading the language models
// kept failing".)
//
// Node's `fetch` (undici) in Electron's main process ignores Windows' proxy settings and trusts
// only the CA list compiled into Node. Two things common on the PCs Kotiba is for break exactly
// that: antivirus HTTPS scanning (Kaspersky and ESET re-sign every TLS connection with a root
// they add to the WINDOWS certificate store — undici rejects it, "unable to get local issuer
// certificate", on every attempt), and a system or PAC proxy. Electron's `net.fetch` is
// Chromium's network stack: the system proxy, the Windows store, Chromium's own reconnect logic —
// what the user's browser does, which is the download that works for them.
//
// So `net.fetch` first, and Node's `fetch` behind it for a request `net.fetch` could not even
// start (a Chromium-side refusal Node may not share). Only before a response: once bytes flow,
// the downloader's own retry and resume take over (`src/engines/download-file.ts`).

/** `primary`, and `secondary` for a request `primary` rejected before any response. */
export function downloadTransport(primary: typeof fetch, secondary: typeof fetch | null): typeof fetch {
  if (secondary === null) return primary;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    try {
      return await primary(input, init);
    } catch (error: unknown) {
      // A quit (or the downloader's own stall abort) is not a transport problem.
      if (init?.signal?.aborted === true) throw error;
      try {
        return await secondary(input, init);
      } catch {
        // The first transport's reason: it is the one the user's browser would have shared.
        throw error;
      }
    }
  }) as typeof fetch;
}
