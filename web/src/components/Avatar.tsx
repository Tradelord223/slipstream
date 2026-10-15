import { avatarHue, initials } from "../lib/format.ts";

export function Avatar({ name, email, size = 32 }: { name: string; email: string; size?: number }) {
  const hue = avatarHue(email || name);
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        background: `hsl(${hue} 42% 28%)`,
        color: `hsl(${hue} 70% 88%)`,
      }}
    >
      {initials(name || email)}
    </span>
  );
}
