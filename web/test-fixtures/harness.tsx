// Entry point for `npm run test:render` (scripts/test-render.mjs bundles it with esbuild).
// It mounts the app's real EmailBody and ComposeEditor, so the test exercises prepareBody, frameDocument, the
// sandboxed frame and the reply/forward quoting as shipped.
import { createRoot, type Root } from "react-dom/client";
import { ComposeEditor } from "../src/components/ComposeEditor.tsx";
import { EmailBody } from "../src/components/EmailBody.tsx";
import { buildSeed, type ComposeKind } from "../src/lib/compose.ts";
import type { Message, ThreadDetail } from "../src/types.ts";

declare global {
  interface Window {
    mountMail: (message: Message) => void;
    mountComposer: (message: Message, kind: ComposeKind) => void;
  }
}

let root: Root | undefined;
const fresh = () => {
  root?.unmount();
  root = createRoot(document.getElementById("root")!);
  return root;
};

window.mountMail = (message) => fresh().render(<EmailBody message={message} />);

/** The editor a reply or forward opens in, seeded by the same buildSeed the app uses. */
window.mountComposer = (message, kind) => {
  const detail = { thread: { subject: message.subject }, messages: [message], draftId: null, sharedId: null } as unknown as ThreadDetail;
  const seed = buildSeed(detail, kind, new Set(["reader@fernpoint.co"]), "");
  fresh().render(
    <div id="composer">
      <ComposeEditor initialHtml={seed.bodyHtml} onLink={() => {}} />
    </div>,
  );
};
