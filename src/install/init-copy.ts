// Every fixed line `jubarteai init` and `jubarteai link` print. The app's first-API-key nudge email quotes these
// strings verbatim (its test reads this file), so keep them plain English and stable: change one only together with
// the email. Lines that need a value are small functions below, never interpolation inside INIT_COPY.
// Nothing here ever holds a key, a code or a file's content.

export const INIT_COPY = {
  // Said after hooks were written: their command names this Node and this install by path.
  hooksRefresh: "If you upgrade Node or reinstall jubarteai, run jubarteai init again to refresh the hooks.",

  // The last line of every init run.
  restart: "Restart your editor or agent so it picks up the changes.",

  // What the plan runner (src/safe-edit/plan.ts) prints. init-copy.test.ts runs a real plan and checks each of
  // these against it, so a change there is caught here before it reaches the email.
  // The one approval: a checklist with every row checked, where Enter applies what is checked.
  checklistTitle: "Choose what to set up",
  notSelected: "not selected",
  declined: "declined",
  statusConfigured: "configured",
  statusAlreadyConfigured: "already configured",
  statusSkipped: "skipped",
  statusFailed: "failed",

  // Account.
  notSignedIn: "Not signed in. Run: jubarteai login",
  chooseAccount: "Which account should this repo use?",
  signInOther: "Sign in to another account",
  workspaceFlagWithKey: "--workspace can't be combined with JUBARTEAI_TOKEN: the key decides the workspace.",
  loginFlagsWithKey: "--paste and --no-browser can't be combined with JUBARTEAI_TOKEN: the key signs you in without a browser.",
  pasteNeedsTerminal: "--paste needs a terminal to paste the code into. Run jubarteai init without --paste.",

  // Something an adapter could not read: the step is reported failed with this detail, the others still run.
  inspectFailed: "could not read its config files",

  // Where it runs.
  globalOnly: "Not in a project folder, so only the global steps run (no repo binding, project skill or AGENTS.md).",

  // Binding (spec section 3.2).
  shareBindingQuestion: "Share this workspace binding with everyone who clones the repo?",
  bindingConflict: "Use either --share-binding or --private-binding, not both.",
  bindingPrivate: "The binding is private: .jubarteai/ is listed in .gitignore.",
  bindingShared: "The binding is shared: commit .jubarteai/config.json. Your address stays in .jubarteai/config.local.json, which is ignored.",
  bindingKeptSharedTracked: "Kept the shared form: git tracks the binding, so your address went to the ignored .jubarteai/config.local.json.",
  bindingKeptSharedExisting: "Kept the shared form: this repo's binding is already shared, so your address went to the ignored .jubarteai/config.local.json.",
  bindingUnchanged: "The binding already matches.",

  // Sensitive steps skipped on purpose.
  noTerminal: "There is no terminal to ask on, so the steps marked skipped were not applied. Rerun them with the flag shown, or with --yes.",
  manualHeading: "Do these by hand:",

  // Codex (spec section 6.1 step 7, D5).
  codexRegisterLabel: "Register JubarteAI in Codex's MCP config (user level)",
  codexKept: "kept: Codex keeps its jubarteai MCP entry until its network setting is in place",
  codexEntryExists: "Codex already has a jubarteai entry there",
  codexTableInline: "jubarteai is set inline in that file, so add the entry by hand",
  codexRegisterNotNeeded: "the network opt-in is in place",
  codexUpdateLabel: "Update the key in Codex's MCP config (user level)",
  codexForeignTitle: "Codex MCP entry for another JubarteAI address",
  codexForeignReason: "its url is not this account's, so the key was left alone",
  codexOtherWorkspaceTitle: "Codex MCP entry uses another workspace",
  codexOtherWorkspaceReason: "its key belongs to another saved login, so it was left alone",
  codexUnreadableTitle: "Codex MCP entry key",
  codexUnreadableReason: "its key is not in a form init can rewrite",
  npxNote: "You ran jubarteai through npx: install it globally (npm i -g jubarteai) so the hooks keep working.",
  codexKeyShape: "the saved key has an unexpected format, so log in again",

  // link (spec section 5.5).
  linkNeedsProject: "Run this inside a project folder: a binding belongs to a repo, not to your home folder or /.",
} as const;

export type InitCopyKey = keyof typeof INIT_COPY;

/** "Use <email> — <workspace>?" (the confirm appends " [Y/n]"). */
export function useAccountQuestion(email: string, workspace: string): string {
  return `Use ${email} — ${workspace}?`;
}

/** One row of the account picker. */
export function accountChoiceLabel(email: string, workspace: string): string {
  return `${email} — ${workspace}`;
}

/** The label of the binding step in the plan. */
export function bindingStepLabel(workspace: string): string {
  return `Bind this repo to workspace ${workspace}`;
}

/** The label of the binding step when the repo is already bound to another workspace. */
export function rebindStepLabel(from: string, to: string): string {
  return `Move this repo from workspace ${from} to workspace ${to}`;
}

/** The detail of a step that a flag turned off. */
export function flagSkipDetail(flag: string): string {
  return `turned off by ${flag}`;
}

/** A repo already bound to a workspace this machine has no login for: init signs in to that workspace. */
export function repoUsesWorkspace(slug: string): string {
  return `This repo uses workspace ${slug}. Signing in to it.`;
}

/** The pointer to a missing login for `--workspace <slug>`. */
export function noLoginForWorkspace(slug: string): string {
  return `No saved login for workspace ${slug}. Run: jubarteai login --workspace ${slug}`;
}

/** What `link` reports after it wrote or converted a binding. */
export function linkReport(workspace: string, email: string, form: "private" | "shared"): string {
  return `This repo is bound to workspace ${workspace} as ${email} (${form} binding).`;
}

/** What the binding was before `link` changed it. */
export function linkPrevious(workspace: string, form: "private" | "shared"): string {
  return `Before: workspace ${workspace} (${form} binding).`;
}

/** What `link` reports after a form-only conversion. */
export function linkConverted(form: "private" | "shared"): string {
  return `Switched the binding to the ${form} form.`;
}

/** The preview line of the Codex key update: which account Codex will use. */
export function codexActsAs(email: string, workspace: string): string {
  return `Codex will act as ${email} — ${workspace} on this machine`;
}

/** Lines for a Codex entry whose url is not this account's. */
export function codexForeignLines(shown: string, url: string): string[] {
  return [`${shown} has a jubarteai entry for ${url}, which is not this account's address.`, "It was left as it is. To use this account in Codex, edit its url and key there by hand."];
}

/** Lines for a Codex entry whose key is another saved login's (init leaves it: switching it moves every Codex session). */
export function codexOtherWorkspaceLines(shown: string, workspace: string): string[] {
  return [`${shown} makes Codex use your saved login for workspace ${workspace}, not this repo's.`, "It was left as it is. To use this repo's workspace in Codex, replace the key there by hand."];
}

/** What `login` prints when it revoked the key Codex's MCP entry holds and the entry was not refreshed. */
export const CODEX_REVOKED_HINT = "Codex still uses the key that was just revoked; run `jubarteai init` to update it.";

/** Lines for a Codex entry whose key init can't rewrite safely. */
export function codexUnreadableLines(shown: string): string[] {
  return [`${shown} sets the jubarteai key in a form init can't rewrite (an environment variable, or a table of its own).`, "Make sure it holds this account's key, or edit it by hand."];
}
