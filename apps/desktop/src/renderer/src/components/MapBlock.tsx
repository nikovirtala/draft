import { emptyMapText, problemLines } from "@nikovirtala/draft-core/map-types";
import { useEffect, useMemo, useState } from "react";
import { ageText } from "../../../shared/attention.ts";
import type { MapItem, MapRequest, MapSnapshot } from "../../../shared/ipc.ts";
import type { Entry, Placement } from "../../../shared/placement.ts";
import { useWorkspace } from "../workspace.tsx";
import { BlockControls } from "./Icons.tsx";
import { LayoutSwitch, MapGraph, type MapLayout } from "./MapGraph.tsx";
import { useSelectable } from "./selectable.ts";
import { Working } from "./Working.tsx";

/**
 * The map (docs/model.md, "The map"): one row for each kind, one column for each of its states,
 * each cell counting its items. What waits on the person is lit, and the moves of the last while
 * are arrows between the cells of a row. A cell opens its items, and an item goes to where it
 * lives. It is a block like any other: inline, in the panel or in a window, or minimized to a line.
 */

const RANGES = [
  { id: "hour", label: "Last hour", ms: 3_600_000 },
  { id: "day", label: "Last day", ms: 86_400_000 },
  { id: "all", label: "Everything", ms: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const CELL = 92;
const ARC = 26;

/** The map of this window's context, asked for again whenever the log moves. */
function useMap(range: RangeId): MapSnapshot | null {
  const ws = useWorkspace();
  const [map, setMap] = useState<MapSnapshot | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: asks again when the main process says the log moved
  useEffect(() => {
    let current = true;
    const ms = RANGES.find((r) => r.id === range)?.ms ?? null;
    const request: MapRequest =
      ms === null ? {} : { since: new Date(Date.now() - ms).toISOString() };
    void window.draft.map(request).then((m) => {
      if (current) setMap(m);
    });
    return () => {
      current = false;
    };
  }, [range, ws.mapHead]);
  return map;
}

/** Tells the main process this window has a map on screen, so the repositories it covers are read. */
function useMapVisible(): void {
  useEffect(() => {
    window.draft.setMapVisible(true);
    return () => window.draft.setMapVisible(false);
  }, []);
}

export function summaryText(map: MapSnapshot): string {
  const { open, waitingOnPerson } = map.totals;
  return `${open} open · ${waitingOnPerson} waiting on you`;
}

/** A cell's words for a screen reader: where it is, how many, and whether they wait on you. */
function cellLabel(
  rowLabel: string,
  columnLabel: string,
  count: number,
  waiting: number,
  notes: string,
): string {
  const items = count === 1 ? "1 item" : `${count} items`;
  return `${rowLabel}, ${columnLabel}: ${items}${waiting > 0 ? `, ${waiting} waiting on you` : ""}${notes === "" ? "" : `, ${notes}`}`;
}

/** What a cell says about its items besides their state: "2 done, 1 wontfix". */
const notesText = (notes: { note: string; count: number }[]): string =>
  notes.map((n) => `${n.count} ${n.note}`).join(", ");

type Row = MapSnapshot["rows"][number];

/** The moves between cells of one row in the window, counted by direction. */
function arrowsOf(map: MapSnapshot, row: Row) {
  const index = new Map(row.columns.map((c, i) => [c.id, i]));
  const counts = new Map<string, { from: number; to: number; n: number }>();
  for (const t of map.transitions) {
    if (t.kind !== row.kind || t.fromColumn === null || t.fromColumn === t.toColumn) continue;
    const from = index.get(t.fromColumn);
    const to = index.get(t.toColumn);
    if (from === undefined || to === undefined) continue;
    const key = `${from}>${to}`;
    const known = counts.get(key);
    if (known === undefined) counts.set(key, { from, to, n: 1 });
    else known.n++;
  }
  return [...counts.values()];
}

function Arrows({ map, row }: { map: MapSnapshot; row: Row }) {
  const arrows = arrowsOf(map, row);
  if (arrows.length === 0) return null;
  const width = row.columns.length * CELL;
  const id = `arrow-${row.kind.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <svg
      className="map-arrows"
      width={width}
      height={ARC}
      viewBox={`0 0 ${width} ${ARC}`}
      aria-hidden="true"
      data-testid="map-arrows"
    >
      <defs>
        <marker
          id={id}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 0L8 4L0 8z" fill="currentColor" />
        </marker>
      </defs>
      {arrows.map((a) => {
        const x1 = a.from * CELL + CELL / 2;
        const x2 = a.to * CELL + CELL / 2;
        const lift = Math.min(ARC - 4, 8 + Math.abs(a.to - a.from) * 5);
        return (
          <path
            key={`${a.from}>${a.to}`}
            d={`M${x1} ${ARC} C${x1} ${ARC - lift} ${x2} ${ARC - lift} ${x2} ${ARC - 2}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={Math.min(3, 1.2 + a.n * 0.4)}
            markerEnd={`url(#${id})`}
            data-testid="map-arrow"
            data-kind={row.kind}
            data-from={row.columns[a.from]?.id}
            data-to={row.columns[a.to]?.id}
            data-count={a.n}
          />
        );
      })}
    </svg>
  );
}

