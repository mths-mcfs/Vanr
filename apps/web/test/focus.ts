// Focus as a browser moves it, where the test DOM does not.

/**
 * As a browser does and the test DOM doesn't: a control that becomes disabled while it has the focus
 * loses it to the page. Returns the function that stops it.
 */
export function blurOnDisable(): () => void {
  const watch = new MutationObserver((changes) => {
    for (const { target } of changes) {
      if (
        !(target instanceof HTMLElement) ||
        target !== document.activeElement ||
        !target.hasAttribute("disabled")
      )
        continue;
      // The test DOM won't blur a disabled control: lift the attribute for the blur only.
      target.removeAttribute("disabled");
      target.blur();
      target.setAttribute("disabled", "");
    }
  });
  watch.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
  return () => watch.disconnect();
}
