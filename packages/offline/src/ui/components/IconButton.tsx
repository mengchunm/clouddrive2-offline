import { Button, type ButtonProps, Tooltip } from "antd";
import type { ReactNode } from "react";

export interface IconButtonProps extends Omit<ButtonProps, "aria-label" | "children" | "icon" | "title"> {
  label: string;
  icon: ReactNode;
}

/** Consistent icon-only action with a visible tooltip and accessible name. */
export function IconButton({ label, icon, ...buttonProps }: IconButtonProps) {
  return (
    <Tooltip title={label}>
      <Button {...buttonProps} icon={icon} aria-label={label} />
    </Tooltip>
  );
}
