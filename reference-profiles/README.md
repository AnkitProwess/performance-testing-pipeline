# Reference profiles

Worked examples of load profiles for the real APIs this tooling was built against. **The pipeline does not read this folder.**

- The pipeline reads profiles from the repository given in the `apiRepoUrl` run parameter (Azure DevOps and Jenkins), in the folder `apiName` and the file `profileName`. Edits here change nothing until the same file is in that repository.
- For a starting point for a new profile use [`../templates/`](../templates/) (placeholders for host and credentials). This folder shows the same shapes filled in.
- Profile layout and every field: section 3 of the main [README](../README.md).

| Folder | Profiles |
|---|---|
| `AI_innovation_poc1/` | `load-profile-advanced.json` (client ID in headers, original format) and `load-profile2` to `load-profile7`: OAuth 2.0, client ID, Basic, multi-endpoint with PUT, parallel batch. From `load-profile2` on they use the `authType` / `authParameters` layout. |
| `mule-employees-xapi/` | `load-profile-advanced.json`: two endpoints in the original header-based format |

Credentials are never written in a profile: `{{CLIENT_ID}}`, `{{OAUTH_CLIENT_SECRET}}` and similar tokens are filled from the CI tool's secret store at run time. The only literal values are public dummy values.
