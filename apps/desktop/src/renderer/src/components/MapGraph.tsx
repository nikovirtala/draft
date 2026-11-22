import {
  type ClusterNode,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type GraphZoom,
  type ItemNode,
  projectGraph,
  relLabel,
  zoomKey,
  zoomOut,
} from "@nikovirtala/draft-core/map-graph";
import {
  type Layout,
  laneCenter,
  layoutGraph,
  type Point,
  radiusOf,
  tetherOf,
  WORLD,
} from "@nikovirtala/draft-core/map-layout";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ageText } from "../../../shared/attention.ts";
import type { MapSnapshot } from "../../../shared/ipc.ts";
import { useWorkspace } from "../workspace.tsx";

/**
 * The map as a graph (docs/model.md, "The map"): a context's kinds as circles sized by their count,
 * a ring for the share that has settled, the count inside and the name under it; edges as wide as
 * the references they carry; what moved in the window or waits on you stepped out as a small node
 * on a dotted tether. Clicking a cluster opens its kind, clicking an item shows its neighbourhood,
 * and the crumbs, or Escape, go back out.
 *
 * What is drawn comes from `projectGraph` (a pure function of the snapshot and a zoom, which is
 * plain data) and `layoutGraph` (positions that stay put). This file only draws them: the nodes
 * are buttons laid over the SVG, so they take focus, have names and work from the keyboard.
 */

export type MapLayout = "graph" | "state";

