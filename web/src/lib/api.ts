export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new ApiError(res.status, txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : {};
}
