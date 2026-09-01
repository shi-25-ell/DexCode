import { useState } from 'react';

const DEFAULT_BRAND_LOGO = '/dexcode-logo.svg';

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  const source = import.meta.env.VITE_BRAND_ICON_URL || DEFAULT_BRAND_LOGO;

  if (failed) {
    return <span className={compact ? 'brand-logo-fallback compact' : 'brand-logo-fallback'}>{compact ? 'D' : 'DexCode'}</span>;
  }

  if (compact) {
    return (
      <span className="brand-logo-compact" role="img" aria-label="DexCode">
        <img className="brand-logo" src={source} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }

  return <img className="brand-logo" src={source} alt="DexCode" onError={() => setFailed(true)} />;
}
