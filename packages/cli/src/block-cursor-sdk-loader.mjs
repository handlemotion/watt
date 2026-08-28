export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@cursor/sdk" || specifier.startsWith("@cursor/sdk/")) {
    throw new Error("@cursor/sdk must not resolve on a non-agent CLI path");
  }
  return nextResolve(specifier, context);
}
