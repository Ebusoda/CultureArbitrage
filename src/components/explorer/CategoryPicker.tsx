"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CATALOG, CATALOG_GROUPS, COVERAGE_CAP, COVERAGE_DATE, catalogEntry, type CatalogEntry, matchCatalog, searchCatalog, thinIn } from "@/lib/agent/catalog";
import type { AskedTarget } from "@/lib/agent/types";
import { MAX_QUERY } from "./format";

interface Props {
  // The business type picked, or null for a scan.
  value: AskedTarget | null;
  onChange: (target: AskedTarget | null) => void;
  city: string;
  cities: string[];
  // Sample data has only the scan's 8 categories.
  qlooMode: string;
  disabled?: boolean;
}

type Option = { kind: "entry"; entry: CatalogEntry } | { kind: "free"; text: string };

// "Or check one business: [yoga studio]". A search box over the catalog (176 business types
// Qloo lists in these cities), with a last option that sends the typed text as it is, for the
// agent to match through Qloo's tag search. Picking one switches the run from a scan to a check
// of that one type; clearing it switches back.
export function CategoryPicker({ value, onChange, city, cities, qlooMode, disabled = false }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const clear = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => (qlooMode === "live" ? CATALOG : CATALOG.filter((e) => e.mockTag)), [qlooMode]);

  const options: Option[] = useMemo(() => {
    const typed = text.trim();
    if (!typed) return browse ? entries.slice().sort((a, b) => groupOrder(a) - groupOrder(b) || a.label.localeCompare(b.label)).map((entry) => ({ kind: "entry" as const, entry })) : [];
    const list = searchCatalog(typed, entries, 8);
    // The listed type the text names ("tapas bars", "ramenshop") always comes first.
    const exact = matchCatalog(typed, entries);
    if (exact && list[0] !== exact) list.splice(0, list.length, exact, ...list.filter((e) => e !== exact).slice(0, 7));
    const found: Option[] = list.map((entry) => ({ kind: "entry", entry }));
    // Free text, unless it is exactly one of the listed types.
    if (!exact && [...typed].length <= MAX_QUERY) found.push({ kind: "free", text: typed });
    return found;
  }, [text, browse, entries]);

  const show = open && options.length > 0;
  // moveFocus: picked from the list, so keyboard focus goes to the chip's clear button (the input
  // it was in goes away). Not when the visitor left the box for something else.
  const pick = (o: Option, moveFocus = true) => {
    onChange(o.kind === "entry" ? { key: o.entry.key, label: o.entry.label } : { label: o.text, query: o.text });
    setText("");
    setOpen(false);
    setBrowse(false);
    if (moveFocus) requestAnimationFrame(() => clear.current?.focus());
  };
  // Leaving the picker with text in the box picks that text, so the Run button checks what the box
  // shows instead of quietly scanning everything. Moving between the box and "Browse all" is not leaving.
  const onBlur = (e: React.FocusEvent) => {
    if (e.relatedTarget instanceof Node && box.current?.contains(e.relatedTarget)) return;
    setOpen(false);
    const typed = (input.current?.value ?? "").trim();
    if (!typed || disabled) return;
    const exact = matchCatalog(typed, entries);
    if (exact) pick({ kind: "entry", entry: exact }, false);
    else if ([...typed].length <= MAX_QUERY) pick({ kind: "free", text: typed }, false);
  };
  // The highlighted option stays in view while arrow keys move through a long list.
  useEffect(() => {
    if (show) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, show, id]);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter or arrows that confirm a Japanese, Chinese or Korean input method belong to it.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!show) {
        setOpen(true);
        if (!text.trim()) setBrowse(true);
        setActive(0);
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + options.length) % options.length);
    } else if (e.key === "Enter") {
      if (show && options[active]) {
        e.preventDefault();
        pick(options[active]);
      }
    } else if (e.key === "Escape") {
      if (show) {
        e.preventDefault();
        setOpen(false);
        setBrowse(false);
      }
    }
  };

  const picked = value?.key ? catalogEntry(value.key) : undefined;
  if (value) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[14px] text-muted">Checking one business:</span>
        <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/10 py-1 pl-3 pr-1 text-[14px] font-semibold text-accent">
          <span className="truncate">{value.label}</span>
          <button
            ref={clear}
            type="button"
            aria-label={`Stop checking ${value.label}, scan instead`}
            aria-disabled={disabled}
            onClick={() => {
              if (disabled) return;
              onChange(null);
              requestAnimationFrame(() => input.current?.focus());
            }}
            className="grid h-6 w-6 place-items-center rounded-full hover:bg-accent/15 aria-disabled:opacity-60"
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3 stroke-current" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </span>
        <span className="w-full text-[12px] text-muted">
          {picked && qlooMode === "live" ? (
            <>
              <Coverage entry={picked} cities={cities} />
              {thinIn(picked, city) && <span className="text-doubt"> Qloo lists few in {city}, so a gap there may be missing data rather than missing shops.</span>}
            </>
          ) : picked ? (
            "From the sample data."
          ) : (
            "Not on the list: the agent will look it up in Qloo's tags first."
          )}
        </span>
      </div>
    );
  }

  return (
    <div ref={box} onBlur={onBlur} className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <label htmlFor={`${id}-input`} className="text-[14px] text-muted">
        Or check one business
      </label>
      <div className="relative w-full md:w-[300px]">
        <input
          ref={input}
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={show}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={show ? `${id}-opt-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY}
          disabled={disabled}
          value={text}
          placeholder="yoga studio, ramen shop, florist…"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setBrowse(false);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className="h-10 w-full rounded-full bg-surface px-4 text-[14px] shadow-sm ring-1 ring-line placeholder:text-muted/80 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
        />
        {show && (
          <ul id={listId} role="listbox" aria-label="Business types" className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[320px] overflow-y-auto rounded-2xl bg-surface p-1 shadow-lg ring-1 ring-line">
            {options.map((o, i) => (
              <li
                key={o.kind === "entry" ? o.entry.key : `free:${o.text}`}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer rounded-xl px-3 py-2 text-[14px] ${i === active ? "bg-accent/10" : ""}`}
              >
                {o.kind === "entry" ? (
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate">
                      {browse && (i === 0 || groupOf(options[i - 1]) !== o.entry.group) && <span className="mr-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{groupLabel(o.entry.group)}</span>}
                      {o.entry.label}
                    </span>
                    {qlooMode === "live" && thinIn(o.entry, city) && <span className="shrink-0 text-[11px] text-doubt">few on Qloo in {city}</span>}
                  </span>
                ) : (
                  <span>
                    Look up “{o.text}” in Qloo’s tags
                    <span className="block text-[12px] text-muted">Not on the list: the agent matches it to a Qloo category first.</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setText("");
            setBrowse(true);
            setOpen(true);
            setActive(0);
            input.current?.focus();
          }}
          className="text-[13px] font-medium text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
        >
          Browse all {entries.length}
        </button>
      )}
    </div>
  );
}

function groupOrder(e: CatalogEntry) {
  return CATALOG_GROUPS.findIndex((g) => g.value === e.group);
}

function groupOf(o: Option | undefined) {
  return o?.kind === "entry" ? o.entry.group : null;
}

function groupLabel(group: CatalogEntry["group"]) {
  return CATALOG_GROUPS.find((g) => g.value === group)?.label ?? group;
}

// "Qloo lists 9 in Tokyo, 50+ in New York, 0 in Seoul (counted 2026-10-25)."
export function Coverage({ entry, cities }: { entry: { coverage?: Record<string, number> }; cities: string[] }) {
  const parts = cities.filter((c) => typeof entry.coverage?.[c] === "number").map((c) => `${entry.coverage![c] >= COVERAGE_CAP ? `${COVERAGE_CAP}+` : entry.coverage![c]} in ${c}`);
  if (!parts.length) return null;
  return (
    <>
      Qloo lists {parts.join(", ")} (counted {COVERAGE_DATE}).
    </>
  );
}
