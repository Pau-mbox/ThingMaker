/**
 * A provider's logo as a small app-icon tile. The three are drawn on one
 * shared rounded-square mask (`public/providers/*.png`) so they read as a
 * set wherever they appear together.
 */
import { PROVIDER_LABELS, type Provider } from "@thingmaker/contracts";

export function ProviderLogo({ provider, size = 40 }: { provider: Provider; size?: number }) {
  return (
    <img
      alt={`${PROVIDER_LABELS[provider]} logo`}
      className="provider-logo"
      draggable={false}
      height={size}
      src={`/providers/${provider}.png`}
      style={{ borderRadius: Math.round(size * 0.225) }}
      width={size}
    />
  );
}
