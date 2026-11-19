// a fully qualified name with any number of trailing dots resolves like the bare name, so comparisons must ignore all of them.
export function withoutTrailingDots(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}
