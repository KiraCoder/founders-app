/**
 * Company URL slugs. Pure (no server or React imports) so the add form can preview the
 * slug while typing and the service (src/server/services/companies.ts) uses the same rule.
 */

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ң: "ng", ө: "o", ү: "u", ә: "a", қ: "q", ғ: "gh", һ: "h", і: "i",
};

export const SLUG_MAX = 48;
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** URL slug from a company name: transliterates Cyrillic, lowercase, a-z 0-9 and hyphens. */
export function slugifyCompanyName(name: string): string {
  const latin = [...name.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join("");
  const slug = latin
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : slug ? `${slug}-co` : "company";
}

