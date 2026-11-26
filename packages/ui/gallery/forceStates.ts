// Gallery only. Copies every rule that styles :hover, :focus-visible or :active into a rule keyed
// on [data-gallery-state], inside the same cascade layer, so the States page can pin an element
// in a pointer state using the package's real CSS instead of a hand-written imitation.
const STATES: Array<[pseudo: RegExp, attribute: string]> = [
  [/:hover/g, '[data-gallery-state~="hover"]'],
  [/:focus-visible/g, '[data-gallery-state~="focus"]'],
  [/:active/g, '[data-gallery-state~="active"]'],
];

function rewrite(selector: string): string | null {
  let out = selector;
  for (const [pseudo, attribute] of STATES) out = out.replace(pseudo, attribute);
  return out === selector ? null : out;
}

function visit(list: CSSRuleList, owner: CSSStyleSheet | CSSGroupingRule): void {
  // Walk backwards so inserted rules do not shift the indexes still to visit.
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i];
    if (rule instanceof CSSStyleRule) {
      const selector = rewrite(rule.selectorText);
      if (selector !== null) owner.insertRule(`${selector} { ${rule.style.cssText} }`, i + 1);
    } else if (rule instanceof CSSGroupingRule) {
      visit(rule.cssRules, rule);
    }
  }
}

const done = new WeakSet<CSSStyleSheet>();

export function mirrorPointerStates(): void {
  for (const sheet of Array.from(document.styleSheets)) {
    if (done.has(sheet)) continue;
    done.add(sheet);
    try {
      visit(sheet.cssRules, sheet);
    } catch {
      // Cross-origin sheets (none expected) cannot be read.
    }
  }
}
