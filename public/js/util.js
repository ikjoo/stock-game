export const $ = id => document.getElementById(id);
export const won = n => n.toLocaleString('ko-KR') + '원';
export const signed = n => (n > 0 ? '+' : '') + n.toLocaleString() + '원';
export const trendClass = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error || '오류'), { status: r.status });
  return data;
}
