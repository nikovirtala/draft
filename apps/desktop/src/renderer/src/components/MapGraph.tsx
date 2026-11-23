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
import { type LabelBox, type Labels, layoutLabels } from "@nikovirtala/draft-core/map-labels";
import {
  type Layout,
  laneCenter,
  layoutGraph,
  type Point,
  radiusOf,
  tetherOf,
  WORLD,
} from "@nikovirtala/draft-core/map-layout";
import {
  applyInput,
  boundsOf,
  fitGraph,
  keyInput,
  sameViewport,
  type Viewport,
  type ViewportInput,
  wheelInput,
  ZOOM_STEP,
} from "@nikovirtala/draft-core/map-viewport";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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

/**
 * Where the names are: boxes kept clear of every node and every other name, and kept where they
 * were while they stay clear. `scale` is how many screen pixels a world unit is, so a name is as
 * big in the layout as it is on the screen; it is rounded so a pixel of resizing moves nothing.
 */
function useLabels(graph: Graph, layout: Layout, named: boolean, scale: number): Labels {
  const kept = useRef(new Map<string, Labels>());
  const key = zoomKey(graph.zoom);
  const labels = useMemo(
    () => layoutLabels(graph, layout, kept.current.get(key) ?? null, { named, scale }),
    [graph, layout, key, named, scale],
  );
  useEffect(() => {
    kept.current.set(key, labels);
  }, [key, labels]);
  return labels;
}

const pct = (v: number, of: number): string => `${(v / of) * 100}%`;

/**
 * Where the graph is looked at from: a transform kept apart from the layout, so nothing here can
 * move a node. Until the person moves it, the view follows the fit of the graph (so a map that
 * fills in as it is read is framed as it grows); a move takes it over, and "Fit" gives it back.
 * A change of semantic zoom (context, kind, item) fits the new level.
 */
