# Autopilot

Autopilot sorts new mail as it arrives. What needs you stays in your inbox. Receipts, notices and newsletters are labelled and cleared, things that matter later come back when they matter, and people waiting on you get a reply drafted in your voice for you to send.

Turn it on from **Autopilot** in the sidebar. It runs on the model you choose in [Models & accounts](models.md), except the managed cloud agent.

## What it does with each new message

1. **Your sender rules first.** "Always clear mail from `@news.example`" or "always keep `ana@example.com`" decide on their own, with no model.
2. **Everything else goes to the model, in batches** of up to 20 conversations. For each one it gets:
   - what Slipstream already knows from the headers: newsletter or notification, whether you've written to the sender before, whether you replied in the thread;
   - the latest message, marked as untrusted text.

   It records one decision per conversation:
   - **keep** (it needs you), **done** (clear it now) or **remind** (bring it back at a set time);
   - up to three of your labels;
   - priority (urgent / normal / low);
   - whether someone is waiting for your reply;
   - a one-line summary, a one-line reason you can check, and a confidence.
3. **Applying it.**
   - In **Auto** mode, confident decisions are carried out right away, as Autopilot: attributed in Activity and undoable like anything else.
   - In **Suggest** mode, they wait for you. Accept one, dismiss it, or accept them all.
4. **Replies.** For conversations where someone is waiting on you, Autopilot reads the thread and drafts a reply to the person who wrote. It matches how you write, which it learns from your sent mail, and your last replies to that person. It never sends.

Each message is processed once. A new reply in the conversation is a new message, so it gets a fresh look.

## Your rules

Write them in plain words in **Your rules**, for example:

> Receipts and order confirmations get "Receipts". Flights and hotels get "Travel".
> Mail from @kettleby.example is "Clients" and always stays in my inbox.
> Newsletters can go, except the Saltmarrow weekly.

Labels named in quotes may be created. Otherwise Autopilot uses only labels you already have.

## It learns from you

When you change something Autopilot did, that's kept as a correction: moving a conversation back to the inbox, adding or removing a label, or undoing it. Later batches see your recent corrections. When you correct the same sender the same way twice, Autopilot suggests a sender rule you can add with one click.

The page also shows how it's doing over the last 30 days:
- how much it sorted;
- how often you changed its mind;
- how many drafts you sent as written.

## What it can't do

Email is written by strangers, and some of it will try to steer an assistant. Autopilot's limits are enforced by Slipstream, not by asking the model nicely:

- **It can't send, forward or change settings.** Autopilot is its own agent with only read, triage and draft access.
- **Each run can touch only its own conversations.** A sorting run can read the conversations in its batch and record decisions about them, and nothing else. A drafting run can read its conversations and reply to them. The server refuses any other command or conversation.
- **Everything it does is reversible.** Done, remind and labels can all be undone, from the Autopilot page or from Activity.
- **Email text is fenced.** Messages are marked as data, never instructions, and their text can't pose as Slipstream's own markup.
- **Labels are checked.** Labels it invents are dropped unless your rules name them.
- **Replies go to who wrote.** Autopilot writes only the text. The server addresses each reply to the person who wrote, so an email can't add a recipient. Links in a draft that weren't in the conversation are flagged.
- **It has daily limits.** It stops for the day after 2 million tokens.
- **Low confidence waits for you.** A decision with low confidence is never applied automatically.

## Measuring it

`node scripts/eval-autopilot.ts --engine <engine>` runs Autopilot over a frozen, labelled set of messages, including prompt-injection attempts. It reports:

- action accuracy;
- needs-reply and per-label precision and recall;
- cost.

Any injection that gets through fails the run. Re-run it when you change models or rules. See [eval/README.md](../eval/README.md).
