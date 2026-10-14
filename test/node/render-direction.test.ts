// "fell by -0.4" reads as a double negative: after a downward word the renderer shows the size of a negative value.
import { describe, expect, it } from "vitest";
import { renderPlaceholders, type AliasMap } from "../../src/shared/grounding/aliases";

const aliases: AliasMap = new Map([["r1", { alias: "r1", result_id: "res_x", tool: "explain_change", step: 0.1, values: { delta: -0.4, up: 0.2, factors: [{ phi: -0.7 }, { phi: 0.3 }] } }]]);
const render = (t: string) => renderPlaceholders(t, aliases).text;

describe("downward words carry the sign", () => {
  it("shows the size after fell, reduced and subtracted", () => {
    expect(render("It fell by {{r1.delta|1dp}} people.")).toBe("It fell by 0.4 people.");
    expect(render("Calendar reduced the forecast by {{r1.factors.0.phi|1dp}} people.")).toBe("Calendar reduced the forecast by 0.7 people.");
    expect(render("The definition change subtracted {{r1.delta|1dp}} people.")).toBe("The definition change subtracted 0.4 people.");
  });
  it("keeps the sign anywhere else, and leaves positive values alone", () => {
    expect(render("The change was {{r1.delta|1dp}} people.")).toBe("The change was -0.4 people.");
    expect(render("Input data added {{r1.factors.1.phi|1dp}} people.")).toBe("Input data added 0.3 people.");
    expect(render("It fell. Then the change was {{r1.delta|1dp}}.")).toBe("It fell. Then the change was -0.4.");
  });
  it("still records the true value as used", () => {
    expect(renderPlaceholders("It fell by {{r1.delta|1dp}}.", aliases).used[0]!.value).toBe(-0.4);
  });
});
