// Google's latin font subsets have no U+2192, so a typed arrow would fall back to a mismatched system glyph.
// The default stroke suits Figtree at both text and bold heading weights; thin is for light text.
export function Arrow({ thin = false }: { thin?: boolean }) {
  return (
    <>
      <svg
        viewBox="0 0 16 10"
        aria-hidden="true"
        className="mx-[0.05em] inline-block h-[0.55em] w-[0.9em] fill-none stroke-current align-[0.1em]"
        strokeWidth={thin ? 1.1 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M1.5 5h12.5M10 1.25 14 5l-4 3.75" />
      </svg>
      <span className="sr-only">to</span>
    </>
  );
}
