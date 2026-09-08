// 後台共用小工具
export async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401) {
    location.href = "/admin/login.html";
    throw new Error("unauthorized");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.error || res.statusText), { data });
  return data;
}

export function mountNav(active) {
  const items = [
    ["/admin/", "强项中心"],
    ["/admin/questions.html", "旧版题库"],
    ["/admin/stats.html", "旧版分析"],
  ];
  document.querySelector("header.top nav").innerHTML = items
    .map(([href, label]) => {
      const on = active === href ? " active" : "";
      return `<a class="${on.trim()}" href="${href}">${label}</a>`;
    })
    .join("");
  const out = document.querySelector("#logout");
  if (out) out.onclick = async () => {
    await api("/logout", { method: "POST" });
    location.href = "/admin/login.html";
  };
}
