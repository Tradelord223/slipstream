import type { ActivityActor } from "../types.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";

/** A rounded square in sky blue, so an agent never reads as a person's round avatar. */
export function AgentGlyph({ name, size = 28 }: { name: string; size?: number }) {
  const letter = name.trim().charAt(0).toUpperCase() || "A";
  return (
    <span className="agent-glyph" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.46), borderRadius: size >= 28 ? 6 : 5 }}>
      {letter}
    </span>
  );
}

export function ActorGlyph({ actor, size = 28 }: { actor: ActivityActor; size?: number }) {
  if (actor.kind === "agent") return <AgentGlyph name={actor.name} size={size} />;
  // The local user is simply "You"; initials of that would read "YO".
  if (actor.name === "You")
    return (
      <span className="avatar avatar-you" aria-hidden="true" style={{ width: size, height: size }}>
        <Icon name="user" size={Math.round(size * 0.58)} />
      </span>
    );
  return <Avatar name={actor.name} email={actor.name} size={size} />;
}
