const STATIC_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="cd2-base" gradientUnits="userSpaceOnUse" x1="0" y1="120" x2="120" y2="0">
      <stop offset="0" stop-color="#50d8f3" />
      <stop offset="0.56" stop-color="#2eabe3" />
      <stop offset="1" stop-color="#1777c6" />
    </linearGradient>
    <radialGradient id="cd2-glow" gradientUnits="userSpaceOnUse" cx="21.6" cy="98.4" r="43.2">
      <stop offset="0" stop-color="#fff" stop-opacity="0.18" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </radialGradient>
  </defs>
  <circle cx="60" cy="60" r="60" fill="url(#cd2-base)" />
  <circle cx="60" cy="60" r="60" fill="url(#cd2-glow)" />
  <g>
    <rect x="47" y="27" width="47" height="47" fill="url(#cd2-base)" />
    <rect x="47" y="27" width="47" height="47" fill="url(#cd2-glow)" />
    <rect x="50" y="30" width="41" height="41" fill="#fff" />
    <rect x="28" y="53" width="40" height="40" fill="url(#cd2-base)" />
    <rect x="28" y="53" width="40" height="40" fill="url(#cd2-glow)" />
    <rect x="31" y="56" width="34" height="34" fill="#fff" />
  </g>
</svg>`;

/** Static first frame of switching-squares-icon-v19-symmetric.html. */
export const CD2_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(STATIC_LOGO_SVG)}`;

// Kept as an alias for existing integrations that imported the old constant name.
export const CD2_ICON_BASE64 = CD2_ICON_URL;
