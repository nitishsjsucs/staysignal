// Local role switcher (SPEC 17.1): signs in as one of the synthetic role mailboxes through /dev/login, honored only in
// dev mode on localhost. Production uses Cloudflare Access and shows only the signed-in principal. The public demo
// (ADR 0018) switches between the same principals inside the visitor's sandbox.
import { useEffect, useState } from "react";
import { getJSON, invalidate, type Me } from "../api";
import { switchDemoRole } from "../demo";

interface Principals {
  principals: { id: string; role: string; display: string }[];
}

export async function devLogin(id: string): Promise<void> {
  await getJSON(`/dev/login?principal=${encodeURIComponent(id)}`);
  invalidate();
  window.dispatchEvent(new Event("ss-principal"));
}

export function RoleSwitcher({ me }: { me: Me | null }) {
  if (me?.public_demo) return <DemoRoleSwitcher me={me} />;
  return <DevRoleSwitcher me={me} />;
}

/** The public demo (ADR 0018): the same seven principals, switched inside the visitor's sandbox. */
function DemoRoleSwitcher({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="label-sm hide-mobile">Acting as</span>
      <select
        className="select"
        aria-label="Acting as (demo role)"
        value={me.principal.id}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          void switchDemoRole(e.target.value, me.public_demo!.principals).finally(() => setBusy(false));
        }}
        style={{ maxWidth: 220 }}
      >
        {me.public_demo!.principals.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display}
          </option>
        ))}
      </select>
    </label>
  );
}

function DevRoleSwitcher({ me }: { me: Me | null }) {
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
