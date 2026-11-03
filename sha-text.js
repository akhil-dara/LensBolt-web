// A file's SHA-256 as both pages show it (the sender under each file's name, the receiver on its Done screen and in a
// batch's rows): 64 hex digits in groups of four, monospace, with Copy; a screen reader hears it group by group, each
// character on its own. A module of its own for the node tests; the single-file builds inline it.

/** A SHA-256 (64 hex digits) in groups of four, lower case: ['9f86', 'd081', ...]; [] for anything else. */
export function shaGroups(hex) {
  return typeof hex === 'string' && /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase().match(/.{4}/g) : [];
}
/** The groups as the screen shows them: four characters, a space between groups. */
export function shaShown(hex) { return shaGroups(hex).join(' '); }
/** What a screen reader says: "SHA-256: 9 f 8 6, d 0 8 1, …" (each character apart, a pause between groups). */
export function shaSpoken(hex) {
  const g = shaGroups(hex);
  return g.length ? `SHA-256: ${g.map((x) => x.split('').join(' ')).join(', ')}` : '';
}
/** The groups as both pages and the app lay them out: two lines of eight, each line two quarters of four groups that
 *  never break inside (so a narrow screen shows four groups a line, never 6 + 6 + 4). [['ba78 16bf 8f01 cfea',
 *  '4141 40de 5dae 2223'], [...]]; [] for anything that is not a SHA-256. */
export function shaRows(hex) {
  const g = shaGroups(hex);
  return g.length ? [0, 8].map((at) => [g.slice(at, at + 4).join(' '), g.slice(at + 4, at + 8).join(' ')]) : [];
}
/** `el` filled with shaRows(hex) (its text stays shaShown(hex): the groups with a space between each). */
export function shaLines(el, hex) {
  el.textContent = '';
  shaRows(hex).forEach((line, i) => {
    const l = document.createElement('span'); l.className = 'l';
    line.forEach((q, k) => { const s = document.createElement('span'); s.className = 'q'; s.textContent = q; l.append(s); if (k === 0 || i === 0) l.append(' '); });
    el.append(l);
  });
}
