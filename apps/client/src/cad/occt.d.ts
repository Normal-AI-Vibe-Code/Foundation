// occt-import-js ships no types; model.ts narrows what it returns.
declare module "occt-import-js" {
  const init: (options?: { locateFile?: (file: string) => string }) => Promise<unknown>;
  export default init;
}
