import type { IncomingMessage } from "../mail/types.ts";

/** Placeholder until the importer lands: yields messages from an .mbox or .eml file. */
export async function* readMailFile(_path: string, _filename: string, _selfEmail?: string): AsyncGenerator<IncomingMessage> {
  throw new Error("Import is not implemented yet");
}
