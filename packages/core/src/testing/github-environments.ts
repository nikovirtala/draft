/**
 * What GitHub's `GET /repos/{owner}/{repo}/environments` answers (the shape the REST reference
 * documents): a repository with a `staging` environment that waits 30 minutes, a `production`
 * that needs a reviewer, and two regions of production. Only `name` is read; the rest is here so
 * the fixture is the real response, not a list of names.
 */
export const GITHUB_ENVIRONMENTS_RESPONSE = {
  total_count: 4,
  environments: [
    {
      id: 161088068,
      node_id: "MDExOkVudmlyb25tZW50MTYxMDg4MDY4",
      name: "staging",
      url: "https://api.github.com/repos/nikovirtala/kiro-remote/environments/staging",
      html_url:
        "https://github.com/nikovirtala/kiro-remote/deployments/activity_log?environments_filter=staging",
      created_at: "2026-10-02T08:14:03Z",
      updated_at: "2026-10-02T08:14:03Z",
      can_admins_bypass: true,
      protection_rules: [
        { id: 3736, node_id: "MDQ6R2F0ZTM3MzY=", type: "wait_timer", wait_timer: 30 },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    {
      id: 161088069,
      node_id: "MDExOkVudmlyb25tZW50MTYxMDg4MDY5",
      name: "production",
      url: "https://api.github.com/repos/nikovirtala/kiro-remote/environments/production",
      html_url:
        "https://github.com/nikovirtala/kiro-remote/deployments/activity_log?environments_filter=production",
      created_at: "2026-10-02T08:14:41Z",
      updated_at: "2026-10-09T11:02:17Z",
      can_admins_bypass: false,
      protection_rules: [
        {
          id: 3755,
          node_id: "MDQ6R2F0ZTM3NTU=",
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [{ type: "User", reviewer: { login: "nikovirtala", id: 1, type: "User" } }],
        },
        { id: 3756, node_id: "MDQ6R2F0ZTM3NTY=", type: "branch_policy" },
      ],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    },
    {
      id: 161088070,
      node_id: "MDExOkVudmlyb25tZW50MTYxMDg4MDcw",
      name: "production-eu",
      url: "https://api.github.com/repos/nikovirtala/kiro-remote/environments/production-eu",
      html_url:
        "https://github.com/nikovirtala/kiro-remote/deployments/activity_log?environments_filter=production-eu",
      created_at: "2026-11-03T09:00:00Z",
      updated_at: "2026-11-03T09:00:00Z",
      can_admins_bypass: true,
      protection_rules: [],
      deployment_branch_policy: null,
    },
    {
      id: 161088071,
      node_id: "MDExOkVudmlyb25tZW50MTYxMDg4MDcx",
      name: "production-us",
      url: "https://api.github.com/repos/nikovirtala/kiro-remote/environments/production-us",
      html_url:
        "https://github.com/nikovirtala/kiro-remote/deployments/activity_log?environments_filter=production-us",
      created_at: "2026-11-03T09:00:10Z",
      updated_at: "2026-11-03T09:00:10Z",
      can_admins_bypass: true,
      protection_rules: [],
      deployment_branch_policy: null,
    },
  ],
} as const;
