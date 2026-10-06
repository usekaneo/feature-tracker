import type { RepoConfig } from "../config";

/**
 * - rejected: GitHub refused the request; nothing was created.
 * - retryable: the request certainly did not change anything (rate limit, connection refused).
 * - ambiguous: a write may or may not have happened (timeouts, 5xx, unreadable success response).
 */
export type GitHubFailureKind = "rejected" | "retryable" | "ambiguous";

export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Issue {
  number: number;
  url: string;
}

export interface LinkedPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  mergedAt: string | null;
  baseRefName: string;
  mergeSha: string | null;
  repository: string;
}

export interface IssueProgress {
  defaultBranch: string;
  pullRequests: LinkedPullRequest[];
}

export interface Release {
  tag: string;
  url: string;
  prerelease: boolean;
  publishedAt: string | null;
}

export interface ReleaseNotes extends Release {
  name: string;
  body: string;
  draft: boolean;
}

export interface Commit {
  sha: string;
  message: string;
  url: string;
}

const PR_FIELDS = "number url state merged mergedAt baseRefName mergeCommit { oid } repository { nameWithOwner }";

/** Linked PRs (closing references and the PR that closed the issue) in one query. */
const PROGRESS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    issue(number: $number) {
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
        nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { ${PR_FIELDS} } } } }
      }
    }
  }
}`;

type RawPr = {
  number: number;
  url: string;
  state: LinkedPullRequest["state"];
  merged: boolean;
  mergedAt: string | null;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
  repository: { nameWithOwner: string };
};

/** Thin client for the GitHub REST and GraphQL APIs, scoped to one repository. */
export class GitHubClient {
  private labelReady = false;

  constructor(
    readonly config: RepoConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get repoPath() {
    return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.name)}`;
  }

  get fullName() {
    return `${this.config.owner}/${this.config.name}`;
  }

  private get graphqlUrl() {
    // GitHub Enterprise serves REST at /api/v3 and GraphQL at /api/graphql.
    return this.config.apiUrl.endsWith("/api/v3") ? this.config.apiUrl.replace(/\/api\/v3$/, "/api/graphql") : `${this.config.apiUrl}/graphql`;
  }

  private async call(method: string, url: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url.startsWith("http") ? url : `${this.config.apiUrl}${url}`, {
        method,
        headers: {
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "kaneo-feature-track",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: "follow",
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      // A refused connection never reached GitHub; anything else may have.
      const kind = code === "ECONNREFUSED" || code === "ConnectionRefused" ? "retryable" : "ambiguous";
      const reason = (error as Error).name === "TimeoutError" ? "timed out" : "network error";
      throw new GitHubError(kind, `GitHub request ${reason}`);
    }
    if (response.ok) return response;
    const detail = await response
      .json()
      .then((b: { message?: string }) => b?.message ?? "")
      .catch(() => "");
    const message = `GitHub responded ${response.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
    if (rateLimited) throw new GitHubError("retryable", message, response.status);
    if (response.status === 408 || response.status >= 500) throw new GitHubError("ambiguous", message, response.status);
    throw new GitHubError("rejected", message, response.status);
  }

  private async json<T>(response: Response, kind: GitHubFailureKind): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw new GitHubError(kind, "GitHub returned an unreadable response", response.status);
    }
  }

  /** Makes sure the issue label exists, creating it on first use. */
  async ensureLabel(): Promise<void> {
    if (this.labelReady) return;
    try {
      await this.call("GET", `${this.repoPath}/labels/${encodeURIComponent(this.config.label)}`);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
      try {
        await this.call("POST", `${this.repoPath}/labels`, {
          name: this.config.label,
          color: "1d76db",
          description: "Requested on Feature Track",
        });
      } catch (createError) {
        // 422: someone created it in the meantime.
        if (!(createError instanceof GitHubError && createError.status === 422)) throw createError;
      }
    }
    this.labelReady = true;
  }

  async createIssue(input: { title: string; body: string }): Promise<Issue> {
    const res = await this.call("POST", `${this.repoPath}/issues`, { title: input.title, body: input.body, labels: [this.config.label] });
    const issue = await this.json<{ number?: number; html_url?: string }>(res, "ambiguous");
    if (!issue.number || !issue.html_url) throw new GitHubError("ambiguous", "GitHub response is missing the issue number", res.status);
    return { number: issue.number, url: issue.html_url };
  }

  async getIssue(number: number): Promise<Issue> {
    const res = await this.call("GET", `${this.repoPath}/issues/${number}`);
    const issue = await this.json<{ number: number; html_url: string; pull_request?: unknown }>(res, "retryable");
    if (issue.pull_request) throw new GitHubError("rejected", `#${number} is a pull request, not an issue`);
    return { number: issue.number, url: issue.html_url };
  }

  /**
   * Finds an issue created after `createdAfter` whose body contains `ref`.
   * Uses the issues list (strongly consistent), not the search API, whose
   * index lags behind writes.
   */
  async findIssueByRef(ref: string, createdAfter: Date): Promise<Issue | null> {
    const since = new Date(createdAfter.getTime() - 60_000);
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        state: "all",
        sort: "created",
        direction: "desc",
        since: since.toISOString(),
        per_page: "100",
        page: String(page),
      });
      const res = await this.call("GET", `${this.repoPath}/issues?${params}`);
      const items = await this.json<{ number: number; html_url: string; body: string | null; created_at: string; pull_request?: unknown }[]>(res, "retryable");
      for (const item of items) {
        if (!item.pull_request && item.body?.includes(ref)) return { number: item.number, url: item.html_url };
      }
      const oldest = items.at(-1);
      if (items.length < 100 || !oldest || Date.parse(oldest.created_at) < since.getTime()) return null;
    }
    return null;
  }

  async getProgress(number: number): Promise<IssueProgress> {
    const res = await this.call("POST", this.graphqlUrl, {
      query: PROGRESS_QUERY,
      variables: { owner: this.config.owner, name: this.config.name, number },
    });
    const body = await this.json<{
      data?: {
        repository: {
          defaultBranchRef: { name: string } | null;
          issue: {
            closedByPullRequestsReferences: { nodes: (RawPr | null)[] };
            timelineItems: { nodes: ({ closer?: (RawPr & { __typename: string }) | null } | null)[] };
          } | null;
        } | null;
      };
      errors?: { type?: string; message: string }[];
    }>(res, "retryable");
    if (body.errors?.length) {
      const notFound = body.errors.some((e) => e.type === "NOT_FOUND");
      throw new GitHubError(notFound ? "rejected" : "retryable", `GitHub GraphQL: ${body.errors[0]!.message}`);
    }
    const repo = body.data?.repository;
    if (!repo?.issue) throw new GitHubError("rejected", `Issue #${number} not found`);
    const raw: RawPr[] = [
      ...repo.issue.closedByPullRequestsReferences.nodes.filter((n): n is RawPr => !!n),
      ...repo.issue.timelineItems.nodes.flatMap((n) => (n?.closer?.__typename === "PullRequest" ? [n.closer] : [])),
    ];
    const seen = new Set<string>();
    const pullRequests = raw
      .filter((pr) => {
        const key = `${pr.repository.nameWithOwner}#${pr.number}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((pr) => ({
        number: pr.number,
        url: pr.url,
        state: pr.state,
        merged: pr.merged,
        mergedAt: pr.mergedAt,
        baseRefName: pr.baseRefName,
        mergeSha: pr.mergeCommit?.oid ?? null,
        repository: pr.repository.nameWithOwner,
      }));
    return { defaultBranch: repo.defaultBranchRef?.name ?? "main", pullRequests };
  }

  async listReleases(): Promise<Release[]> {
    const res = await this.call("GET", `${this.repoPath}/releases?per_page=50`);
    const items = await this.json<{ tag_name: string; html_url: string; prerelease: boolean; draft: boolean; published_at: string | null }[]>(res, "retryable");
    return items.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, url: r.html_url, prerelease: r.prerelease, publishedAt: r.published_at }));
  }

  /** One page of releases, newest first, including drafts' flag and notes. */
  async listReleaseNotes(page: number, perPage = 100): Promise<ReleaseNotes[]> {
    const res = await this.call("GET", `${this.repoPath}/releases?per_page=${perPage}&page=${page}`);
    const items = await this.json<
      { tag_name: string; name: string | null; body: string | null; html_url: string; prerelease: boolean; draft: boolean; published_at: string | null }[]
    >(res, "retryable");
    return items.map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body ?? "",
      url: r.html_url,
      prerelease: r.prerelease,
      draft: r.draft,
      publishedAt: r.published_at,
    }));
  }

  /** Commits reachable from `ref` that touch `path`, newest first. */
  async listCommits(opts: { ref: string; path: string; since?: Date; limit?: number }): Promise<Commit[]> {
    const params = new URLSearchParams({ sha: opts.ref, path: opts.path, per_page: String(opts.limit ?? 100) });
    if (opts.since) params.set("since", opts.since.toISOString());
    const res = await this.call("GET", `${this.repoPath}/commits?${params}`);
    const items = await this.json<{ sha: string; html_url: string; commit: { message: string } }[]>(res, "retryable");
    return items.map((c) => ({ sha: c.sha, message: c.commit.message, url: c.html_url }));
  }

  /** True when `sha` is part of the history of `tag`. */
  async tagContains(tag: string, sha: string): Promise<boolean> {
    try {
      const res = await this.call("GET", `${this.repoPath}/compare/${encodeURIComponent(tag)}...${encodeURIComponent(sha)}`);
      const body = await this.json<{ status: string }>(res, "retryable");
      return body.status === "behind" || body.status === "identical";
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false;
      throw error;
    }
  }
}

/** Accepts `123`, `#123` or an issue URL in the configured repository. */
export function parseIssueNumber(input: string, fullName: string): number | null {
  const value = input.trim();
  const url = value.match(/^https:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);
  if (url) return url[1]!.toLowerCase() === fullName.toLowerCase() ? Number(url[2]) : null;
  const plain = value.match(/^#?(\d{1,9})$/);
  return plain ? Number(plain[1]) : null;
}
