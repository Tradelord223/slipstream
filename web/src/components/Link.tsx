import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../store/route.ts";

/** An anchor that navigates in-app with the History API, but still opens in a new tab on Cmd/Ctrl-click. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
