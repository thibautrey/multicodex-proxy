export const tokenDefault = localStorage.getItem("adminToken") ?? "change-me";

export async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-admin-token": localStorage.getItem("adminToken") ?? tokenDefault,
      ...(init?.headers ?? {}),
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt || `HTTP ${res.status}`);
  return txt ? JSON.parse(txt) : {};
}
