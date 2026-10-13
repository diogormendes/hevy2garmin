// https://docs.expo.dev/guides/using-eslint/
// The flat config `expo lint` reads; committed so CI and a fresh checkout see the same rules.
// CI runs `npx eslint . --max-warnings 0`.
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

// The underscore prefix marks an intentionally unused parameter or binding.
const overrides = {
  "@typescript-eslint/no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
  ],
};

// A rule may only be tuned inside a config object that registers its plugin, so the overrides
// are merged into the Expo objects that own them instead of appended as a new object.
const tuned = (Array.isArray(expoConfig) ? expoConfig : [expoConfig]).map((o) => {
  if (!o.plugins) return o;
  const rules = { ...(o.rules ?? {}) };
  for (const [rule, level] of Object.entries(overrides)) {
    const prefix = rule.slice(0, rule.lastIndexOf("/"));
    if (prefix in o.plugins) rules[rule] = level;
  }
  return { ...o, rules };
});

module.exports = defineConfig([...tuned, { ignores: ["dist/*", ".expo/*", "node_modules/*"] }]);
