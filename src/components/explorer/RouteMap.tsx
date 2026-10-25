"use client";

import { geoEqualEarth, geoGraticule, geoPath } from "d3-geo";
import { Component, type ReactNode, useMemo, useRef } from "react";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import landTopo from "world-atlas/land-110m.json";
import { CITY_COORDS, PRECEDENTS } from "@/lib/cities";
import type { Arc } from "./derive";
import { pct } from "./format";
import { useCaptionOverMap, useElementSize, usePrefersReducedMotion } from "./hooks";
import type { Status } from "./useExploreRun";

const topo = landTopo as unknown as Topology<{ land: GeometryCollection }>;
const LAND = feature(topo, topo.objects.land);
const GRATICULE = geoGraticule().step([15, 15])();

type Pt = [number, number];

// Centre of the shortest longitude interval holding every point, so the map
// shows the Pacific for Tokyo + New York and recentres for other city sets.
function centerLng(lngs: number[]) {
  if (lngs.length < 2) return lngs[0] ?? 0;
  const s = [...lngs].sort((a, b) => a - b);
  let gap = s[0] + 360 - s[s.length - 1];
  let start = s[0];
  for (let i = 1; i < s.length; i++) {
    if (s[i] - s[i - 1] > gap) {
      gap = s[i] - s[i - 1];
      start = s[i];
    }
  }
  const c = start + (360 - gap) / 2;
  return c > 180 ? c - 360 : c;
}

function arcPath([x0, y0]: Pt, [x1, y1]: Pt, i: number, h: number) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  // Always bulge upward.
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const k = Math.min(Math.max(len * (0.24 + 0.1 * i), 18 + 12 * i), h * 0.32);
  const cx = (x0 + x1) / 2 + nx * k;
  const cy = (y0 + y1) / 2 + ny * k;
  return { d: `M${x0},${y0} Q${cx},${cy} ${x1},${y1}`, apex: [(x0 + 2 * cx + x1) / 4, (y0 + 2 * cy + y1) / 4] as Pt, len };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

interface Props {
  cities: string[];
  home: string;
  status: Status;
  arcs: Arc[];
  selectedId: string | null;
  // Card auto-selected when the run finished; its arc plays a one-off reveal.
  revealId: string | null;
  onSelect: (id: string) => void;
  // Twin pair of the selected idea (linkKey), so a ruled-out idea, which has no route of its own,
  // still highlights the pair it came from.
  selectedKey?: string | null;
  // Live data: the twin score is the shared-taste score (share of tags in common), not a Qloo affinity.
  sharedTaste?: boolean;
}

export function RouteMap(props: Props) {
  return (
    <MapErrorBoundary arcs={props.arcs}>
      <MapSvg {...props} />
    </MapErrorBoundary>
  );
}

