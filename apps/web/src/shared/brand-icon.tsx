import { useState } from 'react';

const DEFAULT_BRAND_ICON = '/brand-icon.svg';

export function BrandIcon() {
  const [failed, setFailed] = useState(false);
  const source = import.meta.env.VITE_BRAND_ICON_URL || DEFAULT_BRAND_ICON;
  if (failed) return <span className="brand-icon-fallback" aria-hidden="true" />;
  return <img className="brand-icon" src={source} alt="" onError={() => setFailed(true)} />;
}
