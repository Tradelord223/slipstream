/**
 * Invented marks for the demo mailbox's senders, so the demo shows logos without any network call.
 * Plain geometry in one color each; none of them spells or imitates a real brand.
 */
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;

export const DEMO_LOGOS: Record<string, string> = {
  // Two waves under a sun-bleached disc.
  "saltmarrow.com": svg(
    `<rect width="64" height="64" rx="14" fill="#0E7C86"/><circle cx="32" cy="22" r="8" fill="#F4E3B1"/><path d="M8 40q8-8 16 0t16 0 16 0v6q-8-8-16 0t-16 0-16 0z" fill="#F4F1EA"/><path d="M8 50q8-8 16 0t16 0 16 0v6H8z" fill="#F4F1EA" opacity=".6"/>`,
  ),
  // A pillar of stacked blocks.
  "quarrystonebank.com": svg(
    `<rect width="64" height="64" rx="14" fill="#2B3A55"/><rect x="18" y="14" width="28" height="9" rx="2" fill="#C9D4E8"/><rect x="18" y="27" width="28" height="9" rx="2" fill="#9FB0CF"/><rect x="18" y="40" width="28" height="9" rx="2" fill="#7189B5"/>`,
  ),
  // A tide line through a folded page.
  "tidewrack.news": svg(
    `<rect width="64" height="64" rx="14" fill="#E4572E"/><path d="M16 14h32v36H16z" fill="#FFF6EE"/><path d="M16 36q4-5 8 0t8 0 8 0 8 0v14H16z" fill="#E4572E" opacity=".85"/>`,
  ),
  // A pine silhouette with a wing line.
  "pinecrestair.com": svg(
    `<rect width="64" height="64" rx="14" fill="#1F6F4A"/><path d="M32 10l12 16h-6l10 14H38v10h-12V40H16l10-14h-6z" fill="#E7F3EA"/><path d="M8 52l48-12" stroke="#F2C14E" stroke-width="3" stroke-linecap="round" fill="none"/>`,
  ),
  // A cloud made of three circles with a tally bar.
  "tallyho.cloud": svg(
    `<rect width="64" height="64" rx="14" fill="#6A4BC4"/><circle cx="24" cy="30" r="9" fill="#EDE7FF"/><circle cx="36" cy="26" r="11" fill="#EDE7FF"/><circle cx="44" cy="34" r="8" fill="#EDE7FF"/><rect x="16" y="34" width="36" height="9" rx="4.5" fill="#EDE7FF"/><path d="M24 50v4M32 50v4M40 50v4" stroke="#FFD166" stroke-width="3" stroke-linecap="round"/>`,
  ),
};
