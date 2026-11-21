import {
  DEPLOYMENT_ENVIRONMENTS,
  type DeploymentEnvironment,
  DRAFT_VERSION,
  type Provenance,
} from "@nikovirtala/draft-core";

// Set at build time by electron-vite's `define` (electron.vite.config.ts and build-info.ts).
declare const __DRAFT_REVISION__: string | undefined;
declare const __DRAFT_REPOSITORY__: string | undefined;

/**
 * The deployment environment: DRAFT_ENVIRONMENT when it names one (the end-to-end tests set
 * "e2e"), else "release" for a packaged app and "development" otherwise.
 */
export function deploymentEnvironment(
  env: NodeJS.ProcessEnv,
  isPackaged: boolean,
): DeploymentEnvironment {
  const named = env.DRAFT_ENVIRONMENT as DeploymentEnvironment | undefined;
  if (named !== undefined && DEPLOYMENT_ENVIRONMENTS.includes(named)) return named;
  return isPackaged ? "release" : "development";
}

/** This build's provenance. Without the build-time values (tests, a bare tsc run) it says "unknown". */
export function provenance(env: NodeJS.ProcessEnv, isPackaged: boolean): Provenance {
  return {
    version: DRAFT_VERSION,
    revision: typeof __DRAFT_REVISION__ === "string" ? __DRAFT_REVISION__ : "unknown",
    repository: typeof __DRAFT_REPOSITORY__ === "string" ? __DRAFT_REPOSITORY__ : "unknown",
    environment: deploymentEnvironment(env, isPackaged),
  };
}
