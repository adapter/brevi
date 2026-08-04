import { errorMessage, isNetworkError } from "./util.js";

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export class ValidationError extends Error {}

/** Confirms a Linear API key works by asking the GraphQL API who it belongs to. */
export async function validateLinearApiKey(apiKey: string): Promise<LinearViewer> {
  let res: Response;
  try {
    res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query: "{ viewer { id name email } }" }),
    });
  } catch (err) {
    throw new ValidationError(
      isNetworkError(err)
        ? "Could not reach api.linear.app — check your network connection."
        : `Request to Linear failed: ${errorMessage(err)}`,
    );
  }

  if (res.status === 401) {
    throw new ValidationError("Linear rejected that API key (unauthorized).");
  }
  if (!res.ok) {
    throw new ValidationError(`Linear API returned HTTP ${res.status}.`);
  }

  const json = (await res.json()) as {
    data?: { viewer?: LinearViewer };
    errors?: Array<{ message: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    throw new ValidationError(`Linear API error: ${json.errors[0]?.message}`);
  }
  if (!json.data?.viewer) {
    throw new ValidationError("Linear API returned an unexpected response.");
  }
  return json.data.viewer;
}

export interface GitHubUser {
  login: string;
}

/** Confirms a GitHub token works by asking the REST API who it belongs to. */
export async function validateGitHubToken(token: string): Promise<GitHubUser> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "brevi-cli",
      },
    });
  } catch (err) {
    throw new ValidationError(
      isNetworkError(err)
        ? "Could not reach api.github.com — check your network connection."
        : `Request to GitHub failed: ${errorMessage(err)}`,
    );
  }

  if (res.status === 401) {
    throw new ValidationError("GitHub rejected that token (unauthorized).");
  }
  if (!res.ok) {
    throw new ValidationError(`GitHub API returned HTTP ${res.status}.`);
  }

  const json = (await res.json()) as GitHubUser;
  if (!json.login) {
    throw new ValidationError("GitHub API returned an unexpected response.");
  }
  return json;
}
