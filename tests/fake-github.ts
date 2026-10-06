/**
 * In-process HTTP server implementing the subset of the GitHub API the tracker
 * uses, with response shapes taken from api.github.com:
 *   GET/POST /repos/:o/:r/labels[/:name]
 *   POST /repos/:o/:r/issues, GET /repos/:o/:r/issues[/:n]
 *   GET /repos/:o/:r/releases, GET /repos/:o/:r/compare/:base...:head
 *   POST /graphql (issue → linked pull requests)
 */
export type CreateMode = "ok" | "reject" | "error" | "create-then-error" | "slow-create" | "rate-limited";

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  pull_request?: object;
}

export interface FakePr {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  baseRefName?: string;
  repository?: string;
  /** Linked via the closing PR timeline event rather than a closing reference. */
  viaCloser?: boolean;
}

export interface FakeRelease {
  tag: string;
  name?: string;
  body?: string;
  prerelease?: boolean;
  draft?: boolean;
  publishedAt: string;
  /** Commits contained in the tag. */
  contains: string[];
}

export interface FakeCommit {
  sha: string;
  message: string;
  date: string;
  path: string;
}

export function startFakeGitHub(opts: { token?: string; owner?: string; name?: string; onCreate?: () => void } = {}) {
  const token = opts.token ?? "ghp_test";
  const owner = opts.owner ?? "usekaneo";
  const name = opts.name ?? "kaneo";
  const full = `${owner}/${name}`;
  const issues: FakeIssue[] = [];
  const labels = new Set<string>(["bug", "enhancement"]);
  const prs = new Map<number, FakePr[]>();
  const releases: FakeRelease[] = [];
  /** Commits reachable from each tag. */
  const history = new Map<string, FakeCommit[]>();
  let down = false;
  const createModes: CreateMode[] = [];
  const calls: string[] = [];
  let listFails = false;
  let slowMs = 400;

  const create = (input: { title: string; body: string; labels: string[] }) => {
    const now = new Date().toISOString();
    const issue: FakeIssue = { number: issues.length + 100, ...input, created_at: now, updated_at: now };
    issues.push(issue);
    return issue;
  };
  const issueJson = (i: FakeIssue) => ({
    number: i.number,
    html_url: `https://github.com/${full}/${i.pull_request ? "pull" : "issues"}/${i.number}`,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => ({ name: l })),
    created_at: i.created_at,
    updated_at: i.updated_at,
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  });
  const prNode = (pr: FakePr) => ({
    number: pr.number,
    url: `https://github.com/${pr.repository ?? full}/pull/${pr.number}`,
    state: pr.state,
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    baseRefName: pr.baseRefName ?? "main",
    mergeCommit: pr.mergeSha ? { oid: pr.mergeSha } : null,
    repository: { nameWithOwner: pr.repository ?? full },
  });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      calls.push(`${req.method} ${path}`);
      if (down) return Response.json({ message: "Service Unavailable" }, { status: 503 });
      const auth = req.headers.get("authorization");
      // Public repository: anonymous reads are allowed, writes and GraphQL need the token.
      if (auth ? auth !== `Bearer ${token}` : req.method !== "GET") return Response.json({ message: "Bad credentials" }, { status: 401 });

      if (req.method === "POST" && path === "/graphql") {
        const { variables } = (await req.json()) as { variables: { owner: string; name: string; number: number } };
        const issue = issues.find((i) => i.number === variables.number);
        if (`${variables.owner}/${variables.name}` !== full || !issue) {
          return Response.json({ data: { repository: { defaultBranchRef: { name: "main" }, issue: null } }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue" }] });
        }
        const linked = prs.get(issue.number) ?? [];
        const closer = linked.find((p) => p.viaCloser);
        return Response.json({
          data: {
            repository: {
              defaultBranchRef: { name: "main" },
              issue: {
                closedByPullRequestsReferences: { nodes: linked.filter((p) => !p.viaCloser).map(prNode) },
                timelineItems: { nodes: closer ? [{ closer: { __typename: "PullRequest", ...prNode(closer) } }] : [] },
              },
            },
          },
        });
      }

      const prefix = `/repos/${owner}/${name}`;
      if (!path.startsWith(prefix)) return Response.json({ message: "Not Found" }, { status: 404 });
      const rest = path.slice(prefix.length);

      const labelMatch = rest.match(/^\/labels\/(.+)$/);
      if (req.method === "GET" && labelMatch) {
        const label = decodeURIComponent(labelMatch[1]!);
        return labels.has(label) ? Response.json({ name: label }) : Response.json({ message: "Not Found" }, { status: 404 });
      }
      if (req.method === "POST" && rest === "/labels") {
        const body = (await req.json()) as { name: string };
        if (labels.has(body.name)) return Response.json({ message: "Validation Failed" }, { status: 422 });
        labels.add(body.name);
        return Response.json({ name: body.name }, { status: 201 });
      }

      if (req.method === "POST" && rest === "/issues") {
        const body = (await req.json()) as { title: string; body: string; labels: string[] };
        opts.onCreate?.();
        const mode = createModes.shift() ?? "ok";
        const input = { title: body.title, body: body.body, labels: body.labels };
        if (mode === "reject") return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
        if (mode === "rate-limited") {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0" } });
        }
        if (mode === "error") return Response.json({ message: "Server Error" }, { status: 502 });
        if (mode === "create-then-error") {
          create(input);
          return Response.json({ message: "Server Error" }, { status: 500 });
        }
        const issue = create(input);
        if (mode === "slow-create") await Bun.sleep(slowMs);
        return Response.json(issueJson(issue), { status: 201 });
      }

      if (req.method === "GET" && rest === "/issues") {
        if (listFails) return Response.json({ message: "Server Error" }, { status: 503 });
        const since = Date.parse(url.searchParams.get("since") ?? "1970-01-01");
        const page = Number(url.searchParams.get("page") ?? 1);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        const items = issues
          .filter((i) => Date.parse(i.updated_at) >= since)
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.number - a.number)
          .slice((page - 1) * perPage, page * perPage);
        return Response.json(items.map(issueJson));
      }

      const issueMatch = rest.match(/^\/issues\/(\d+)$/);
      if (req.method === "GET" && issueMatch) {
        const issue = issues.find((i) => i.number === Number(issueMatch[1]));
        return issue ? Response.json(issueJson(issue)) : Response.json({ message: "Not Found" }, { status: 404 });
      }

      if (req.method === "GET" && rest.startsWith("/releases")) {
        const page = Number(url.searchParams.get("page") ?? 1);
        const perPage = Number(url.searchParams.get("per_page") ?? 30);
        return Response.json(
          [...releases]
            .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
            .slice((page - 1) * perPage, page * perPage)
            .map((r) => ({
              tag_name: r.tag,
              name: r.name ?? r.tag,
              body: r.body ?? "",
              html_url: `https://github.com/${full}/releases/tag/${r.tag}`,
              prerelease: !!r.prerelease,
              draft: !!r.draft,
              published_at: r.publishedAt,
            })),
        );
      }

      if (req.method === "GET" && rest === "/commits") {
        const ref = url.searchParams.get("sha") ?? "main";
        const filePath = url.searchParams.get("path") ?? "";
        const since = Date.parse(url.searchParams.get("since") ?? "1970-01-01");
        const limit = Number(url.searchParams.get("per_page") ?? 30);
        const list = (history.get(ref) ?? [])
          .filter((c) => c.path.startsWith(filePath) && Date.parse(c.date) >= since)
          .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
          .slice(0, limit)
          .map((c) => ({ sha: c.sha, html_url: `https://github.com/${full}/commit/${c.sha}`, commit: { message: c.message } }));
        return Response.json(list);
      }

      const compare = rest.match(/^\/compare\/(.+)\.\.\.(.+)$/);
      if (req.method === "GET" && compare) {
        const release = releases.find((r) => r.tag === decodeURIComponent(compare[1]!));
        if (!release) return Response.json({ message: "Not Found" }, { status: 404 });
        const sha = decodeURIComponent(compare[2]!);
        return Response.json({ status: release.contains.includes(sha) ? "behind" : "ahead" });
      }

      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    token,
    full,
    issues,
    labels,
    releases,
    calls,
    count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length,
    queue: (...modes: CreateMode[]) => createModes.push(...modes),
    linkPr: (issueNumber: number, pr: FakePr) => {
      const list = (prs.get(issueNumber) ?? []).filter((p) => !(p.number === pr.number && (p.repository ?? full) === (pr.repository ?? full)));
      list.push(pr);
      prs.set(issueNumber, list);
    },
    setListFails: (value: boolean) => {
      listFails = value;
    },
    setHistory: (tag: string, commits: FakeCommit[]) => history.set(tag, commits),
    setDown: (value: boolean) => {
      down = value;
    },
    setSlowMs: (value: number) => {
      slowMs = value;
    },
    stop: () => server.stop(true),
  };
}
