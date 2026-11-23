import type { Entry, MoveType } from "../../../shared/placement.ts";
import { availableMoves } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const PATHS: Record<MoveType, React.ReactNode> = {
  expand: <path d="M4 6l4 4 4-4" {...stroke} />,
  minimize: <path d="M4 10l4-4 4 4" {...stroke} />,
  "open-in-panel": (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" {...stroke} />
      <path d="M9.5 3v10" {...stroke} />
    </>
  ),
  "pop-out": (
    <>
      <path d="M9 3h4v4" {...stroke} />
      <path d="M13 3L7.5 8.5" {...stroke} />
      <path d="M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5" {...stroke} />
    </>
  ),
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" {...stroke} />,
};

export const LABELS: Record<MoveType, string> = {
  expand: "Expand",
  minimize: "Minimize",
  "open-in-panel": "Open in panel",
  "pop-out": "Pop out",
  close: "Close",
};

export function Icon({ type }: { type: MoveType }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {PATHS[type]}
    </svg>
  );
}

/** The icons of a block: the only buttons it has, as the model's table gives them per placement. */
export function BlockControls({ entry }: { entry: Entry }) {
  const ws = useWorkspace();
  return (
    <>
      {availableMoves(entry).map((type) => (
        <button
          key={type}
          type="button"
          className="icon"
          data-fill="pointer"
          aria-label={LABELS[type]}
          title={LABELS[type]}
          data-move={type}
          onClick={(e) => {
            e.stopPropagation();
            ws.move({ type, block: entry.info.address });
          }}
        >
          <Icon type={type} />
        </button>
      ))}
    </>
  );
}

export const BranchIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.6" {...stroke} />
    <circle cx="4.5" cy="12.5" r="1.6" {...stroke} />
    <circle cx="11.5" cy="7" r="1.6" {...stroke} />
    <path d="M4.5 5.1v5.8M4.5 9c0-1.4 1.4-2 3.5-2h2" {...stroke} />
  </svg>
);
