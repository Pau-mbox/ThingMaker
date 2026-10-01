/**
 * A provider's mark at badge size: Claude's starburst, Codex's cloud with a
 * prompt, Antigravity's arch. Drawn as glyphs rather than the app-icon tiles
 * (`ProviderLogo`), so they sit on the dark theme without a coloured square
 * around each, and read as one set: same box, same weight, each in its own
 * colour.
 */
import { useId } from "react";
import { PROVIDER_LABELS, type Provider } from "@thingmaker/contracts";

function Claude() {
  // Rays of slightly different lengths, the way the mark is drawn.
  const rays = [10.4, 9, 10, 8.6, 10.6, 9.2, 9.8, 8.8, 10.4, 9, 9.6, 8.6];
  return (
    <g stroke="#d97757" strokeLinecap="round" strokeWidth="2.4">
      {rays.map((length, index) => {
        const angle = ((index * 30 + (index % 2 ? 7 : -4)) * Math.PI) / 180;
        return <line key={index} x1={12 + Math.cos(angle) * 1.4} x2={12 + Math.cos(angle) * length} y1={12 + Math.sin(angle) * 1.4} y2={12 + Math.sin(angle) * length} />;
      })}
    </g>
  );
}

function Codex({ id }: { id: string }) {
  const bumps = Array.from({ length: 8 }, (_, index) => (index * Math.PI) / 4);
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#97a4ff" />
          <stop offset="1" stopColor="#5d66f2" />
        </linearGradient>
      </defs>
      <g fill={`url(#${id})`}>
        <circle cx="12" cy="12" r="7" />
        {bumps.map((angle, index) => (
          <circle cx={12 + Math.cos(angle) * 5.8} cy={12 + Math.sin(angle) * 5.8} key={index} r="4.3" />
        ))}
      </g>
      <g fill="none" stroke="#14151c" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4">
        <polyline points="7.8,9.2 10.8,12 7.8,14.8" />
        <line x1="12.8" x2="16.4" y1="15" y2="15" />
      </g>
    </>
  );
}

function Antigravity({ id }: { id: string }) {
  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f0544a" />
          <stop offset="0.3" stopColor="#f6b21b" />
          <stop offset="0.62" stopColor="#4c8df6" />
          <stop offset="1" stopColor="#3a74e8" />
        </linearGradient>
      </defs>
      <path
        d="M1.8 21C5.2 21 7.2 2.6 12 2.6C16.8 2.6 18.8 21 22.2 21C20.2 21 18.4 20 17.2 17.4C15.6 13.8 14.4 10.6 12 10.6C9.6 10.6 8.4 13.8 6.8 17.4C5.6 20 3.8 21 1.8 21Z"
        fill={`url(#${id})`}
      />
    </>
  );
}

export function ProviderMark({ provider, size = 16 }: { provider: Provider; size?: number }) {
  // React's ids carry characters an SVG `url(#…)` reference cannot.
  const id = `pm${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg aria-hidden="true" className="provider-mark-glyph" height={size} viewBox="0 0 24 24" width={size}>
      {provider === "claude" ? <Claude /> : provider === "codex" ? <Codex id={`${id}-codex`} /> : <Antigravity id={`${id}-agy`} />}
    </svg>
  );
}

/** The mark in a small tile, for a row: the badge that replaces CC / CX. */
export function ProviderBadge({ provider, title }: { provider: Provider; title?: string }) {
  const label = provider === "gemini" ? "Gemini (Antigravity)" : PROVIDER_LABELS[provider];
  return (
    <span aria-label={label} className={`provider-mark provider-${provider}`} role="img" title={title ?? label}>
      <ProviderMark provider={provider} />
    </span>
  );
}
