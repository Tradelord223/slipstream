/** Copy text; falls back to a hidden textarea where the async clipboard is unavailable (plain http, older browsers). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/**
 * Copy text that still has to be fetched. Browsers only allow a copy right after a click, and a fetch can outlast
 * that, so where supported the clipboard is handed the pending text instead of waiting for it. A failed fetch
 * rejects with its own error.
 */
export async function copyPending(pending: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    pending.catch(() => undefined);
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": pending.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return true;
    } catch {
      /* the fetch failed (thrown again below) or the clipboard refused; try the plain route */
    }
  }
  return copyText(await pending);
}
