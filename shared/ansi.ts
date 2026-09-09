/**
 * Remove terminal colour and cursor sequences from text.
 *
 * Commands that expect a terminal write them unasked, and this app draws HTML: left in, an
 * escape appears as its own characters in the middle of the text it was meant to colour.
 * Matches the CSI and OSC forms, which is everything the CLI's own output uses.
 *
 * Shared because two paths need it and they must not drift: the sidecar strips what a slash
 * command hands back, and the transcript strips what a tool call reports - the latter also
 * covering a log replayed from disk, which the sidecar never sees again.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '');
}
