import { Arrow } from "./Arrow";

// The three things the agent does, as a row of small pictures instead of a paragraph.
const STEPS = [
  { label: "Find taste twins", icon: <><circle cx="7" cy="10" r="4.5" /><circle cx="13" cy="10" r="4.5" /></> },
  { label: "Count the gap", icon: <><path d="M4 16V9M10 16V4M16 16v-3" /></> },
  { label: "Try to prove it wrong", icon: <><circle cx="9" cy="9" r="5" /><path d="m13 13 4 4" /></> },
];

export function Hero({ idle }: { idle: boolean }) {
  return (
    <section className="pt-8 md:pt-10">
      <h1 className="max-w-[22ch] font-serif text-[26px] font-extrabold leading-[1.12] md:text-[40px] md:leading-[1.08]">
        Your city’s next hit is already open somewhere else.
      </h1>
      {idle && (
        <>
          <p className="mt-3 max-w-[68ch] text-[15px] text-muted md:text-[16px]">Pick a city. Every number links to the source it came from.</p>
          <ol className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-2 text-[14px] font-medium">
            {STEPS.map((s, i) => (
              <li key={s.label} className="flex items-center gap-2">
                {i > 0 && (
                  <span className="text-muted">
                    <Arrow silent />
                  </span>
                )}
                <span className="flex items-center gap-2 rounded-full bg-surface py-1 pl-1.5 pr-3 shadow-xs ring-1 ring-line">
                  <svg viewBox="0 0 20 20" className="h-6 w-6 rounded-full bg-accent/10 fill-none stroke-accent p-1" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
                    {s.icon}
                  </svg>
                  {s.label}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
