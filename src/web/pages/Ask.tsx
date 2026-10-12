// Ask (SPEC 16.1): the chat dock's conversation at full height.
import { lazy, Suspense } from "react";
import type { Me } from "../api";
import { Skeleton } from "../components/ui";
import { PageHead } from "./Forecast";

const Conversation = lazy(() => import("../components/ChatDock").then((m) => ({ default: m.Conversation })));

export function AskPage({ me }: { me: Me }) {
  return (
    <>
      <PageHead title="Ask" sub="Questions are routed to governed, cohort-level tools. Individual-level, manager-level and protected-attribute questions are refused before any model call." />
      <section className="card" style={{ padding: 0, display: "flex", flexDirection: "column", minHeight: "70vh" }}>
        <Suspense fallback={<Skeleton height={300} />}>
          <Conversation me={me} full />
        </Suspense>
      </section>
    </>
  );
}