function useViewport(graph: Graph, layout: Layout, labels: Labels) {
  const key = zoomKey(graph.zoom);
  const fit = useMemo(() => fitGraph(graph, layout, labels), [graph, layout, labels]);
  const bounds = useMemo(() => boundsOf(graph, layout, labels), [graph, layout, labels]);
  const [own, setOwn] = useState<{ key: string; view: Viewport | null }>({ key, view: null });
  const taken = own.key === key ? own.view : null;
  if (own.key !== key) setOwn({ key, view: null });
  const view = taken ?? fit;
  const latest = useRef({ view, fit, bounds, taken: taken !== null, key });
  latest.current = { view, fit, bounds, taken: taken !== null, key };
  const move = useCallback((input: ViewportInput) => {
    const now = latest.current;
    if (input.type === "fit") {
      setOwn({ key: now.key, view: null });
      return;
    }
    const next = applyInput(now.view, input, { bounds: now.bounds, fit: now.fit });
    latest.current = { ...now, view: next, taken: true };
    setOwn({ key: now.key, view: next });
  }, []);
  return { view, taken: taken !== null && !sameViewport(view, fit), move, latest };
}

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
        <marker
          id={`${arrow}-waits`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path className="graph-arrowhead waits" d="M0 0L8 4L0 8z" />
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
        // A wait is in the waiting colours, with an arrow to what is waited for.
        const waits = e.rels.some((r) => r.rel === "waits-for");
        return (
          <path
            key={e.id}
            className={`graph-edge${e.cascade ? " cascade" : ""}${waits ? " waits" : ""}`}
            d={edgePath(at(from), at(to), radiusOf(from), radiusOf(to))}
            strokeWidth={edgeWidth(e.count)}
            markerEnd={waits ? `url(#${arrow}-waits)` : e.cascade ? `url(#${arrow})` : undefined}
            data-testid="graph-edge"
            data-from={e.from}
            data-to={e.to}
            data-count={e.count}
            data-cascade={e.cascade}
            data-waits={waits}
          >
            <title>{`${plural(e.count, "reference")}: ${relsText(e)}`}</title>
          </path>
        );
      })}
      {graph.nodes.map((n) => {
        const p = at(n);
        const r = radiusOf(n);
        if (n.type === "cluster") {
          const ring = r;
          const length = 2 * Math.PI * ring;
          return (
            <g key={n.id} className="graph-cluster-shape" transform={`translate(${p.x} ${p.y})`}>
              <circle
                className={`graph-disc${n.waitingOnPerson > 0 ? " waiting" : ""}${n.external ? " external" : ""}`}
                r={r}
              />
              {n.share > 0 && (
                <circle
                  className="graph-ring"
                  r={ring}
                  strokeDasharray={`${(n.share * length).toFixed(2)} ${length.toFixed(2)}`}
                  transform="rotate(-90)"
                />
              )}
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

/** A name, set where the layout put it: a box beside its node, which never overlaps another. */
function NodeName({ label, at, r }: { label: LabelBox; at: Point; r: number }) {
  const w = 2 * r;
  return (
    <span
      className="graph-name"
      aria-hidden="true"
      data-testid="graph-name"
      data-side={label.side}
      data-setting={label.setting}
      style={{
        left: `${50 + ((label.x - at.x) / w) * 100}%`,
        top: `${50 + ((label.y - at.y) / w) * 100}%`,
        transform: "translate(-50%, -50%)",
        maxWidth: "none",
        whiteSpace: "pre",
      }}
    >
      {label.lines.join("\n")}
    </span>
  );
}

function NodeButton({
  node,
  layout,
  label,
  onZoom,
}: {
  node: GraphNode;
  layout: Layout;
  label: LabelBox | null;
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
        title={node.label}
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
        {label !== null && <NodeName label={label} at={p} r={r} />}
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
      {label !== null && <NodeName label={label} at={p} r={r} />}
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
      <li className="moved">
        <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot moved" r="6" />
        </svg>
        Moved: changed state in the window shown
      </li>
      <li className="waiting">
        <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot waiting" r="6" />
        </svg>
        Waiting: needs you
      </li>
      <li className="done">
        <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-dot settled" r="6" />
        </svg>
        Settled: done
      </li>
      <li className="loop">
        <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-loop" r="7" />
        </svg>
        Open loop: something settled leads to it and it is not settled
      </li>
      <li className="moved">
        <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
          <path className="graph-edge cascade" d="M2 7H22" />
          <path className="graph-arrowhead" d="M21 3L27 7L21 11z" />
        </svg>
        Cascade: a reference between items that moved
      </li>
      <li className="waiting">
        <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
          <path className="graph-edge waits" d="M2 7H22" />
          <path className="graph-arrowhead waits" d="M21 3L27 7L21 11z" />
        </svg>
        Wait: a session waits for a pull request
      </li>
      <li className="done">
        <svg width="14" height="14" viewBox="-9 -9 18 18" aria-hidden="true">
          <circle className="graph-ring" r="6" strokeDasharray="25 38" transform="rotate(-90)" />
        </svg>
        Ring: the share that has settled
      </li>
      <li className="idle">
        <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
          <path className="graph-edge" d="M2 4H26" strokeWidth={edgeWidth(1)} />
          <path className="graph-edge" d="M2 10H26" strokeWidth={edgeWidth(4)} />
        </svg>
        Edge width: the references it carries, one against four
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

type Nav = ReturnType<typeof useViewport>;

/** Zoom out, zoom in and fit, with the scale; every one is also a key (see `Stage`). */
function ViewTools({ nav }: { nav: Nav }) {
  return (
    <div className="graph-tools" role="toolbar" aria-label="View" data-testid="graph-tools">
      <button
        type="button"
        className="secondary-button small"
        aria-label="Zoom out"
        title="Zoom out (Cmd and −)"
        data-testid="graph-zoom-out"
        onClick={() => nav.move({ type: "zoom", factor: 1 / ZOOM_STEP })}
      >
        −
      </button>
      <output className="graph-scale secondary" data-testid="graph-scale" aria-label="Scale">
        {Math.round(nav.view.k * 100)}%
      </output>
      <button
        type="button"
        className="secondary-button small"
        aria-label="Zoom in"
        title="Zoom in (Cmd and +)"
        data-testid="graph-zoom-in"
        onClick={() => nav.move({ type: "zoom", factor: ZOOM_STEP })}
      >
        +
      </button>
      <button
        type="button"
        className="secondary-button small"
        title="Fit the graph to the panel (Cmd and 0)"
        data-testid="graph-fit"
        onClick={() => nav.move({ type: "fit" })}
      >
        Fit
      </button>
    </div>
  );
}

/**
 * The panel the graph is drawn in, and every way of moving around it. Keys (with the stage or a
 * node in focus): Cmd and + or − zoom, Cmd and 0 fits, the arrow keys pan. A pinch zooms about the
 * pointer and a two-finger scroll pans, once the view has been moved (until then a scroll scrolls
 * the page, as it does anywhere else). Dragging while Space is held pans too. Each of these moves
 * the viewport only.
 */
function Stage({
  graph,
  layout,
  arrow,
  labels,
  onZoom,
  onScale,
  nav,
}: {
  graph: Graph;
  layout: Layout;
  arrow: string;
  labels: Labels;
  onZoom: (zoom: GraphZoom) => void;
  onScale: (scale: number) => void;
  nav: Nav;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const swallow = useRef(false);
  const { move, latest } = nav;

  /** How big a screen pixel is in world units, and where a pointer is in them. */
  const measure = useCallback((clientX: number, clientY: number) => {
    const r = (stage.current as HTMLDivElement).getBoundingClientRect();
    const pixel = r.width === 0 ? 1 : WORLD.width / r.width;
    return { pixel, at: { x: (clientX - r.left) * pixel, y: (clientY - r.top) * pixel } };
  }, []);

  // A wheel must be able to cancel the page's own scroll and zoom, which a React handler can't.
  useEffect(() => {
    const el = stage.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent) => {
      // A pinch is always the graph's; a scroll is, once the person has moved the view.
      if (!e.ctrlKey && !latest.current.taken) return;
      e.preventDefault();
      const { pixel, at } = measure(e.clientX, e.clientY);
      move(wheelInput(e, at, pixel));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [latest, measure, move]);

  // How big a screen pixel is, so a name is laid out at the size it is drawn.
  useEffect(() => {
    const el = stage.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const seen = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) onScale(Math.round((width / WORLD.width) * 10) / 10);
    };
    seen();
    const watch = new ResizeObserver(seen);
    watch.observe(el);
    return () => watch.disconnect();
  }, [onScale]);

  useEffect(() => {
    const off = () => setSpace(false);
    window.addEventListener("blur", off);
    return () => window.removeEventListener("blur", off);
  }, []);

  const v = nav.view;
  return (
    <div
      ref={stage}
      className={`graph-stage${space ? " pan-ready" : ""}${dragging ? " panning" : ""}`}
      style={{ aspectRatio: `${WORLD.width} / ${WORLD.height}` }}
      role="application"
      aria-label="Graph. Cmd and plus or minus zoom, Cmd and 0 fits, arrow keys pan, Space and drag pans."
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the stage takes the keys that move the view
      tabIndex={0}
      data-testid="graph-stage"
      data-scale={v.k.toFixed(3)}
      data-x={v.x.toFixed(1)}
      data-y={v.y.toFixed(1)}
      data-moved={nav.taken}
      onKeyDown={(e) => {
        if (e.key === " ") {
          // Space is the pan modifier here, not a button press: Enter still opens a node.
          e.preventDefault();
          setSpace(true);
          return;
        }
        const input = keyInput(e);
        if (input === null) return;
        e.preventDefault();
        move(input);
      }}
      onKeyUp={(e) => {
        if (e.key !== " ") return;
        e.preventDefault();
        setSpace(false);
      }}
      onPointerDownCapture={(e) => {
        if (!space || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d === null || d.id !== e.pointerId) return;
        const { pixel } = measure(e.clientX, e.clientY);
        move({ type: "pan", dx: (e.clientX - d.x) * pixel, dy: (e.clientY - d.y) * pixel });
        d.x = e.clientX;
        d.y = e.clientY;
        d.moved = true;
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        if (d === null || d.id !== e.pointerId) return;
        drag.current = null;
        setDragging(false);
        // The click that ends a drag is not a click on whatever is under the pointer.
        swallow.current = true;
        setTimeout(() => {
          swallow.current = false;
        }, 0);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      onClickCapture={(e) => {
        if (swallow.current || space) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div
        className="graph-plane"
        style={{
          transform: `translate(${pct(v.x, WORLD.width)}, ${pct(v.y, WORLD.height)}) scale(${v.k})`,
        }}
        data-testid="graph-plane"
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
          <NodeButton
            key={n.id}
            node={n}
            layout={layout}
            label={labels[n.id] ?? null}
            onZoom={onZoom}
          />
        ))}
      </div>
    </div>
  );
}

/** The graph of the map, at the zoom it is at. */
export function MapGraph({ map }: { map: MapSnapshot }) {
  const arrow = `graph-arrow-${useId().replace(/:/g, "")}`;
  const [asked, setZoom] = useState<GraphZoom>({ level: "context" });
  const graph = useMemo(() => projectGraph(map, asked), [map, asked]);
  const layout = useLayout(graph);
  const [scale, setScale] = useState(1);
  const named = graph.zoom.level === "item" || graph.nodes.length <= 14;
  const labels = useLabels(graph, layout, named, scale);
  const nav = useViewport(graph, layout, labels);
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
        <ViewTools nav={nav} />
        <span className="secondary graph-hint">Escape zooms out</span>
      </nav>
      <h3 className="graph-heading" tabIndex={-1} ref={heading} data-testid="graph-heading">
        {headingOf(graph)}
      </h3>
      <Stage
        graph={graph}
        layout={layout}
        arrow={arrow}
        labels={labels}
        onZoom={setZoom}
        onScale={setScale}
        nav={nav}
      />
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
