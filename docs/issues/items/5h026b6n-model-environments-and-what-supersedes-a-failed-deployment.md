# Model environments and what supersedes a failed deployment

## Goal
draft understands a project's environments, so a deployment that fixes a failed one is matched to the right environment, also when environments run in sequence or in parallel.

## Notes
- Niko's feedback after using draft on 23 Nov 2026. The first step is in (PR #32): a later successful deployment of the same repository and environment settles a failed one. That assumes one linear environment.
- Environments are standing: a project's topology (staging then production in sequence, regions in parallel) holds until a decision changes it, with a tripwire, and is imported from where it lives (GitHub environments, the deployment package's configuration).
- Supersession is a typed edge, from the deployment that fixes to the one it fixes, in the environment the topology names; the map draws it like any other edge.

## Done when
- Fixtures with one environment, two in sequence and two in parallel each settle a failure only by a success in its own environment, through a supersedes edge; the topology is read as data from where it lives (GitHub's environments, the deployment package's configuration), in one shape a standing store can take over (the standing store itself is the follow-up n4kvxrc1).
