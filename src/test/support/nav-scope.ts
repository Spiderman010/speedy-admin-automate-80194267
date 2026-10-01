import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { NAV_SECTIONS } from "@/components/layout/nav";

/**
 * Eén gedeelde regel voor wat een branch met de navigatie mag doen.
 *
 * WAAROM DIT BESTAAT
 * Zeven testbestanden legden vast: "nav.ts staat niet in de diff van deze
 * branch". Dat was waar over elke PR die een subpagina toevoegde, maar het is
 * geen INVARIANT: een latere PR die terecht een eigen hoofdbestemming
 * meebrengt (de Review-werkbank) laat al die asserties tegelijk omvallen,
 * terwijl er met de subpagina's niets mis is. Hetzelfde patroon als
 * `branch-sql-scope.ts` voor SQL.
 *
 * WAT ZIJ WERKELIJK BESCHERMDEN
 * Subpagina's (`/grootboek/mutaties`, `/bank/inhaalslag`,
 * `/overzichten/proef-saldibalans`, …) hangen onder hun bestaande nav-item
 * via prefix-matching en krijgen géén eigen nav-item; en de navigatie wijst
 * nooit naar een route die niet bestaat. Dat blijft hier bewaakt, ongeacht
 * welke branch nav.ts aanraakt.
 */
export function assertNavKeepsSubpagesNested(subpaths: readonly string[] = []): void {
  const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
  const urls = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.url));
  for (const url of urls) {
    // Elk nav-item is een hoofdbestemming: één padsegment (of "/").
    expect(url, `nav-item ${url} is een subpagina`).toMatch(/^\/[^/]*$/);
    expect(app, `nav-item ${url} heeft geen route`).toContain(`path="${url}"`);
  }
  for (const sub of subpaths) {
    expect(urls, `${sub} hoort geen eigen nav-item te hebben`).not.toContain(sub);
    expect(
      urls.some((url) => url !== "/" && sub.startsWith(`${url}/`)),
      `${sub} hangt onder geen enkel nav-item`,
    ).toBe(true);
  }
}
