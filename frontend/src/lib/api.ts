export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Prefer the server's {error} message when the body is JSON, else raw text. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = await parseBody(res).catch(() => fallback);
  if (body === null || body === undefined) return fallback;
  if (typeof body === "string") return body || fallback;
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  // Empty objects/arrays carry no message — fall back instead of showing "{}".
  if (body && typeof body === "object" && Object.keys(body).length === 0) return fallback;
  try {
    return JSON.stringify(body);
  } catch {
    return fallback;
  }
}

/** Same-origin fetch against Veneer backend. Throws ApiError(401) when logged out. */
export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new ApiError(401, await errorMessage(res, "Not logged in"));
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, res.statusText));
  if (res.status === 204) return undefined as T;
  try {
    return (await parseBody(res)) as T;
  } catch {
    throw new ApiError(res.status, "Invalid response from server");
  }
}

/** POST a form-urlencoded mutation through the qb proxy. qB rejects JSON (400). */
export async function qbPost(path: string, params: Record<string, string>): Promise<string> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status === 401) throw new ApiError(401, await errorMessage(res, "Not logged in"));
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res, res.statusText));
  try {
    return await res.text();
  } catch {
    throw new ApiError(res.status, "Invalid response from server");
  }
}

export const fmtSpeed = (v: number): string => {
  if (!v || v <= 0) return "0 B/s";
  const u = ["B/s", "KB/s", "MB/s", "GB/s"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
};

export const fmtSize = (v: number): string => {
  if (!v || v <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
};

export const fmtEta = (s: number): string => {
  if (s == null || s < 0 || s > 8640000) return "∞";
  if (s === 0) return "done";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
};
