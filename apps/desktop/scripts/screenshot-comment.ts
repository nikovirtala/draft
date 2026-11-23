import { previewFile, type State } from "./screenshot-states.ts";

/** The comment is found by this line, which GitHub does not show. */
export const MARKER = "<!-- draft-e2e-screenshots -->";

export interface CommentInput {
  states: readonly State[];
  /** `owner/repo`. */
  repository: string;
  /** The commit of ci/screenshots the images are read from, never a branch name. */
  imagesCommit: string;
  /** Where in that commit the files are: `<pull request>/<head sha>`. */
  imagesDir: string;
  /** The pull request's head sha, which the previews are linked at. */
  headSha: string;
  /** The files that exist, by name: screenshots, and rendered previews. */
  screenshots: ReadonlySet<string>;
  previews: ReadonlySet<string>;
  runUrl: string;
}

/** An image a person can read in the table, whatever its size. */
const image = (url: string, alt: string, width: number): string =>
  `<img src="${url}" alt="${alt.replace(/"/g, "&quot;")}" width="${width}">`;

/** The comment: one row for each named state, the end-to-end screenshot beside the design. */
export function commentBody(c: CommentInput): string {
  const raw = (file: string) =>
    `https://github.com/${c.repository}/raw/${c.imagesCommit}/${c.imagesDir}/${file}`;
  const rows = c.states.map((s) => {
    const shot = c.screenshots.has(s.screenshot)
      ? image(raw(s.screenshot), `${s.state}, as the app draws it`, 440)
      : "not taken in this run";
    let design = "no design preview";
    if (s.preview !== null) {
      const link = `[${s.preview.split("/").at(-2)}](https://github.com/${c.repository}/blob/${c.headSha}/${s.preview})`;
      design = c.previews.has(previewFile(s))
        ? `${image(raw(previewFile(s)), `${s.state}, as the design draws it`, 440)}<br>${link}`
        : `${link} (not rendered in this run)`;
    }
    return `| ${s.state} | ${shot} | ${design} |`;
  });
  return [
    MARKER,
    `### Screenshots of \`${c.headSha.slice(0, 7)}\`, beside the design`,
    "",
    `Taken by the end-to-end job ([run](${c.runUrl})); the design is each state's preview in \`docs/design-system/components\`. The list of states is \`apps/desktop/e2e/states.json\`.`,
    "",
    "| State | The app | The design |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
