// Local role switcher (SPEC 17.1): signs in as one of the synthetic role mailboxes through /dev/login, honored only in
// dev mode on localhost. Production uses Cloudflare Access and shows only the signed-in principal.
import { useEffect, useState } from "react";
import { getJSON, invalidate, type Me } from "../api";

interface Principals {
  principals: { id: string; role: string; display: string }[];
}

export async function devLogin(id: string): Promise<void> {
  await getJSON(`/dev/login?principal=${encodeURIComponent(id)}`);
  invalidate();
  window.dispatchEvent(new Event("ss-principal"));
}

export function RoleSwitcher({ me }: { me: Me | null }) {
  const [list, setList] = useState<Principals["principals"] | null>(null);
  useEffect(() => {
    getJSON<Principals>("/dev/principals").then((p) => setList(p.principals), () => setList(null));
  }, []);
  if (!list) return me ? <span className="chip">{me.principal.display}</span> : null;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="label-sm hide-mobile">Acting as</span>
      <select className="select" aria-label="Acting as (local role switcher)" value={me?.principal.id ?? ""} onChange={(e) => void devLogin(e.target.value)} style={{ maxWidth: 220 }}>
        {me ? null : <option value="">Choose a role</option>}
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display} ({p.id.split("@")[0]})
          </option>
        ))}
      </select>
    </label>
  );
}
