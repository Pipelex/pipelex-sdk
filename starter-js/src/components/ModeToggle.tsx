"use client";

import { useRef } from "react";
import type { ExecutionMode } from "@/config";

const OPTIONS: { value: ExecutionMode; label: string }[] = [
  { value: "blocking", label: "Blocking" },
  { value: "durable", label: "Durable · live status" },
];

interface ModeToggleProps {
  value: ExecutionMode;
  onChange: (mode: ExecutionMode) => void;
  disabled?: boolean;
}

/**
 * Per-example execution-mode switch — a small segmented `radiogroup`. Each form
 * owns its own mode state and passes it here, so you can compare Blocking vs
 * Durable on the same input. Disabled while a run is in flight.
 *
 * Implements the ARIA radio-group keyboard contract the roles promise: a
 * roving tabindex (only the selected option is in the tab order) and arrow
 * keys that move both selection and focus, wrapping around the group.
 */
export function ModeToggle({ value, onChange, disabled }: ModeToggleProps) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    let offset: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") offset = 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") offset = -1;
    else return;
    event.preventDefault();
    const next = (index + offset + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].value);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div className="space-y-1.5">
      <div
        role="radiogroup"
        aria-label="Execution mode"
        className="inline-flex rounded-lg border border-slate-300 bg-slate-100 p-0.5"
      >
        {OPTIONS.map((opt, index) => {
          const selected = opt.value === value;
          return (
            <button
              key={opt.value}
              ref={(el) => {
                buttonRefs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={
                selected
                  ? "rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-900 shadow-xs disabled:opacity-50"
                  : "rounded-md px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        Durable survives the ~30s hosted timeout and streams live status. Blocking is simpler but
        hits the cap on long pipelines.
      </p>
    </div>
  );
}
