// Ambient module declarations for @autonoma-ai/* packages so apps/web
// (moduleResolution: "node") can resolve their types. Runtime resolution
// happens at bundle time via package.json "exports".

declare module "@autonoma-ai/sdk" {
  export * from "@autonoma-ai/sdk/dist/index.js";
  export type { FactoryContext } from "@autonoma-ai/sdk/dist/index.js";
}
declare module "@autonoma-ai/sdk-prisma" {
  export * from "@autonoma-ai/sdk-prisma/dist/index.js";
}
declare module "@autonoma-ai/server-web" {
  export * from "@autonoma-ai/server-web/dist/index.js";
}
