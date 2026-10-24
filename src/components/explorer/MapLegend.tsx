import { CITY_COORDS } from "@/lib/cities";

export function MapLegend({ idle, cities }: { idle: boolean; cities: string[] }) {
  const missing = cities.filter((c) => !CITY_COORDS[c]);
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium text-muted md:flex-col md:gap-1.5">
      <Item swatch={<line x1="1" y1="5" x2="21" y2="5" className="stroke-twin" strokeWidth={1.5} strokeLinecap="round" />}>Taste twin (Qloo)</Item>
      <Item
        swatch={
          <>
            <line x1="1.5" y1="5" x2="20.5" y2="5" className="stroke-accent" strokeWidth={2.75} strokeLinecap="round" />
            <circle cx="15" cy="5" r="2.75" className="fill-surface stroke-accent stroke-2" />
          </>
        }
      >
        Could travel this way
      </Item>
      <Item swatch={<line x1="2" y1="5" x2="21" y2="5" className="stroke-doubt" strokeWidth={3} strokeDasharray="0.1 6" strokeLinecap="round" />}>Real gap, but fading</Item>
      {idle && <Item swatch={<line x1="1" y1="5" x2="21" y2="5" className="stroke-muted" strokeWidth={2} strokeDasharray="0.1 5" strokeLinecap="round" />}>Past trend</Item>}
      {missing.map((c) => (
        <li key={c}>Not on map: {c}</li>
      ))}
    </ul>
  );
}

function Item({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <svg width="22" height="10" aria-hidden="true" className="shrink-0">
        {swatch}
      </svg>
      {children}
    </li>
  );
}
