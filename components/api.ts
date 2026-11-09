// Small client-side fetch wrapper. Every API route returns JSON, with `{ error }` on failure.

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data: Record<string, unknown> | null };

export async function postJson<T>(url: string, body?: unknown): Promise<ApiResult<T>> {
  return request<T>(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function getJson<T>(url: string): Promise<ApiResult<T>> {
  return request<T>(url, { method: "GET", cache: "no-store" });
}

async function request<T>(url: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, status: 0, error: "No connection. Check the signal and try again.", data: null };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON body (e.g. a proxy error page); fall through with data = null.
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const error = typeof obj?.error === "string" ? obj.error : `The server answered ${res.status}. Please try again.`;
  return { ok: false, status: res.status, error, data: obj };
}

/** Random id that also works on plain-http LAN addresses, where crypto.randomUUID is unavailable. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
