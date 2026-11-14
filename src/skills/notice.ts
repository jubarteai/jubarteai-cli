// Fixed copy the sync leaves for the agent (injected by the next hook) and prints for a person.
const list = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(", ");

export function syncedNotice(added: number, updated: number, removed: number): string {
  return `Company skills synced: ${added} added, ${updated} updated, ${removed} removed.`;
}

export function clashNotice(name: string, dir: string): string {
  return `Company skill \`${name}\` was not synced: ${dir}/${name} already exists and isn't managed by JubarteAI (jubarteai skills status).`;
}

/** A target the sync left alone because the folder (or a parent) is a symlink. */
export function skippedTargetsNotice(skipped: readonly string[]): string {
  return `${skipped.join(", ")} ${skipped.length === 1 ? "is a symlink" : "are symlinks"}, so company skills are not synced there. Replace the link with a real folder to sync them.`;
}

export const NEW_FOLDER_NOTICE = "New company skills folder created — start a new session (or /reload-skills in Claude Code) to load them.";

export function changedList(names: readonly string[]): string {
  return list(names);
}
