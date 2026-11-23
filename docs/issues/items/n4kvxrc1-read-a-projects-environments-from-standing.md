# Read a project's environments from standing

## Goal
A project's environments, and which follow which, are read from standing, a given with a decision behind it and a tripwire, instead of from GitHub and the deployment package's configuration.

## Notes
- ?73 keeps the topology in one shape (environments.ts, EnvironmentTopology) and reads it from GitHub's environments API and the root deploy.toml. Neither says what follows what, so every environment stands alone today and only a standing item can say staging then production, or regions in parallel.
- @nikovirtala/deployment's design leaves several environments per project open (docs/04-deployment-v1.md, Q3: one deploy.toml per environment, or environments inside one file).

## Done when
- The topology is a standing item: accepted by a person, with its decision and a tripwire, and ArkRecords' readers feed intake instead of the map.
- A fixture with staging then production, and one with regions in parallel, draws the rows in that order.
