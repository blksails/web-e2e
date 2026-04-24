import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export interface A11yOptions {
  /** WCAG tags to include. Default: 2.1a + 2.1aa + best-practice. */
  tags?: string[];
  /** CSS selectors to exclude (e.g. vendor iframes). */
  exclude?: string[];
  /**
   * Violations we knowingly accept for now (noise-reducer). Each entry is an axe rule id.
   * Keep this list short and tracked; document why each is deferred in docs/A11Y.md.
   */
  allowedViolations?: string[];
}

const DEFAULT_TAGS = ['wcag21a', 'wcag21aa', 'best-practice'];

/**
 * Run axe-core against the current page and assert no critical violations.
 * For use inside any spec that wants a baseline accessibility check.
 */
export async function assertNoA11yViolations(page: Page, opts: A11yOptions = {}): Promise<void> {
  const { tags = DEFAULT_TAGS, exclude = [], allowedViolations = [] } = opts;

  let builder = new AxeBuilder({ page }).withTags(tags);
  for (const sel of exclude) {
    builder = builder.exclude(sel);
  }

  const { violations } = await builder.analyze();
  const critical = violations.filter(
    (v) => (v.impact === 'serious' || v.impact === 'critical') && !allowedViolations.includes(v.id),
  );

  if (critical.length > 0) {
    const summary = critical
      .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'}) → ${v.helpUrl}`)
      .join('\n');
    expect(critical, `axe-core found ${critical.length} serious/critical violation(s):\n${summary}`).toEqual([]);
  }
}
