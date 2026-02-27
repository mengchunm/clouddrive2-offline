import { GM_xmlhttpRequest } from "vite-plugin-monkey/dist/client";

/**
 * A fetch-like shim implemented on top of GM_xmlhttpRequest to bypass page CSP.
 *
 * Notes:
 * - Requires @grant GM_xmlhttpRequest and appropriate @connect permissions in userscript metadata.
 * - Only supports the subset used by @connectrpc/connect-web (method, headers, body, arraybuffer response).
 * - Streaming (PushMessage) uses a separate client with native fetch, see client.ts getStreamingClient().
 */

/** 解析 responseHeaders 字符串为 Headers 对象 */
function parseHeaders(raw: string | undefined): Headers {
  const headers = new Headers();
  if (!raw) return headers;
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) headers.append(k, v);
    }
  }
  return headers;
}

/** 准备请求 body */
async function prepareBody(
  init: RequestInit,
  input: RequestInfo | URL,
): Promise<string | ArrayBuffer | undefined> {
  const body =
    init.body ?? (typeof input === "object" && input instanceof Request ? (input as Request).body : undefined);
  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return merged.buffer;
  }
  if (body instanceof ArrayBuffer) return body;
  if (body instanceof Uint8Array) {
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    return ab;
  }
  if (body instanceof Blob) return await body.arrayBuffer();
  if (typeof body === "string") return body;
  if (body == null) return undefined;
  return String(body as unknown as object);
}

export async function gmFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  // If GM_xmlhttpRequest is not available, fall back to native fetch
  const GMX: typeof GM_xmlhttpRequest | undefined =
    typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : undefined;

  if (!GMX) {
    return fetch(input as RequestInfo, init);
  }

  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const method =
    init.method ?? (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET");

  // Normalize headers
  const headersRecord: Record<string, string> = {};
  const pushHeader = (k: string, v: string) => {
    headersRecord[k] = v;
  };
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        pushHeader(k, v);
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) pushHeader(k, v);
    } else {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) pushHeader(k, v);
    }
  } else if (typeof input === "object" && input instanceof Request) {
    input.headers.forEach((v, k) => {
      pushHeader(k, v);
    });
  }

  // Prepare body
  const data = await prepareBody(init, input);

  const response: Response = await new Promise((resolve, reject) => {
    try {
      // Normalize method to an allowed union for Tampermonkey
      const mUpper = (method || "GET").toUpperCase() as Exclude<Tampermonkey.Request<unknown>["method"], undefined>;
      GMX({
        url,
        method: mUpper,
        headers: headersRecord,
        // Force arraybuffer to preserve binary frames of grpc-web
        responseType: "arraybuffer",
        data,
        onload: (ev) => {
          const status = ev.status ?? 0;
          const statusText = ev.statusText ?? "";
          const headers = parseHeaders(ev.responseHeaders);
          const ab = (ev.response as ArrayBuffer) ?? new ArrayBuffer(0);
          const res = new Response(ab, { status, statusText, headers });
          resolve(res);
        },
        onerror: () => reject(new TypeError("Network request failed (GM)")),
        ontimeout: () => reject(new TypeError("Network request timeout (GM)")),
      });
    } catch (e) {
      reject(e);
    }
  });

  return response;
}

export default gmFetch;
