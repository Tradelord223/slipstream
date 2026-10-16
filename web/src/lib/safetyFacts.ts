/**
 * What the "Privacy & safety" page tells people. Every line is something the code does, and the email
 * ones are checked by `npm run test:render` (scripts/test-render.mjs). docs/security.md has the longer version.
 * If you change how mail is shown, stored or sent to a model, change the matching line here.
 */
export interface SafetyFact {
  title: string;
  body: string;
}

export const safetyFacts: SafetyFact[] = [
  {
    title: "Nothing in an email can run code",
    body: "Every message is cleaned before you see it. Scripts, event handlers, forms, frames, plugins, SVG, audio and video are removed. Links can only be web, email or phone links, and images can't point at scripts or pages. Messages with their own design are shown inside a locked frame that is not allowed to run scripts at all.",
  },
  {
    title: "Images and tracking pixels are held back",
    body: "A picture stored on the sender's server tells them when, and from where, you opened the message. Slipstream doesn't fetch any of them until you ask: not images, not tiny tracking pixels, not backgrounds set by the message's styles. Pictures attached to the message itself still show, because they come from your own copy.",
  },
  {
    title: "You decide when to show images",
    body: "\"Show images\" applies to that message, for now. \"Always for this sender\" is saved in this browser's own storage. It isn't sent to the Slipstream server and isn't synced, so another browser or computer asks again. A setting under Settings lets you show images in all mail; it's off by default, and it is saved with your other settings on the Slipstream server.",
  },
  {
    title: "Allowing images still only allows pictures",
    body: "After you allow images, only pictures from secure (https) addresses load. Fonts, style sheets, frames, audio, video, scripts and plain http images never do. The sender can still see your IP address and the time you opened the message, which is why this is your choice.",
  },
  {
    title: "A second wall behind the cleaning",
    body: "Designed messages sit in a frame that can't run scripts, submit forms or move Slipstream to another page, and a strict content policy limits what it may load to inline styles, pictures attached to the message and, only if you allow it, https pictures. If the cleaning ever missed something, the browser would refuse it. In our tests it does: hidden style tricks that got past the cleaning were refused by the frame.",
  },
  {
    title: "Links open in a new tab and don't say where you came from",
    body: "Links open in a new tab that can't reach back into Slipstream, and the site you visit isn't told you came from your mail. Only web, email and phone links stay clickable. Slipstream doesn't rewrite or check where a link goes, so a link with the sender's tracking code in it still tells them you clicked.",
  },
  {
    title: "Attachments download instead of opening",
    body: "Attachments are saved to your computer as plain files, and the browser is told not to open or run them. The only exception is a plain picture (PNG, JPEG, GIF, WebP, AVIF or BMP) the sender placed inside the message. Slipstream doesn't scan attachments for viruses, so treat them as you would any download.",
  },
  {
    title: "Where your mail and keys live",
    body: "Slipstream's copy of your mail is kept on the computer or server running it, in its data folder (~/.slipstream by default), which only your user can read. Your mail provider keeps its own copy. Your messages, contacts, labels, drafts and attachments are stored as ordinary files and are not encrypted by Slipstream, so use your disk's own encryption. What is encrypted (AES-256-GCM): the sign-in tokens and passwords for your mail accounts, saved AI keys and sign-ins, and webhook secrets. The key sits in the same folder unless you set SLIPSTREAM_SECRET, so it protects a copied database, not a copied folder.",
  },
  {
    title: "What AI sees: nothing, unless you turn it on",
    body: "Slipstream sends no mail to any AI model until you add a key, sign in to a model, turn on Autopilot, or connect your own agent. Then it sends only what that feature needs, to the model you chose. Summaries and reply drafts send the conversation when you press the button. Autopilot sends each new message's sender, subject and opening text, and, when it drafts a reply, the conversation and samples of your earlier sent mail. The assistant and any routines you set up (they can run on a schedule or when new mail arrives) read mail through Slipstream within the permissions you gave them, and what they read goes to the model you picked. An agent you connect reads what its permissions allow. Nothing is ever sent to Slipstream's authors.",
  },
];