function MapSvg({ cities, home, status, arcs, selectedId, revealId, onSelect, selectedKey = null, sharedTaste = false }: Props) {
  const scoreName = sharedTaste ? "shared-taste score" : "taste affinity";
  const box = useRef<HTMLDivElement>(null);
  const { w, h } = useElementSize(box);
  const reduced = usePrefersReducedMotion();
  const captionOver = useCaptionOverMap();
  const idle = status === "idle";
  const phone = w < 640;

  const onMap = useMemo(() => [...new Set([...cities, "Taipei"])].filter((c) => CITY_COORDS[c]), [cities]);
  const center = useMemo(() => centerLng(onMap.map((c) => CITY_COORDS[c][0])), [onMap]);

  const { proj, land, graticule } = useMemo(() => {
    const coords = onMap.map((c) => CITY_COORDS[c]);
    const [lng, lat] = coords[0] ?? [0, 0];
    const fit =
      coords.length >= 2
        ? coords
        : [
            [lng - 12, lat - 12],
            [lng + 12, lat + 12],
          ];
    // When the caption floats over the bottom of the map (lg), the cities sit in the top part, out of its way.
    const extent: [Pt, Pt] = captionOver
      ? [
          [0.16 * w, 0.16 * h],
          [0.9 * w, 0.4 * h],
        ]
      : phone
        ? [
            [0.2 * w, 0.34 * h],
            [0.9 * w, 0.86 * h],
          ]
        : [
            // Extra room on the left for labels that sit left of the westmost cities.
            [0.16 * w, 0.28 * h],
            [0.9 * w, 0.54 * h],
          ];
    const proj = geoEqualEarth()
      .rotate([-center, 0])
      .fitExtent(extent, { type: "MultiPoint", coordinates: fit })
      .clipExtent([
        [0, 0],
        [w, h],
      ]);
    const path = geoPath(proj).digits(1);
    return { proj, land: path(LAND) ?? "", graticule: path(GRATICULE) ?? "" };
  }, [onMap, center, w, h, phone, captionOver]);

  const at = (city: string): Pt | null => {
    const c = CITY_COORDS[city];
    const p = c ? proj(c) : null;
    return p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null;
  };

  const selectedArc = arcs.find((a) => a.cards.some((c) => c.id === selectedId)) ?? (selectedKey ? (arcs.find((a) => a.key === selectedKey) ?? null) : null);
  const drawn = arcs
    .map((a) => {
      const p0 = at(a.link.twinCity);
      const p1 = at(a.link.homeCity);
      return p0 && p1 ? { ...a, geo: arcPath(p0, p1, a.index, h) } : null;
    })
    .filter((a) => a !== null);
  const twinArcs = drawn.filter((a) => a.state === "twin");
  const strongArcs = drawn.filter((a) => a.state !== "twin").sort((a, b) => Number(a.key === selectedArc?.key) - Number(b.key === selectedArc?.key));

  // Labels: city name, then up to 3 neighbourhoods on arcs at that city.
  const hoodsAt = (city: string) => {
    const names = new Set<string>();
    for (const a of [...strongArcs].reverse()) {
      if (a.link.homeCity === city) names.add(a.link.home);
      if (a.link.twinCity === city) names.add(a.link.twin);
    }
    for (const a of twinArcs) {
      if (a.link.homeCity === city) names.add(a.link.home);
      if (a.link.twinCity === city && (a.link.rank ?? 1) === 1) names.add(a.link.twin);
    }
    return [...names].slice(0, 3);
  };
  const selectedHoods = selectedArc ? [selectedArc.link.home, selectedArc.link.twin] : [];
  const nodes = onMap
    .filter((c) => c !== "Taipei" || idle)
    .map((city) => ({ city, p: at(city) }))
    .filter((n): n is { city: string; p: Pt } => n.p !== null);
  const labelled = (city: string) =>
    !phone || city === home || city === selectedArc?.link.twinCity || (idle && ["Taipei", "Seoul", "Tokyo"].includes(city));
  // Rough label width, to keep left-hand labels from running off the map.
  const labelWidth = (lines: { text: string; px: number }[]) => Math.max(...lines.map((l) => l.text.length * l.px));
  const anchorEnd = (city: string, [x, y]: Pt, width: number) =>
    x - 10 - width >= 4 && (x > 0.72 * w || nodes.some((n) => n.city !== city && n.p[0] > x && n.p[0] - x < 90 && Math.abs(n.p[1] - y) < 40));

  const notOnMap = cities.filter((c) => !CITY_COORDS[c]);
  const label = idle
    ? "Map of past trend routes: boba from Taipei to Tokyo; malatang from Seoul to Tokyo."
    : `Map. Home city ${home}. ${arcs.length} ${arcs.length === 1 ? "taste twin" : "taste twins"} found.` +
      (arcs.some((a) => a.cards.length)
        ? ` Opportunities: ${arcs
            .flatMap((a) => a.cards.map((c) => `${c.category} from ${c.twinLocality}, ${c.twinCity} to ${c.homeLocality}, ${c.homeCity}`))
            .join("; ")}.`
        : "") +
      (notOnMap.length ? ` Not on map: ${notOnMap.join(", ")}.` : "");

  const dim = (a: { key: string; state: string }) => {
    if (!selectedArc || a.key === selectedArc.key) return 1;
    // Twin arcs are the evidence for the selected route, so they stay readable.
    return a.state === "twin" ? 0.7 : 0.4;
  };

  return (
    <div ref={box} className="absolute inset-0">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="absolute inset-0 h-full w-full select-none">
        <path d={graticule} className="fill-none stroke-graticule" strokeWidth={0.5} />
        <path d={land} className="fill-land" />

        {idle &&
          PRECEDENTS.map((p) => {
            const a = at(p.from);
            const b = at(p.to);
            if (!a || !b) return null;
            const g = arcPath(a, b, 0, h);
            return (
              <path key={p.id} d={g.d} className="fade-in fill-none stroke-muted" strokeWidth={2} strokeDasharray="0.1 5" strokeLinecap="round" />
            );
          })}

        {twinArcs.map((a) => {
          const base = (a.link.rank ?? 1) === 1 ? 0.25 + 0.5 * a.link.similarity : 0.2;
          // The pair behind a selected ruled-out idea: full strength, with the doubt-coloured halo.
          const selected = a.key === selectedArc?.key;
          return (
            <g key={a.key}>
              {selected && <path d={a.geo.d} className="fill-none stroke-doubt" strokeWidth={11} strokeLinecap="round" style={{ opacity: 0.14 }} />}
              <path
                d={a.geo.d}
                className="fade-in fill-none stroke-twin"
                strokeWidth={1.5}
                strokeLinecap="round"
                style={{ opacity: selected ? 1 : base * dim(a), transition: "opacity 300ms" }}
              >
                <title>{`${a.link.twin}, ${a.link.twinCity} → ${a.link.home}, ${a.link.homeCity} · ${scoreName} ${a.link.similarity.toFixed(2)}`}</title>
              </path>
            </g>
          );
        })}

        {strongArcs.map((a) => {
          const selected = a.key === selectedArc?.key;
          const top = a.cards.reduce((b, c) => (c.confidence > b.confidence ? c : b));
          const fading = a.state === "fading";
          const title =
            `${a.link.twin}, ${a.link.twinCity} → ${a.link.home}, ${a.link.homeCity} · ${scoreName} ${a.link.similarity.toFixed(2)} · ` +
            a.cards.map((c) => `${c.category} ${pct(c.confidence)}%`).join(" · ");
          const apexText = fading ? `${a.cards[0].category}, fading` : a.cards.map((c) => c.category).join(", ");
          return (
            <g key={a.key} style={{ opacity: dim(a), transition: "opacity 300ms" }}>
              {selected && (
                <path
                  key={`halo-${revealId === top.id ? "reveal" : "plain"}`}
                  d={a.geo.d}
                  className={`fill-none stroke-accent ${revealId && a.cards.some((c) => c.id === revealId) ? "arc-reveal" : ""}`}
                  strokeWidth={11}
                  strokeLinecap="round"
                  style={{ opacity: 0.14 }}
                />
              )}
              {fading ? (
                <path d={a.geo.d} className="fade-in fill-none stroke-doubt" strokeWidth={3} strokeDasharray="0.1 6" strokeLinecap="round" />
              ) : (
                <>
                  <path d={a.geo.d} className="fill-none stroke-twin" strokeWidth={1.5} strokeLinecap="round" style={{ opacity: 0.5 }} />
                  <path d={a.geo.d} pathLength={1} className="arc-draw fill-none stroke-accent" strokeWidth={selected ? 3.5 : 2.75} strokeLinecap="round" />
                  {!reduced && (
                    <circle r={3.5} className="fill-surface stroke-accent stroke-[2.5px]">
                      <animateMotion dur={`${clamp(a.geo.len / 250, 1.2, 3.2)}s`} repeatCount="indefinite" path={a.geo.d} />
                    </circle>
                  )}
                </>
              )}
              {!phone && a.geo.len >= 160 && (
                <text x={a.geo.apex[0]} y={a.geo.apex[1] - 8} textAnchor="middle" className={`label-halo text-[13px] font-bold ${fading ? "fill-doubt" : "fill-ink"}`}>
                  {apexText}
                </text>
              )}
              <path
                d={a.geo.d}
                className="cursor-pointer fill-none stroke-transparent"
                strokeWidth={14}
                style={{ pointerEvents: "stroke" }}
                onClick={() => onSelect(top.id)}
              >
                <title>{title}</title>
              </path>
            </g>
          );
        })}

        {nodes.map(({ city, p }) => {
          const isHome = city === home;
          const r = phone ? 3.5 : 4.5;
          return (
            <g key={city}>
              {isHome && status === "running" && <circle cx={p[0]} cy={p[1]} r={6} className="home-pulse fill-accent" />}
              {isHome && idle && <circle cx={p[0]} cy={p[1]} r={11} className="fill-accent/15 stroke-none" />}
              <circle
                cx={p[0]}
                cy={p[1]}
                r={isHome ? 6 : r}
                className={isHome ? `fill-surface stroke-[3px] ${status === "error" ? "stroke-doubt" : "stroke-accent"}` : "fill-surface stroke-ink stroke-2"}
                strokeWidth={1.5}
              />
            </g>
          );
        })}

        {nodes
          .filter((n) => labelled(n.city))
          .map(({ city, p }) => {
            const hoods = phone ? [] : hoodsAt(city);
            // On the idle map, past trends are named under the city they came from.
            const past = idle && !phone ? PRECEDENTS.filter((p) => p.from === city) : [];
            const width = labelWidth([
              { text: city, px: 8 },
              ...hoods.map((text) => ({ text, px: 7 })),
              ...past.map((p) => ({ text: p.label, px: 5.5 })),
            ]);
            const end = anchorEnd(city, p, width);
            const x = end ? p[0] - 14 : p[0] + 14;
            return (
              <text key={city} x={x} y={p[1] + 4} textAnchor={end ? "end" : "start"} className="label-halo">
                <tspan className="fill-ink text-[13px] font-extrabold">{city}</tspan>
                {hoods.map((n) => (
                  <tspan key={n} x={x} dy={15} className={`fill-ink text-[12px] ${selectedHoods.includes(n) ? "font-bold" : "font-medium"}`}>
                    {n}
                  </tspan>
                ))}
                {past.map((p) => (
                  <tspan key={p.id} x={x} dy={15} className="fill-muted text-[12px] font-medium">
                    {p.label}
                  </tspan>
                ))}
              </text>
            );
          })}
      </svg>
    </div>
  );
}

class MapErrorBoundary extends Component<{ arcs: Arc[]; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const rows = this.props.arcs.flatMap((a) =>
      a.cards.length
        ? a.cards.map((c) => `${a.link.twin}, ${a.link.twinCity} → ${a.link.home}, ${a.link.homeCity} · ${c.category} · ${pct(c.confidence)}%`)
        : [`${a.link.twin}, ${a.link.twinCity} → ${a.link.home}, ${a.link.homeCity} · taste twin`],
    );
    return (
      <div className="absolute inset-0 overflow-y-auto p-4 text-[13px]">
        <p className="text-muted">The map could not be drawn. Routes found so far:</p>
        <ul className="mt-2 space-y-1">
          {rows.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }
}
