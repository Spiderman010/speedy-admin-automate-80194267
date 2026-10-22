import "@testing-library/jest-dom";
import { afterAll, afterEach, expect } from "vitest";
import { assertNoBlockedNetworkAttempts, installNetworkGuard } from "./support/network-guard";

// Tests draaien offline: fetch, XMLHttpRequest en WebSocket naar een host die
// geen loopback is, falen hard en worden gelogd (zie support/network-guard.ts).
installNetworkGuard({ currentTest: () => expect.getState().currentTestName });

// Ook als de code onder test de fout van de wacht zelf opvangt, faalt de test.
afterEach(() => assertNoBlockedNetworkAttempts("in deze test"));
afterAll(() => assertNoBlockedNetworkAttempts("buiten een test (bijv. bij het laden van het bestand)"));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