function MapRowView({
  map,
  row,
  selected,
  onSelect,
}: {
  map: MapSnapshot;
  row: Row;
  selected: string | null;
  onSelect: (column: string) => void;
}) {
  const headingId = `map-row-${row.kind.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <section
      className="map-row"
      aria-labelledby={headingId}
      data-testid="map-row"
      data-kind={row.kind}
      data-source={row.source}
    >
      <h3 id={headingId} className="map-row-title">
        {row.label}
        <span className="map-row-total" data-testid="map-row-total">
          {row.total}
        </span>
        {row.stale !== null && (
          <span className="map-stale" title={row.stale} data-testid="map-stale">
            from before
          </span>
        )}
        {row.source === "derived" && (
          <span className="map-derived" title={row.derivation}>
            states derived
          </span>
        )}
      </h3>
      <div className="map-row-scroll">
        <div className="map-row-grid" style={{ width: row.columns.length * CELL }}>
          <Arrows map={map} row={row} />
          <div className="map-cells">
            {row.cells.map((cell) => {
              const column = row.columns.find((c) => c.id === cell.column);
              if (column === undefined) return null;
              const lit = cell.waitingOnPerson > 0;
              return (
                <button
                  key={cell.column}
                  type="button"
                  className={`map-cell ${column.class}${lit ? " lit" : ""}${selected === cell.column ? " selected" : ""}`}
                  style={{ width: CELL }}
                  disabled={cell.count === 0}
                  aria-pressed={selected === cell.column}
                  aria-label={cellLabel(
                    row.label,
                    column.label,
                    cell.count,
                    cell.waitingOnPerson,
                    notesText(cell.notes),
                  )}
                  title={notesText(cell.notes) || undefined}
                  data-testid="map-cell"
                  data-kind={row.kind}
                  data-column={cell.column}
                  data-count={cell.count}
                  data-waiting={cell.waitingOnPerson}
                  onClick={() => onSelect(cell.column)}
                >
                  <span className="map-cell-label">{column.label}</span>
                  <span className="map-cell-count">{cell.count}</span>
                  <span className="map-cell-wait" data-testid="map-cell-note">
                    {lit ? `${cell.waitingOnPerson} for you` : notesText(cell.notes) || "\u00a0"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

const WHERE: Record<string, string> = {
  conversation: "its conversation",
  stub: "its stub",
  links: "on GitHub",
};

function ItemList({
  map,
  kind,
  column,
  onClose,
}: {
  map: MapSnapshot;
  kind: string;
  column: string;
  onClose: () => void;
}) {
  const ws = useWorkspace();
  const row = map.rows.find((r) => r.kind === kind);
  const col = row?.columns.find((c) => c.id === column);
  const items: MapItem[] = row?.cells.find((c) => c.column === column)?.items ?? [];
  const [opened, setOpened] = useState<string | null>(null);
  if (row === undefined || col === undefined) return null;
  return (
    <section
      className="map-items"
      aria-label={`${row.label}: ${col.label}`}
      data-testid="map-items"
      data-kind={kind}
      data-column={column}
    >
      <header className="map-items-head">
        <h3>
          {row.label} · {col.label}
        </h3>
        <button type="button" className="secondary-button small" onClick={onClose}>
          Close list
        </button>
      </header>
      {items.length === 0 ? (
        <p className="secondary" data-testid="map-items-empty">
          Nothing is in this state now.
        </p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.open.kind === "links" ? (
                <div
                  className={`map-item${item.waitsOn === "user" ? " lit" : ""}`}
                  data-testid="map-item"
                  data-item={item.id}
                >
                  <span className="map-item-label">{item.label}</span>
                  <span className="map-item-since">{ageText(item.since)}</span>
                  <span className="map-item-links">
                    {item.open.links.map((l) => (
                      <a
                        key={l.url}
                        href={l.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="map-item-link"
                      >
                        {l.label}
                      </a>
                    ))}
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className={`map-item${item.waitsOn === "user" ? " lit" : ""}`}
                  data-testid="map-item"
                  data-item={item.id}
                  aria-label={`${item.label}, ${item.stateLabel} since ${ageText(item.since)}. Opens ${WHERE[item.open.kind]}.`}
                  onClick={() => {
                    setOpened(item.id);
                    void ws.open(item.open);
                  }}
                >
                  <span className="map-item-label">{item.label}</span>
                  <span className="map-item-since">{ageText(item.since)}</span>
                  <span className="map-item-where">
                    {opened === item.id ? "Opened" : `Opens ${WHERE[item.open.kind]}`}
                  </span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Moves({ map }: { map: MapSnapshot }) {
  const labels = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of map.rows) for (const c of r.columns) out.set(`${r.kind}/${c.id}`, c.label);
    return out;
  }, [map]);
  const rows = new Map(map.rows.map((r) => [r.kind, r.label]));
  const moves = map.transitions
    .filter((t) => t.fromColumn !== null && t.fromColumn !== t.toColumn)
    .slice(-8)
    .reverse();
  if (moves.length === 0) return null;
  return (
    <section className="map-moves" aria-label="Recent moves" data-testid="map-moves">
      <h3>Recent moves</h3>
      <ul>
        {moves.map((t) => (
          <li key={`${t.kind}/${t.item}/${t.seq}`} data-testid="map-move">
            <span className="map-move-label">{t.label}</span>{" "}
            <span className="secondary">
              {rows.get(t.kind)}: {labels.get(`${t.kind}/${t.fromColumn}`)} →{" "}
              {labels.get(`${t.kind}/${t.toColumn}`)}, {new Date(t.at).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The grid itself, with its range, its rows, the opened cell and the recent moves. */
export function MapView({ address }: { address: string }) {
  const ws = useWorkspace();
  const [range, setRange] = useState<RangeId>("hour");
  const [layout, setLayout] = useState<MapLayout>("graph");
  useMapVisible();
  const map = useMap(range);
  // The grid's open cell belongs to the grid: the graph has none.
  const cell = layout === "state" ? ws.mapCell(address) : null;
  if (map === null) return <p className="secondary">Reading the log…</p>;
  const empty = map.totals.items === 0;
  return (
    <div
      className="map"
      data-testid="map"
      data-items={map.totals.items}
      data-position={map.position}
    >
      <div className="map-bar">
        <p className="map-summary" data-testid="map-summary" aria-live="polite">
          {summaryText(map)}
        </p>
        <Working active={map.reading} label="Reading GitHub" place="map" />
        <fieldset className="map-range" aria-label="Moves shown">
          {RANGES.map((r) => (
            <label key={r.id} className={range === r.id ? "on" : ""}>
              <input
                type="radio"
                name={`range-${address}`}
                checked={range === r.id}
                onChange={() => setRange(r.id)}
              />
              {r.label}
            </label>
          ))}
        </fieldset>
        <LayoutSwitch name={`layout-${address}`} value={layout} onChange={setLayout} />
      </div>
      {empty && (
        <p className="empty-map" data-testid="map-empty">
          {emptyMapText(map.kinds)}
        </p>
      )}
      {layout === "graph" && <MapGraph map={map} />}
      {(layout === "state" ? map.rows : []).map((row) => (
        <MapRowView
          key={row.kind}
          map={map}
          row={row}
          selected={cell?.kind === row.kind ? cell.column : null}
          onSelect={(column) =>
            ws.selectMapCell(
              address,
              cell?.kind === row.kind && cell.column === column ? null : { kind: row.kind, column },
            )
          }
        />
      ))}
      {cell !== null && (
        <ItemList
          map={map}
          kind={cell.kind}
          column={cell.column}
          onClose={() => ws.selectMapCell(address, null)}
        />
      )}
      <Moves map={map} />
      {map.problems.length > 0 && (
        <p className="secondary" data-testid="map-problems">
          {problemLines(map.problems).join(" · ")}
        </p>
      )}
    </div>
  );
}

const WHERE_BLOCK: Record<string, string> = { panel: "In the panel", window: "In a window" };

/** The address of the map block that one message asked for. */
export const mapAddress = (message: string): string => `${message}#map`;

/**
 * The map where it was asked for: inline it is the grid, minimized one live line, and moved to
 * the panel or a window it leaves a stub that says where it went.
 */
export function MapStub({ message, conversation }: { message: string; conversation: string }) {
  const ws = useWorkspace();
  const address = mapAddress(message);
  const entry = ws.entry(address);
  const depth = ws.depthOf(conversation);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a block is registered once, when it is first seen
  useEffect(
    () =>
      ws.register({
        info: { address, kind: "map", home: conversation, depth, opens: null, title: "The map" },
        initial: "inline",
      }),
    [address],
  );
  const placement: Placement = entry?.placement ?? "inline";
  const away = placement === "panel" || placement === "window";
  const selectable = useSelectable(address, conversation);
  return (
    <section
      {...selectable}
      className={`stub map-stub ${away ? "away" : placement}`}
      data-testid="map-block"
      data-block={address}
      data-placement={placement}
      aria-label="The map"
    >
      <div className="stub-line">
        <span className="stub-title">The map</span>
        {placement === "minimized" && <MapLine />}
        <span className="spacer" />
        {away ? (
          <span className="where" data-testid="stub-where">
            {WHERE_BLOCK[placement]}
          </span>
        ) : (
          entry !== undefined && <BlockControls entry={entry} />
        )}
      </div>
      {placement === "inline" && <MapView address={address} />}
    </section>
  );
}

/** The map minimized to one live line. */
function MapLine() {
  const map = useMap("hour");
  return (
    <span className="stub-status" data-testid="map-line" aria-live="polite">
      {map === null ? "…" : summaryText(map)}
      <Working active={map?.reading === true} label="Reading GitHub" place="map" />
    </span>
  );
}

/** The map in full, in the panel or a window. */
export function MapBlockFull({ entry }: { entry: Entry }) {
  const selectable = useSelectable(entry.info.address, entry.info.home);
  return (
    <section
      {...selectable}
      className="block-full map-full"
      data-testid="block-full"
      data-kind="map"
      data-block={entry.info.address}
      aria-label="The map"
    >
      <header className="block-header">
        <div className="stub-line">
          <span className="stub-title">The map</span>
          <span className="spacer" />
          <BlockControls entry={entry} />
        </div>
      </header>
      <MapView address={entry.info.address} />
    </section>
  );
}