/** The switch between the graph and the grid of the same nodes, beside the lenses. */
export function LayoutSwitch({
  name,
  value,
  onChange,
}: {
  name: string;
  value: MapLayout;
  onChange: (layout: MapLayout) => void;
}) {
  const options: { id: MapLayout; label: string }[] = [
    { id: "graph", label: "Graph" },
    { id: "state", label: "By state" },
  ];
  return (
    <fieldset className="map-range map-layout" aria-label="Layout" data-testid="map-layout">
      {options.map((o) => (
        <label key={o.id} className={value === o.id ? "on" : ""}>
          <input
            type="radio"
            name={name}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            data-testid={`map-layout-${o.id}`}
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

/** Positions that stay put: the layout before is the start of the next, per zoom. */
function useLayout(graph: Graph): Layout {
  const kept = useRef(new Map<string, Layout>());
  const key = zoomKey(graph.zoom);
  const layout = useMemo(() => layoutGraph(graph, kept.current.get(key) ?? null), [graph, key]);
  useEffect(() => {
    kept.current.set(key, layout);
  }, [key, layout]);
  return layout;
}

const pct = (v: number, of: number): string => `${(v / of) * 100}%`;

/** How wide an edge is for the references it carries. */
export const edgeWidth = (count: number): number => Math.min(12, 1 + 1.6 * count);

function edgePath(p: Point, q: Point, rp: number, rq: number): string {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const a = { x: p.x + ux * (rp + 2), y: p.y + uy * (rp + 2) };
  const b = { x: q.x - ux * (rq + 5), y: q.y - uy * (rq + 5) };
  // A little off the straight line, to the same side of its direction, so two ways don't overlap.
  const bend = Math.min(30, len * 0.12);
  const c = { x: (a.x + b.x) / 2 - uy * bend, y: (a.y + b.y) / 2 + ux * bend };
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

const relsText = (e: GraphEdge): string =>
  e.rels.map((r) => `${relLabel(r.rel)} ${r.count}`).join(", ");

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function clusterLabel(c: ClusterNode): string {
  const parts = [
    `${c.label}: ${plural(c.count, "item")}`,
    `${c.settled} settled`,
    ...(c.waitingOnPerson > 0 ? [`${c.waitingOnPerson} waiting on you`] : []),
    ...(c.steppedOut > 0 ? [`${c.steppedOut} shown apart`] : []),
  ];
  return `${parts.join(", ")}.${c.zoom === null ? "" : c.external ? " Goes to this kind." : " Opens its items."}`;
}

function itemLabel(i: ItemNode): string {
  const flags = [
    ...(i.moved ? ["moved"] : []),
    ...(i.waiting ? ["waiting on you"] : []),
    ...(i.openLoop ? ["open loop"] : []),
  ];
  return `${i.label}, ${i.kindLabel}, ${i.stateLabel} since ${ageText(i.since)}${flags.length === 0 ? "" : `, ${flags.join(", ")}`}.${i.focus ? " In focus." : " Shows its neighbourhood."}`;
}

/** The disc and ring of a cluster, and the circle of an item, in the world's own units. */
function Shapes({ graph, layout, arrow }: { graph: Graph; layout: Layout; arrow: string }) {
  const at = (n: GraphNode): Point => layout[n.id] ?? { x: 0, y: 0 };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <svg
      className="graph-svg"
      viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
      aria-hidden="true"
      data-testid="graph-svg"
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path className="graph-arrowhead" d="M0 0L8 4L0 8z" />
        </marker>
      </defs>
      {graph.nodes.map((n) => {
        const c = tetherOf(graph, n);
        if (c === null) return null;
        const p = at(n);
        const q = at(c);
        return (
          <line
            key={`tether:${n.id}`}
            className="graph-tether"
            x1={p.x}
            y1={p.y}
            x2={q.x}
            y2={q.y}
          />
        );
      })}
      {graph.edges.map((e) => {
        const from = byId.get(e.from);
        const to = byId.get(e.to);
        if (from === undefined || to === undefined) return null;
        return (
          <path
            key={e.id}
            className={`graph-edge${e.cascade ? " cascade" : ""}`}
            d={edgePath(at(from), at(to), radiusOf(from), radiusOf(to))}
            strokeWidth={edgeWidth(e.count)}
            markerEnd={e.cascade ? `url(#${arrow})` : undefined}
            data-testid="graph-edge"
            data-from={e.from}
            data-to={e.to}
            data-count={e.count}
            data-cascade={e.cascade}
          >
            <title>{`${plural(e.count, "reference")}: ${relsText(e)}`}</title>
          </path>
        );
      })}
      {graph.nodes.map((n) => {
        const p = at(n);
        const r = radiusOf(n);
        if (n.type === "cluster") {
          const ring = r + 5;
          const length = 2 * Math.PI * ring;
          return (
            <g key={n.id} className="graph-cluster-shape" transform={`translate(${p.x} ${p.y})`}>
              <circle
                className={`graph-disc${n.waitingOnPerson > 0 ? " waiting" : ""}${n.external ? " external" : ""}`}
                r={r}
              />
              <circle className="graph-ring-track" r={ring} />
              <circle
                className="graph-ring"
                r={ring}
                strokeDasharray={`${(n.share * length).toFixed(2)} ${length.toFixed(2)}`}
                transform="rotate(-90)"
              />
            </g>
          );
        }
        return (
          <g key={n.id} transform={`translate(${p.x} ${p.y})`}>
            <circle
              className={`graph-dot${n.moved ? " moved" : ""}${n.waiting ? " waiting" : ""}${n.class === "terminal" ? " settled" : ""}${n.focus ? " focus" : ""}`}
              r={r}
            />
            {n.openLoop && <circle className="graph-loop" r={r + 4} />}
          </g>
        );
      })}
    </svg>
  );
}

function NodeButton({
  node,
  layout,
  named,
  onZoom,
}: {
  node: GraphNode;
  layout: Layout;
  named: boolean;
  onZoom: (zoom: GraphZoom) => void;
}) {
  const p = layout[node.id] ?? { x: 0, y: 0 };
  const r = radiusOf(node);
  const style = {
    left: pct(p.x, WORLD.width),
    top: pct(p.y, WORLD.height),
    width: pct(2 * r, WORLD.width),
  };
  if (node.type === "cluster") {
    return (
      <button
        type="button"
        className={`graph-node cluster${node.waitingOnPerson > 0 ? " waiting" : ""}`}
        style={style}
        disabled={node.zoom === null}
        aria-label={clusterLabel(node)}
        data-testid="graph-cluster"
        data-kind={node.kind}
        data-state={node.state ?? ""}
        data-count={node.count}
        data-settled={node.settled}
        data-stepped-out={node.steppedOut}
        data-external={node.external}
        onClick={() => node.zoom !== null && onZoom(node.zoom)}
      >
        <span className="graph-count" aria-hidden="true">
          {node.count}
        </span>
        <span className="graph-name" aria-hidden="true">
          {node.label}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`graph-node item${node.moved ? " moved" : ""}${node.waiting ? " waiting" : ""}${node.openLoop ? " loop" : ""}${node.focus ? " focus" : ""}`}
      style={style}
      aria-label={itemLabel(node)}
      aria-current={node.focus ? "true" : undefined}
      title={node.label}
      data-testid="graph-item"
      data-kind={node.kind}
      data-item={node.item}
      data-moved={node.moved}
      data-waiting={node.waiting}
      data-open-loop={node.openLoop}
      data-tethered={node.tether !== null}
      onClick={() => onZoom(node.zoom)}
    >
      {named && (
        <span className="graph-name" aria-hidden="true">
          {node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label}
        </span>
      )}
    </button>
  );
}

const WHERE: Record<string, string> = {
  conversation: "its conversation",
  stub: "its stub",
  links: "on GitHub",
};

/** The edges in words, for those who read the graph without seeing it. */
function Refs({ graph }: { graph: Graph }) {
  if (graph.edges.length === 0) return null;
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return (
    <ul className="graph-refs" aria-label="References" data-testid="graph-refs">
      {graph.edges.map((e) => (
        <li key={e.id}>
          {labels.get(e.from)}{" "}
          <span className="secondary">{e.rels.map((r) => relLabel(r.rel)).join(", ")}</span>{" "}
          {labels.get(e.to)}
          {e.count > 1 && <span className="secondary"> ({plural(e.count, "reference")})</span>}
        </li>
      ))}
    </ul>
  );
}

/** The item in focus, where it lives, and its references in words. */
function Focus({ graph }: { graph: Graph }) {
  const ws = useWorkspace();
  const focus = graph.nodes.find((n): n is ItemNode => n.type === "item" && n.focus);
  if (focus === undefined) return null;
  return (
    <section className="graph-focus" aria-label="The item in focus" data-testid="graph-focus">
      <h4>{focus.label}</h4>
      <p className="secondary graph-focus-line">
        {focus.kindLabel} · {focus.stateLabel} since {ageText(focus.since)}
        {focus.note === null ? "" : ` · ${focus.note}`}
      </p>
      {focus.open.kind === "links" ? (
        <p className="graph-focus-links graph-focus-line">
          {focus.open.links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          ))}
        </p>
      ) : (
        <button
          type="button"
          className="secondary-button small"
          data-testid="graph-open"
          onClick={() => void ws.open(focus.open)}
        >
          Open {WHERE[focus.open.kind]}
        </button>
      )}
      <Refs graph={graph} />
      {graph.hidden > 0 && (
        <p className="secondary graph-focus-line">
          {plural(graph.hidden, "more reference")} not drawn.
        </p>
      )}
    </section>
  );
}

/** What the colours and shapes mean, in words, so no meaning rests on colour alone. */
function Legend() {
  return (
    <ul className="graph-legend" aria-label="Legend" data-testid="graph-legend">
      <li>
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot moved" r="6" />
        </svg>
        Moved: changed state in the window shown
      </li>
      <li>
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot waiting" r="6" />
        </svg>
        Waiting: needs you
      </li>
      <li>
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot" r="4.5" />
          <circle className="graph-loop" r="8" />
        </svg>
        Open loop: something settled leads to it and it is not settled
      </li>
      <li>
        <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden="true">
          <path className="graph-edge cascade" d="M2 9H22" strokeWidth="2" />
          <path className="graph-arrowhead" d="M21 5L27 9L21 13z" />
        </svg>
        Cascade: a reference between items that moved
      </li>
      <li>
        <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden="true">
          <path className="graph-edge" d="M2 5H26" strokeWidth={edgeWidth(1)} />
          <path className="graph-edge" d="M2 13H26" strokeWidth={edgeWidth(4)} />
        </svg>
        Edge width: the references it carries, one against four
      </li>
      <li>
        <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-ring-track" r="6" />
          <circle className="graph-ring" r="6" strokeDasharray="25 38" transform="rotate(-90)" />
        </svg>
        Ring: the share that has settled
      </li>
    </ul>
  );
}

function headingOf(graph: Graph): string {
  if (graph.zoom.level === "context") {
    const kinds = graph.nodes.filter((n) => n.type === "cluster").length;
    return `Context: ${plural(kinds, "kind")}, ${plural(graph.totals.items, "item")}`;
  }
  const last = graph.crumbs.at(-1);
  return last?.label ?? "";
}

/** The graph of the map, at the zoom it is at. */
export function MapGraph({ map }: { map: MapSnapshot }) {
  const arrow = `graph-arrow-${useId().replace(/:/g, "")}`;
  const [asked, setZoom] = useState<GraphZoom>({ level: "context" });
  const graph = useMemo(() => projectGraph(map, asked), [map, asked]);
  const layout = useLayout(graph);
  const heading = useRef<HTMLHeadingElement>(null);
  const key = zoomKey(graph.zoom);
  const first = useRef(true);
  // After zooming, the button that was clicked may be gone: keyboard focus goes to the heading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: moves focus when the zoom changes
  useEffect(() => {
    if (first.current) first.current = false;
    else heading.current?.focus();
  }, [key]);
  if (graph.nodes.length === 0) return null;
  const named = graph.zoom.level === "item" || graph.nodes.length <= 14;
  return (
    <section
      className="map-graph"
      aria-label="The map as a graph"
      data-testid="map-graph"
      data-zoom={key}
      data-nodes={graph.nodes.length}
      onKeyDown={(e) => {
        if (e.key === "Escape" && graph.zoom.level !== "context") {
          e.stopPropagation();
          setZoom(zoomOut(graph.zoom));
        }
      }}
    >
      <nav aria-label="Zoom" className="graph-crumbs" data-testid="graph-crumbs">
        <ol>
          {graph.crumbs.map((c, i) => {
            const here = i === graph.crumbs.length - 1;
            return (
              <li key={zoomKey(c.zoom)}>
                {here ? (
                  <span aria-current="location">{c.label}</span>
                ) : (
                  <button
                    type="button"
                    className="link-button"
                    data-testid="graph-crumb"
                    onClick={() => setZoom(c.zoom)}
                  >
                    {c.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        <span className="secondary graph-hint">Escape zooms out</span>
      </nav>
      <h3 className="graph-heading" tabIndex={-1} ref={heading} data-testid="graph-heading">
        {headingOf(graph)}
      </h3>
      <div
        className="graph-stage"
        style={{ aspectRatio: `${WORLD.width} / ${WORLD.height}` }}
        data-testid="graph-stage"
      >
        <Shapes graph={graph} layout={layout} arrow={arrow} />
        {graph.zoom.level === "kind" &&
          graph.lanes.map((l) => (
            <span
              key={l.id}
              className={`graph-lane ${l.class}`}
              style={{ left: pct(laneCenter(graph, l.id), WORLD.width) }}
              aria-hidden="true"
            >
              {l.label}
            </span>
          ))}
        {graph.nodes.map((n) => (
          <NodeButton key={n.id} node={n} layout={layout} named={named} onZoom={setZoom} />
        ))}
      </div>
      {graph.zoom.level === "kind" && graph.hidden > 0 && (
        <p className="secondary" data-testid="graph-hidden">
          {plural(graph.hidden, "item")} too many to draw one by one: each state shows its count,
          and what moved or waits on you stands apart.
        </p>
      )}
      <Focus graph={graph} />
      {graph.zoom.level !== "item" && graph.edges.length > 0 && (
        <details className="graph-words">
          <summary>References in words ({graph.edges.length})</summary>
          <Refs graph={graph} />
        </details>
      )}
      <Legend />
    </section>
  );
}
