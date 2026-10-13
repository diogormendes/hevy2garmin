// Side-effect and CSS-module imports (global.css, animated-icon.module.css) have no types of
// their own. Expo generates these declarations into the gitignored expo-env.d.ts on `expo
// start`, which a fresh checkout and CI never run before `tsc` (hevy2garmin#551).
declare module "*.css";
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
