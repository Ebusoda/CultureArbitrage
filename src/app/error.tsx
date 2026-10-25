"use client";

import { useEffect } from "react";

// Shown when something on the page fails to render, so visitors get a way back instead of a blank page.
export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto w-full max-w-[1360px] px-4 pt-16 md:px-6 lg:px-8">
      <div className="max-w-[60ch] rounded-2xl border border-line bg-surface p-6 shadow-xs md:p-8">
        <h1 className="font-serif text-[26px] leading-tight md:text-[32px]">This page stopped working.</h1>
        <p className="mt-3 text-[15px] text-muted">
          Something on the page failed to load. Try again, and if it keeps happening, reload the page.
        </p>
        <button type="button" onClick={() => retry()} className="mt-5 h-11 rounded-full bg-accent px-6 text-[15px] font-bold text-on-accent shadow-sm">
          Try again
        </button>
      </div>
    </main>
  );
}
