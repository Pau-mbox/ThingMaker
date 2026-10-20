/**
 * A provider's logo as a small app-icon tile. The three are drawn on one
 * shared rounded-square mask (`public/providers/*.png`) so they read as a
 * set wherever they appear together.
 */
import { PROVIDER_LABELS, type Provider } from "@thingmaker/contracts";
import { t } from "../i18n";

export function ProviderLogo({ provider, size = 40 }: { provider: Provider; size?: number }) {
  return (
    <img
      alt={t("{provider} logo", { provider: PROVIDER_LABELS[provider] })}
      className="provider-logo"
      draggable={false}
      height={size}
      src={`${import.meta.env.BASE_URL}providers/${provider}.png`}
      style={{ borderRadius: Math.round(size * 0.225) }}
      width={size}
    />
  );
}
