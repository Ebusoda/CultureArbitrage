export function Hero({ idle }: { idle: boolean }) {
  return (
    <section className="pt-8 md:pt-10">
      <p className="inline-flex rounded-full bg-peach px-3 py-1 text-[12px] font-semibold text-ink">Autonomous agent · Qloo taste data</p>
      <h1 className="mt-3 max-w-[22ch] font-serif text-[26px] font-extrabold leading-[1.12] md:text-[40px] md:leading-[1.08]">
        Your city’s next hit is already open somewhere else.
      </h1>
      {idle && (
        <p className="mt-3 max-w-[68ch] text-[15px] text-muted md:text-[16px]">
          Pick a city. The agent finds its taste twins (neighbourhoods in other cities whose people love the same things), counts what those twins support
          that your city lacks, then tries to prove itself wrong. Every number links to the Qloo call it came from.
        </p>
      )}
    </section>
  );
}
