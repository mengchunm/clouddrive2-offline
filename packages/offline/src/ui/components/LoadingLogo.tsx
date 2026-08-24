import type { CSSProperties } from "react";

export interface LoadingLogoProps {
  size?: number;
  animated?: boolean;
  label?: string;
}

/** The supplied switching-squares mark, available as a static or animated brand asset. */
export function LoadingLogo({ size = 24, animated = true, label = "加载中" }: LoadingLogoProps) {
  return (
    <span
      className={`cd2-loading-logo${animated ? "" : " cd2-loading-logo-static"}`}
      style={
        {
          width: size,
          height: size,
          "--cd2-logo-scale": size / 120,
        } as CSSProperties
      }
      role="img"
      aria-label={label}
      aria-hidden={animated ? undefined : true}
    >
      <span className="cd2-loading-logo-canvas" aria-hidden="true">
        <span className="cd2-loading-logo-card cd2-loading-logo-card-a" />
        <span className="cd2-loading-logo-card cd2-loading-logo-card-b" />
      </span>
    </span>
  );
}
