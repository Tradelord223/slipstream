import type { Address, IncomingMessage, MailProvider, ProviderContext, RemoteAction, SyncPage } from "../mail/types.ts";
import { textToHtml } from "../lib/text.ts";

/**
 * A believable inbox for trying Slipstream without connecting anything.
 * Everyone and every company here is invented. Sending mail to a demo contact
 * gets you a reply a little later, so the whole loop can be felt offline.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const me: Address = { name: "Jordan Reyes", email: "jordan@fernpoint.co" };
const P = {
  sam: { name: "Sam Whitaker", email: "sam@fernpoint.co" },
  ines: { name: "Inès Moreau", email: "ines@fernpoint.co" },
  priya: { name: "Priya Raman", email: "priya.raman@kettlebyfreight.com" },
  dev: { name: "Devon Achebe", email: "devon@kettlebyfreight.com" },
  maya: { name: "Maya Okafor", email: "maya@oakhollow.vc" },
  theo: { name: "Theo Lindqvist", email: "theo@lumenridge.io" },
  lena: { name: "Lena Hart", email: "lena.hart@gmail.example" },
  rosa: { name: "Rosa Reyes", email: "rosa.reyes@hey.example" },
  marco: { name: "Marco Bellini", email: "marco@saltmarrow.com" },
  pinecrest: { name: "Pinecrest Air", email: "itinerary@pinecrestair.com" },
  bank: { name: "Quarrystone Bank", email: "no-reply@quarrystonebank.com" },
  tallyho: { name: "Tallyho Cloud", email: "billing@tallyho.cloud" },
  tallyAlerts: { name: "Tallyho Cloud Alerts", email: "alerts@tallyho.cloud" },
  tidewrack: { name: "Tidewrack", email: "letters@tidewrack.news" },
  saltmarrow: { name: "Saltmarrow Ceramics", email: "orders@saltmarrow.com" },
} satisfies Record<string, Address>;

interface Seed {
  key: string;
  subject: string;
  messages: {
    from: Address;
    to?: Address[];
    cc?: Address[];
    ago: number;
    text?: string;
    html?: string;
    unread?: boolean;
    attachments?: { filename: string; mimeType: string; size: number }[];
  }[];
  inbox?: boolean;
  starred?: boolean;
  bulk?: boolean;
  unsubscribe?: string;
  labels?: string[];
}

const newsletter = (issue: number, headline: string, items: [string, string][]) => `
<div style="max-width:560px;margin:0 auto;font-family:Georgia,serif;color:#1d2433">
  <p style="font:600 12px/1 -apple-system,sans-serif;letter-spacing:.04em;color:#7a8394">TIDEWRACK · ISSUE ${issue}</p>
  <h1 style="font-size:26px;line-height:1.2;margin:8px 0 16px">${headline}</h1>
  ${items
    .map(
      ([h, b]) => `<h3 style="font:600 16px/1.3 -apple-system,sans-serif;margin:20px 0 6px">${h}</h3><p style="font-size:15px;line-height:1.6;margin:0">${b}</p>`,
    )
    .join("")}
  <hr style="border:0;border-top:1px solid #e3e6ec;margin:28px 0 12px">
  <p style="font:12px -apple-system,sans-serif;color:#7a8394">You get Tidewrack because you signed up at tidewrack.news. <a href="https://tidewrack.news/unsubscribe">Unsubscribe</a>.</p>
</div>`;

const receipt = (title: string, rows: [string, string][], total: string, note: string) => `
<div style="max-width:520px;margin:0 auto;font-family:-apple-system,Segoe UI,sans-serif;color:#1b1f27">
  <h2 style="font-size:20px;margin:0 0 12px">${title}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    ${rows.map(([a, b]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #eceef2">${a}</td><td style="padding:8px 0;border-bottom:1px solid #eceef2;text-align:right">${b}</td></tr>`).join("")}
    <tr><td style="padding:10px 0;font-weight:600">Total</td><td style="padding:10px 0;text-align:right;font-weight:600">${total}</td></tr>
  </table>
  <p style="font-size:13px;color:#6b7280;margin-top:18px">${note}</p>
</div>`;

function seeds(): Seed[] {
  const list: Seed[] = [
    {
      key: "intro-theo",
      subject: "Intro: Jordan ↔ Theo (Lumenridge)",
      messages: [
        {
          from: P.maya,
          to: [me, P.theo],
          ago: 38 * MIN,
          unread: true,
          text: `Jordan, Theo — making the intro I promised.

Theo runs product at Lumenridge. They're rebuilding their analytics workspace and want a studio that can move from research to shipped UI without a handoff cliff. I told him that's exactly what Fernpoint does.

Jordan leads design at Fernpoint; they did the Kettleby dispatch tools I showed you last month.

I'll let you two take it from here.

Maya`,
        },
      ],
      inbox: true,
    },
    {
      key: "kettleby-r2",
      subject: "Dispatch dashboard — round 2 feedback",
      messages: [
        {
          from: me,
          to: [P.priya],
          cc: [P.sam],
          ago: 2 * DAY + 3 * HOUR,
          text: `Hi Priya,

Round 2 is up. Biggest changes: the load board now groups by lane, and exceptions float to the top with the reason inline.

Prototype link is in the Figma file. Would love your notes by Thursday.

Jordan`,
        },
        {
          from: P.priya,
          to: [me],
          cc: [P.sam, P.dev],
          ago: 52 * MIN,
          unread: true,
          text: `Jordan, this is a big step up. The lane grouping is exactly what the night shift asked for.

Three notes, also marked up in the attached PDF:

1. Exceptions: can we show how long a load has been stuck, not just that it's stuck?
2. The driver column truncates at 1280px. Our dispatch monitors are mostly 1366 wide.
3. Devon wants a keyboard shortcut to reassign a load. They live in this screen for 10 hours.

Can we walk through it Thursday at 10?

Priya`,
          attachments: [{ filename: "dispatch-r2-markup.pdf", mimeType: "application/pdf", size: 2_481_233 }],
        },
      ],
      inbox: true,
      starred: true,
      labels: ["Clients"],
    },
    {
      key: "sprint-deck",
      subject: "Sprint review deck",
      messages: [
        { from: P.sam, to: [me], ago: 5 * HOUR, text: "Draft deck is in the shared drive. I kept it to 9 slides. Can you sanity-check the Lumenridge pitch slide before I send it to Inès?" },
        { from: me, to: [P.sam], ago: 4 * HOUR + 20 * MIN, text: "Looks good. Swap slide 6 and 7 so the before/after lands before the timeline. Otherwise ship it." },
        { from: P.sam, to: [me], cc: [P.ines], ago: 3 * HOUR + 5 * MIN, text: "Done, and looped in Inès. Inès — final version is in the drive, 9 slides, ready for Friday." },
        {
          from: P.ines,
          to: [P.sam, me],
          ago: 1 * HOUR + 40 * MIN,
          unread: true,
          text: "Thanks both. One ask: can we add the Kettleby numbers (dispatch time down 31%) to the case study slide? That's the line clients remember.",
        },
      ],
      inbox: true,
      labels: ["Team"],
    },
    {
      key: "onboarding-copy",
      subject: "Can you review the onboarding copy?",
      messages: [
        {
          from: P.sam,
          to: [me],
          ago: 25 * MIN,
          unread: true,
          text: `Quick one — I rewrote the empty states for the Kettleby onboarding flow. Mostly cutting words.

"No loads yet" → "Loads you dispatch will show up here."
"Error: lane not found" → "We couldn't find that lane. Check the origin and destination codes."

Good to go, or do you want another pass?`,
        },
      ],
      inbox: true,
    },
    {
      key: "coffee",
      subject: "Coffee next week?",
      messages: [
        {
          from: P.lena,
          to: [me],
          ago: 3 * HOUR,
          unread: true,
          text: "Hey Jordan! I'm in town Tuesday through Thursday next week. Coffee at the usual place? Mornings are best for me.\n\nLena",
        },
      ],
      inbox: true,
    },
    {
      key: "dinner",
      subject: "Sunday dinner",
      messages: [
        {
          from: P.rosa,
          to: [me],
          ago: 7 * HOUR,
          text: "Mija, Sunday at 6? Your tío is bringing the good bread. Tell me if you're bringing anyone so I can set the table.\n\nTe quiero,\nMamá",
        },
      ],
      inbox: true,
    },
    {
      key: "flight",
      subject: "Your trip to Lisbon is confirmed · PA 2817",
      bulk: true,
      messages: [
        {
          from: P.pinecrest,
          to: [me],
          ago: 9 * HOUR,
          html: receipt(
            "You're going to Lisbon",
            [
              ["Flight", "PA 2817 · Thu Nov 12"],
              ["Departs", "Boston 7:40 PM"],
              ["Arrives", "Lisbon 7:05 AM (+1)"],
              ["Seat", "14A · Window"],
              ["Confirmation", "QK7PZM"],
            ],
            "$684.20",
            "Check in opens 24 hours before departure. Bring the card you paid with.",
          ),
        },
      ],
      inbox: true,
      labels: ["Travel"],
    },
    {
      key: "tallyho-invoice",
      subject: "Your Tallyho Cloud invoice for October",
      bulk: true,
      messages: [
        {
          from: P.tallyho,
          to: [me],
          ago: 11 * HOUR,
          html: receipt(
            "Invoice TC-20931",
            [
              ["Team plan · 4 seats", "$96.00"],
              ["Build minutes (overage)", "$12.40"],
              ["Preview deployments", "$0.00"],
            ],
            "$108.40",
            "Charged to the card ending 4417. Questions? Reply to this email.",
          ),
        },
      ],
      inbox: true,
    },
    {
      key: "alert-build",
      subject: "Build failed: fernpoint/site on main",
      bulk: true,
      messages: [
        {
          from: P.tallyAlerts,
          to: [me],
          ago: 2 * HOUR,
          unread: true,
          text: "Build #1482 failed on main (commit 9f2e1c4 by Sam Whitaker).\n\nStep: build\nError: Cannot find module './case-studies/kettleby.mdx'\n\nView logs: https://tallyho.cloud/fernpoint/site/builds/1482",
        },
      ],
      inbox: true,
    },
    {
      key: "bank",
      subject: "Your September statement is ready",
      bulk: true,
      messages: [
        {
          from: P.bank,
          to: [me],
          ago: 1 * DAY + 2 * HOUR,
          text: "Your statement for the account ending 0921 is ready. Sign in to Quarrystone online banking to view it.\n\nThis mailbox isn't monitored.",
        },
      ],
      inbox: true,
    },
    {
      key: "tidewrack-212",
      subject: "Tools that get out of the way",
      bulk: true,
      unsubscribe: "<https://tidewrack.news/unsubscribe>",
      messages: [
        {
          from: P.tidewrack,
          to: [me],
          ago: 13 * HOUR,
          unread: true,
          html: newsletter(212, "Tools that get out of the way", [
            ["The case for boring software", "The best tools disappear. You stop noticing them the way you stop noticing a good chair."],
            ["Keyboard-first is back", "A wave of apps is betting that speed is a feature you feel in your hands, not on a spec sheet."],
            ["Local-first, for real this time", "Sync engines matured. Your data can live on your machine and still follow you around."],
          ]),
        },
      ],
      inbox: true,
    },
    {
      key: "saltmarrow-ship",
      subject: "Your order has shipped",
      bulk: true,
      unsubscribe: "<mailto:unsubscribe@saltmarrow.com>",
      messages: [
        {
          from: P.saltmarrow,
          to: [me],
          ago: 1 * DAY + 6 * HOUR,
          html: receipt(
            "Order #SM-4471 is on its way",
            [
              ["Speckled mug, oat glaze × 2", "$68.00"],
              ["Serving bowl, tide blue", "$84.00"],
              ["Shipping", "$9.00"],
              ["Carrier", "Tidewell Parcel"],
              ["Tracking number", "TWP4471903382"],
            ],
            "$161.00",
            "Each piece is thrown by hand, so yours will be a little different from the photo. That's the point.",
          ),
        },
      ],
      inbox: true,
    },
    {
      key: "saltmarrow-out",
      subject: "Out for delivery today",
      bulk: true,
      unsubscribe: "<mailto:unsubscribe@saltmarrow.com>",
      messages: [
        {
          from: P.saltmarrow,
          to: [me],
          ago: 3 * HOUR,
          unread: true,
          text: "Your Saltmarrow order #SM-4471 is out for delivery and should reach you today by 6 PM.\n\nCarrier: Tidewell Parcel\nTracking number: TWP4471903382\n\nIf nobody is home, the driver will leave the box with a neighbor or in a shaded spot by the door.",
        },
      ],
      inbox: true,
    },
    {
      key: "bank-code",
      subject: "Your Quarrystone sign-in code",
      bulk: true,
      messages: [
        {
          from: P.bank,
          to: [me],
          ago: 2 * MIN,
          unread: true,
          text: "Your Quarrystone verification code is 618204.\n\nIt expires in 10 minutes. If you didn't try to sign in, ignore this message and your account stays as it is.\n\nQuarrystone will never ask you to read this code to anyone.",
        },
      ],
      inbox: true,
    },
    {
      key: "alert-signin",
      subject: "New sign-in to your Tallyho Cloud account",
      bulk: true,
      messages: [
        {
          from: P.tallyAlerts,
          to: [me],
          ago: 40 * MIN,
          unread: true,
          text: "We noticed a new sign-in to your Tallyho Cloud account.\n\nDevice: Firefox on Windows\nPlace: Denver, Colorado\n\nIf this was you, there's nothing to do. If it wasn't, reset your password and we'll sign out every other device.",
        },
      ],
      inbox: true,
    },
    {
      key: "lease-deadline",
      subject: "Studio lease renewal: deadline tomorrow",
      messages: [
        {
          from: P.sam,
          to: [me],
          ago: 1 * HOUR + 10 * MIN,
          unread: true,
          text: `Jordan, the landlord just emailed. The renewal paperwork has to be back to them by 5 PM tomorrow, or the lease rolls to month-to-month at a higher rate.

I've signed my pages. Yours is the last one. Can you sign tonight?

Sam`,
        },
      ],
      inbox: true,
    },
    {
      key: "kettleby-kickoff",
      subject: "Invitation: Kettleby review · Thu 10:00–10:45",
      messages: [
        {
          from: P.dev,
          to: [me, P.priya, P.sam],
          ago: 30 * MIN,
          unread: true,
          text: "Devon Achebe invited you to Kettleby review.\n\nThursday 10:00–10:45 AM (Eastern)\nVideo call link in the calendar event.\n\nAgenda: round 2 markup, exception timers, reassign shortcut.",
        },
      ],
      inbox: true,
      labels: ["Clients"],
    },
    {
      key: "marco",
      subject: "Studio mugs for the Fernpoint office",
      messages: [
        {
          from: P.marco,
          to: [me],
          ago: 2 * DAY + 8 * HOUR,
          text: "Hi Jordan, following up on the custom mugs. We can do 12 with the Fernpoint mark pressed into the base. Lead time is about five weeks. Want me to send a glaze card?\n\nMarco\nSaltmarrow Ceramics",
        },
        {
          from: me,
          to: [P.marco],
          ago: 2 * DAY + 5 * HOUR,
          text: "Yes please, send the glaze card. Leaning toward the oat or the tide blue.",
        },
      ],
      inbox: false,
    },
    {
      key: "lumenridge-old",
      subject: "Lumenridge workspace research notes",
      messages: [
        {
          from: P.ines,
          to: [me],
          ago: 9 * DAY,
          text: "Notes from the three Lumenridge user calls attached. Common thread: analysts export to spreadsheets because filtering in the product is slow. That's our opening.",
          attachments: [{ filename: "lumenridge-calls.md", mimeType: "text/markdown", size: 18_220 }],
        },
      ],
      inbox: false,
      labels: ["Research"],
    },
  ];

  // Older mail so search, Done and scrolling have something to chew on.
  const topics: [string, string][] = [
    ["Why we stopped estimating in points", "Teams that ship weekly don't argue about sizes; they argue about scope."],
    ["The quiet return of the desktop app", "Native speed is a feature users notice even when they can't name it."],
    ["Design systems are products", "If nobody owns it, it rots. Treat your system like something with customers."],
    ["Fewer meetings, better notes", "Write it down once, link it forever."],
    ["The inbox is a to-do list you didn't write", "Triage is a skill. So is ignoring things on purpose."],
    ["On taste", "Taste is mostly saying no to good ideas that don't fit."],
  ];
  for (let i = 0; i < 24; i++) {
    const [h, b] = topics[i % topics.length]!;
    list.push({
      key: `tidewrack-${211 - i}`,
      subject: h,
      bulk: true,
      unsubscribe: "<https://tidewrack.news/unsubscribe>",
      messages: [{ from: P.tidewrack, to: [me], ago: (i + 1) * 7 * DAY + 13 * HOUR, html: newsletter(211 - i, h, [[h, b]]) }],
      inbox: false,
    });
  }
  for (let i = 0; i < 12; i++) {
    list.push({
      key: `invoice-${i}`,
      subject: `Your Tallyho Cloud invoice for ${new Date(Date.now() - (i + 1) * 30 * DAY).toLocaleString("en-US", { month: "long" })}`,
      bulk: true,
      messages: [
        {
          from: P.tallyho,
          to: [me],
          ago: (i + 1) * 30 * DAY,
          html: receipt(`Invoice TC-${20930 - i}`, [["Team plan · 4 seats", "$96.00"]], "$96.00", "Charged to the card ending 4417."),
        },
      ],
      inbox: false,
    });
  }
  const chatter: [Address, string, string][] = [
    [P.sam, "Font licensing for the Kettleby app", "We're covered for desktop and web. Mobile embedding needs the app add-on, about $240/yr."],
    [P.ines, "Q4 hiring plan", "Two roles: a senior product designer and a design engineer. Draft JD in the drive."],
    [P.priya, "Kettleby: night shift interviews", "Booked four drivers and two dispatchers for Tuesday night. Bring snacks, they insisted."],
    [P.dev, "Load board export format", "CSV is fine but we need the lane code as its own column."],
    [P.maya, "Oakhollow portfolio day", "Would love Fernpoint to give a 10-minute talk on design debt. Interested?"],
    [P.sam, "Retro notes", "Went well: shipping the lane grouping early. Didn't: three rounds on the color of one badge."],
    [P.lena, "Photos from the lake", "Finally uploaded them. The one of the dog mid-jump is the best photo I've ever taken."],
    [P.rosa, "Recipe you asked for", "Arroz con pollo. The secret is the sofrito, and patience."],
    [P.theo, "Re: analytics benchmarks", "Our p95 filter time is 4.1s. Analysts have learned to go get coffee."],
    [P.marco, "Glaze card", "Mailed it Tuesday. The oat is warmer in person."],
  ];
  chatter.forEach(([from, subject, text], i) => {
    list.push({
      key: `old-${i}`,
      subject,
      messages: [
        { from, to: [me], ago: (i + 3) * 4 * DAY + i * HOUR, text },
        { from: me, to: [from], ago: (i + 3) * 4 * DAY + i * HOUR - 2 * HOUR, text: "Thanks — makes sense. Let's go with that." },
      ],
      inbox: false,
    });
  });
  return list;
}

const REPLIES = [
  "Thanks, Jordan — that works for me.",
  "Perfect. I'll take it from here.",
  "Got it, appreciate the quick turnaround!",
  "Sounds good. Talk soon.",
];

export class DemoProvider implements MailProvider {
  readonly kind = "demo" as const;
  private queued: IncomingMessage[] = [];
  private counter = 0;

  private ctx: ProviderContext;

  constructor(ctx: ProviderContext) {
    this.ctx = ctx;
  }

  async sync(cursor: string | null): Promise<SyncPage> {
    if (cursor === null) return { messages: this.initial(), cursor: "1", done: true };
    const now = Date.now();
    const due = this.queued.filter((m) => m.sentAt <= now);
    this.queued = this.queued.filter((m) => m.sentAt > now);
    return { messages: due, cursor: String(Number(cursor) + 1), done: true };
  }

  async apply(action: RemoteAction): Promise<{ remoteId?: string } | void> {
    if (action.kind !== "send") return;
    const msg = action.message;
    const remoteId = `demo-sent-${Date.now()}-${this.counter++}`;
    // Demo contacts write back, so sending, threads and reminders can be tried end to end.
    const contact = [...msg.to, ...msg.cc].find((a) => a.email.toLowerCase() !== me.email && a.email.includes("@"));
    if (contact) {
      const known = Object.values(P).find((p) => p.email === contact.email.toLowerCase());
      const reply = REPLIES[this.counter % REPLIES.length]!;
      const sentAt = Date.now() + 20_000 + Math.random() * 20_000;
      this.queued.push({
        remoteId: `demo-reply-${sentAt}`,
        remoteThreadId: msg.threadRemoteId,
        messageIdHeader: `<reply.${sentAt}@demo.slipstream>`,
        inReplyTo: msg.messageIdHeader,
        references: [...(msg.references ?? []), msg.messageIdHeader],
        from: known ?? contact,
        to: [me],
        cc: [],
        bcc: [],
        subject: msg.subject.startsWith("Re:") ? msg.subject : `Re: ${msg.subject}`,
        sentAt,
        bodyText: `${reply}\n\n${(known ?? contact).name.split(" ")[0] ?? ""}`,
        bodyHtml: textToHtml(`${reply}\n\n${(known ?? contact).name.split(" ")[0] ?? ""}`),
        unread: true,
        starred: false,
        folders: { inbox: true, sent: false, trash: false, spam: false },
        attachments: [],
      });
    }
    return { remoteId };
  }

  private initial(): IncomingMessage[] {
    const now = Date.now();
    const out: IncomingMessage[] = [];
    for (const s of seeds()) {
      let prev: string | undefined;
      const refs: string[] = [];
      s.messages.forEach((m, i) => {
        const msgId = `<${s.key}.${i}@demo.slipstream>`;
        const outgoing = m.from.email === me.email;
        out.push({
          remoteId: `${s.key}-${i}`,
          remoteThreadId: s.key,
          messageIdHeader: msgId,
          inReplyTo: prev,
          references: [...refs],
          from: m.from,
          to: m.to ?? [me],
          cc: m.cc ?? [],
          bcc: [],
          subject: i === 0 ? s.subject : `Re: ${s.subject}`,
          sentAt: now - m.ago,
          bodyText: m.text ?? "",
          bodyHtml: m.html ?? (m.text ? textToHtml(m.text) : undefined),
          unread: Boolean(m.unread),
          starred: Boolean(s.starred),
          folders: { inbox: Boolean(s.inbox) && !outgoing, sent: outgoing, trash: false, spam: false },
          labels: s.labels?.map((l) => ({ remoteId: `label:${l}`, name: l })),
          bulk: s.bulk,
          listUnsubscribe: s.unsubscribe,
          outgoing,
          attachments: (m.attachments ?? []).map((a) => ({ ...a, inline: false })),
        });
        refs.push(msgId);
        prev = msgId;
      });
      // Threads that end with my message still belong in the inbox when flagged so.
      if (s.inbox) for (const m of out.filter((x) => x.remoteThreadId === s.key)) m.folders.inbox = true;
    }
    return out;
  }
}

export const DEMO_IDENTITY = me;
