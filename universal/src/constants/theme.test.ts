import { describe, it, expect, vi } from "vitest";

import { Colors, Fonts } from "./theme";

// react-native ships Flow sources that Vite cannot parse; Platform.select is all theme.ts needs.
// vi.mock is hoisted above the imports by vitest, so the import order above is fine.
vi.mock("react-native", () => ({
  Platform: { select: (o: Record<string, unknown>) => o.default ?? o.web },
}));

describe("theme", () => {
  it("light and dark define the same colour keys, so ThemeColor names both", () => {
    expect(Object.keys(Colors.light).sort()).toEqual(Object.keys(Colors.dark).sort());
  });

  it("every colour is a six-digit hex", () => {
    for (const scheme of [Colors.light, Colors.dark]) {
      for (const [name, value] of Object.entries(scheme)) {
        expect(value, name).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("the default font set names a sans, serif, rounded and mono face", () => {
    expect(Object.keys(Fonts ?? {}).sort()).toEqual(["mono", "rounded", "sans", "serif"]);
  });
});
