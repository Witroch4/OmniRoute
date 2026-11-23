/**
 * Compile-time `process.arch` for cross-arch builds.
 *
 * The Docker image compiles on the build machine's own CPU (Dockerfile `build-base`) even
 * when it targets another one. Turbopack evaluates `process.arch` at compile time wherever
 * it can fold a comparison, with the BUILD machine's value: in an arm64 image built on x86,
 * `process.arch === "arm64" ? "aarch64" : "x86_64"` (src/lib/oauth/services/cursor.ts
 * detectArch) compiled to "x86_64", while the same source compiled under QEMU on arm64 gave
 * "aarch64". Value uses (`return process.arch`) are left for runtime and were unaffected.
 *
 * The Dockerfile sets OMNIROUTE_BUNDLE_TARGET_ARCH only when the target CPU differs from
 * the build machine's; next.config.mjs then defines `process.arch` for the server bundles
 * as the target's, which is what a build running on the target produced. Unset (every
 * same-arch and non-Docker build) changes nothing.
 */

const NODE_ARCH = { amd64: "x64", x64: "x64", x86_64: "x64", arm64: "arm64", aarch64: "arm64" };

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string>} entries for `compiler.defineServer` (empty when unset)
 */
export function bundleTargetArchDefines(env = process.env) {
  const raw = String(env.OMNIROUTE_BUNDLE_TARGET_ARCH ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return {};
  const arch = NODE_ARCH[raw];
  if (!arch) {
    throw new Error(
      `OMNIROUTE_BUNDLE_TARGET_ARCH=${JSON.stringify(raw)} is not supported (use amd64/x64 or arm64)`
    );
  }
  return { "process.arch": arch };
}
