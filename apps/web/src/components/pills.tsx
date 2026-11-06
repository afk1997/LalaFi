import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Colour marks so chains are recognisable at a glance (muted versions of each network's own colour). */
export const CHAIN_MARK: Record<string, string> = { eth: '#9aa6d8', base: '#4d7cf0', arb: '#5fb0dd' };
export const USDC_MARK = '#6e9be0';

export function Mark({ color }: { color: string }) {
  return <span className="mark" style={{ background: color }} aria-hidden />;
}

export interface Option<T> {
  value: T;
  label: ReactNode;
  detail?: ReactNode;
  disabled?: boolean;
}

/** A pill inside the sentence that opens a menu of options. */
export function SelectPill<T>({
  value,
  options,
  onChange,
  children,
  label,
  note,
  tone,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  children: ReactNode;
  label: string;
  note?: ReactNode;
  tone?: 'value';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className={`pill${tone ? ` ${tone}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
        <span className="chev" aria-hidden />
      </button>
      {open && (
        <div className="menu" role="listbox" id={id}>
          {options.map((o, i) => (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={o.value === value}
              disabled={o.disabled}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="opt">{o.label}</span>
              {o.detail !== undefined && <span className="detail">{o.detail}</span>}
            </button>
          ))}
          {note && <div className="note">{note}</div>}
        </div>
      )}
    </span>
  );
}

/** Editable amount inside the sentence; grows with its content. */
export function AmountPill({
  value,
  onChange,
  invalid,
  label,
  suffix,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  label: string;
  suffix?: ReactNode;
}) {
  return (
    <span className={`pill value${invalid ? ' invalid' : ''}`}>
      <input
        aria-label={label}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="0"
        style={{ width: `${Math.max(1, value.length) * 0.56 + 0.05}em` }}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
      />
      {suffix}
    </span>
  );
}

/** Free-text field inside the sentence (address, code). */
export function FieldPill({
  value,
  onChange,
  placeholder,
  label,
  invalid,
  width,
  display,
  mono,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  invalid?: boolean;
  /** width in ch while editing */
  width: number;
  /** shown instead of the raw value while not focused (e.g. a shortened address) */
  display?: string;
  mono?: boolean;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const shown = !focused && display ? display : value;
  return (
    <span className={`pill field${invalid ? ' invalid' : ''}`}>
      <input
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={shown}
        placeholder={placeholder}
        style={{ width: `${(shown ? Math.min(width, shown.length) : placeholder.length) * 0.62 + 0.1}em`, ...(mono ? { fontFamily: 'var(--mono)', fontSize: '0.78em' } : {}) }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value)}
      />
    </span>
  );
}
