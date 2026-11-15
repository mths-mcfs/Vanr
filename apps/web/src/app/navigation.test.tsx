// Navigating by route id: a component may only move the person while it is on screen.
import { describe, expect, test } from "bun:test";
import { RouterContextProvider } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { newTestRuntime } from "../../test/app.tsx";
import { useGo, useGoToAddress } from "./navigation.tsx";

type Moves = { go: ReturnType<typeof useGo>; goToAddress: ReturnType<typeof useGoToAddress> };

function mount() {
  const { runtime } = newTestRuntime({ path: "/login" });
  let moves: Moves | undefined;
  function Probe() {
    moves = { go: useGo(), goToAddress: useGoToAddress() };
    return null;
  }
  const view = render(
    <RouterContextProvider router={runtime.router}>
      <Probe />
    </RouterContextProvider>,
  );
  if (moves === undefined) throw new Error("the probe did not render");
  return { ...moves, view, path: () => runtime.router.state.location.pathname };
}

describe("navigating from a component", () => {
  test("works while the component is on screen, by route id and by address", async () => {
    const probe = mount();
    await act(() => probe.go("forgotPassword", {}));
    expect(probe.path()).toBe("/forgot-password");
    await act(() => probe.goToAddress("/signup?email=mel%40birchwood.example"));
    expect(probe.path()).toBe("/signup");
  });

  test("does nothing once the component left the screen", async () => {
    const probe = mount();
    probe.view.unmount();
    await act(() => probe.go("forgotPassword", {}));
    await act(() => probe.goToAddress("/signup"));
    expect(probe.path()).toBe("/login");
  });

  test("an address that is not one inside the web is ignored, not thrown", async () => {
    const probe = mount();
    for (const address of ["/invite/%", "//evil.example", "https://evil.example/x", "signup", ""]) {
      await act(() => probe.goToAddress(address));
    }
    expect(probe.path()).toBe("/login");
  });
});
