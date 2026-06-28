/**
 * #238 step 3: per-series color picker.
 *
 * Each picker shows a swatch button reflecting the current effective
 * color (override or default). Clicking opens a popover with the
 * curated preset palette, a native color input for custom picks, and
 * a "Reset" link to clear the override. Operator picks land on the
 * daemon via the parent's `onChange` and re-render the charts on the
 * next config refetch.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { CHART_COLOR_PRESETS } from '../lib/chartColors';
import { copyToClipboard } from '../lib/clipboard';

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Inline Lucide `Copy` icon. The project's convention is to inline
 * Lucide SVG paths rather than import them; see the icons-from-lucide
 * memory. Sized 14×14 to sit comfortably on a small button.
 */
function CopyIcon({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export interface ChartColorPickerProps {
  /** Current effective color: override if set, else default. */
  value: string;
  /** Documented default (what `Reset` returns to). */
  defaultValue: string;
  /** Operator picked a color; `null` means "reset to default". */
  onChange: (next: string | null) => void;
  /** Whether the operator has an override on this slot. Drives the
   *  "Reset to default" link's visibility. */
  isOverridden: boolean;
}

/**
 * Renders a swatch button + popover. Uses a `<details>` element so we
 * don't have to wire global click-outside dismissal — the browser
 * handles open/closed state natively and the popover closes when
 * the user clicks the summary again or focuses elsewhere.
 */
export function ChartColorPicker({
  value,
  defaultValue,
  onChange,
  isOverridden,
}: ChartColorPickerProps): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Click-outside close: native <details> doesn't auto-close on
  // outside clicks. Wire one up so the picker dismisses naturally.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = detailsRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.removeAttribute('open');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const close = () => detailsRef.current?.removeAttribute('open');
  const pick = (color: string) => {
    onChange(color);
    close();
  };
  // #238 follow-up #2: cross-slot color sharing.
  //
  // - Copy: writes the current hex to the clipboard via the existing
  //   `copyToClipboard` helper (handles insecure LAN-HTTP contexts via
  //   execCommand fallback). Button flashes a check icon on success.
  // - Paste: the previous "Paste" button used `navigator.clipboard.readText()`
  //   which is undefined in non-secure contexts (LAN HTTP), and even
  //   in secure contexts requires an explicit permission grant - so it
  //   silently failed for the operator. Replaced with a hex text input
  //   the operator can paste into (Ctrl+V / Cmd+V) or hand-edit. Valid
  //   `#RRGGBB` (or bare `RRGGBB`) applies immediately.
  const [copyOk, setCopyOk] = useState(false);
  const [hexDraft, setHexDraft] = useState(value);
  // Re-sync the draft to the prop whenever the prop changes (e.g. a
  // preset swatch was clicked) so the input always shows the current
  // effective color when the popover opens fresh.
  useEffect(() => {
    setHexDraft(value);
  }, [value]);

  const handleCopy = async () => {
    try {
      await copyToClipboard(value);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {
      // copyToClipboard throws on failure (insecure context with no
      // execCommand fallback either). Silent no-op; operator can
      // hand-copy from the hex input below.
    }
  };

  const handleHexChange = (next: string) => {
    setHexDraft(next);
    const trimmed = next.trim();
    const candidate = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    if (HEX_PATTERN.test(candidate)) {
      onChange(candidate.toLowerCase());
    }
  };

  return (
    <details ref={detailsRef} className="relative inline-block">
      <summary
        className="list-none cursor-pointer inline-flex items-center gap-1.5 rounded border border-slate-700 px-1.5 py-1 hover:border-slate-500"
        title={t`Edit color`}
      >
        <span
          className="inline-block w-5 h-5 rounded border border-slate-600"
          style={{ backgroundColor: value }}
        />
        <span className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">
          {value}
        </span>
      </summary>
      <div
        className="absolute z-20 mt-1 w-64 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl"
        // Stop the parent click from closing details immediately
        // when the operator clicks inside the popover.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-slate-500 mb-2 uppercase tracking-wider">
          <Trans>Presets</Trans>
        </div>
        <div className="grid grid-cols-6 gap-1.5 mb-3">
          {CHART_COLOR_PRESETS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => pick(swatch)}
              className="w-8 h-8 rounded border border-slate-700 hover:border-slate-400 transition"
              style={{ backgroundColor: swatch }}
              title={swatch}
              aria-label={swatch}
            />
          ))}
        </div>
        {/* #238 follow-up #2: Custom row combines the native picker,
            an editable hex input (paste target — works on LAN HTTP
            where navigator.clipboard.readText doesn't), and a Copy
            button with a Lucide icon. The hex input applies immediately
            once a valid `#RRGGBB` is typed or pasted. */}
        <div className="flex items-center gap-2 mb-2">
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="w-9 h-7 rounded border border-slate-700 bg-transparent cursor-pointer shrink-0"
            title={t`Custom color picker`}
            aria-label={t`Custom color picker`}
          />
          <input
            type="text"
            value={hexDraft}
            onChange={(e) => handleHexChange(e.target.value)}
            placeholder="#RRGGBB"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs font-mono text-slate-200 focus:border-amber-400 focus:outline-none"
            aria-label={t`Hex color (paste or type)`}
          />
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded border border-slate-700 hover:border-slate-400 text-slate-300 hover:text-slate-100 transition"
            title={copyOk ? t`Copied!` : t`Copy hex to clipboard`}
            aria-label={t`Copy hex to clipboard`}
          >
            {copyOk ? <CheckIcon className="text-emerald-400" /> : <CopyIcon />}
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            close();
          }}
          disabled={!isOverridden}
          className="block text-xs text-amber-400 hover:underline disabled:text-slate-600 disabled:no-underline disabled:cursor-not-allowed"
        >
          <Trans>Reset to default</Trans>
          <span className="ml-2 inline-block w-3 h-3 rounded border border-slate-700 align-middle" style={{ backgroundColor: defaultValue }} />
        </button>
      </div>
    </details>
  );
}
