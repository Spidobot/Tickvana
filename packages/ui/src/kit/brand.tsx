// The brand in the shell, the portal and before sign-in: the uploaded logo, or
// the app's own mark beside the product name.
import type { BrandingInfo } from "./api.js";

export function Brand({
  branding,
  size = "sm",
}: {
  branding: BrandingInfo;
  size?: "sm" | "lg";
}) {
  const [logo, mark] = size === "lg" ? ["h-8", "size-7"] : ["h-6", "size-5"];
  return branding.logoLightUrl ? (
    <picture>
      {branding.logoDarkUrl && (
        <source
          srcSet={branding.logoDarkUrl}
          media="(prefers-color-scheme: dark)"
        />
      )}
      <img
        src={branding.logoLightUrl}
        alt={branding.productName}
        className={`${logo} w-auto`}
      />
    </picture>
  ) : (
    <span className="flex items-center gap-2">
      <img src={branding.markUrl} alt="" className={mark} />
      {branding.productName}
    </span>
  );
}
