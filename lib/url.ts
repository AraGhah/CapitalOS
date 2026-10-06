// Feed links end up as hrefs on the desk and as sources in the database, so
// only plain web links are kept: a javascript:, data: or file: "article" from
// a hostile feed entry is dropped.
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
