import { createUi } from "../../src/ui/index.js";
import { fakeStream } from "./ui-streams.js";

/** The `ui`, `timeline`, `approval` and `title` applyPlan needs, writing to a plain in-memory stream: for tests that apply a plan with --yes or no terminal. */
export function applyUi(): { ui: ReturnType<typeof createUi>; timeline: ReturnType<ReturnType<typeof createUi>["timeline"]>; approval: "checklist"; title: string } {
  const ui = createUi(fakeStream(), { plain: true, platform: "linux", env: { LANG: "en_US.UTF-8" } });
  return { ui, timeline: ui.timeline(), approval: "checklist", title: "Choose what to set up" };
}
