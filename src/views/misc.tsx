import type { Viewer } from "../http";
import type { SentMail } from "../lib/mailer";
import { Time } from "./components";
import { CsrfField, Layout } from "./layout";

export function MessagePage(props: { viewer: Viewer | null; csrf: string | null; title: string; message: string }) {
  return (
    <Layout title={props.title} viewer={props.viewer} csrf={props.csrf} noindex>
      <div class="py-16 text-center">
        <h1 class="text-base font-semibold">{props.title}</h1>
        <p class="mt-1 text-muted">{props.message}</p>
        <p class="mt-4">
          <a href="/" class="link">
            All requests
          </a>
        </p>
      </div>
    </Layout>
  );
}

export function LabelsPage(props: {
  viewer: Viewer;
  csrf: string | null;
  labels: { id: number; name: string; count: number }[];
  error?: string;
}) {
  return (
    <Layout title="Labels" viewer={props.viewer} csrf={props.csrf} noindex>
      <h1 class="mb-4 text-base font-semibold">Labels</h1>
      <form method="post" action="/labels" class="flex gap-2">
        <CsrfField token={props.csrf} />
        <input name="name" class="input" placeholder="New label" maxlength={32} required aria-label="Label name" />
        <button type="submit" class="btn btn-primary">
          Add
        </button>
      </form>
      {props.error && <p class="error">{props.error}</p>}
      <ul class="mt-4 divide-y divide-line border-y border-line">
        {props.labels.length === 0 && <li class="py-3 text-muted">No labels yet.</li>}
        {props.labels.map((l) => (
          <li class="flex items-center gap-3 py-2">
            <span class="chip">{l.name}</span>
            <span class="text-xs text-muted">
              {l.count} {l.count === 1 ? "request" : "requests"}
            </span>
            <form method="post" action={`/labels/${l.id}/delete`} class="ml-auto">
              <CsrfField token={props.csrf} />
              <button type="submit" class="btn-link">
                Delete
              </button>
            </form>
          </li>
        ))}
      </ul>
    </Layout>
  );
}

export function DevMailPage(props: { viewer: Viewer | null; csrf: string | null; mails: SentMail[] }) {
  return (
    <Layout title="Dev mailbox" viewer={props.viewer} csrf={props.csrf} noindex>
      <h1 class="mb-1 text-base font-semibold">Dev mailbox</h1>
      <p class="mb-4 text-xs text-muted">Development only. Emails sent since the server started.</p>
      {props.mails.length === 0 && <p class="text-muted">No emails yet.</p>}
      <div class="divide-y divide-line">
        {props.mails.map((m) => (
          <article class="py-3">
            <div class="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted">
              <span class="font-medium text-ink">{m.subject}</span>
              <span>to {m.to}</span>
              <span class="ml-auto">
                <Time date={m.sentAt} />
              </span>
            </div>
            <pre class="mt-1 font-sans text-sm whitespace-pre-wrap break-all">
              {m.text.split(/(https?:\/\/\S+)/g).map((part) =>
                /^https?:\/\//.test(part) ? (
                  <a href={part} class="link">
                    {part}
                  </a>
                ) : (
                  part
                ),
              )}
            </pre>
          </article>
        ))}
      </div>
    </Layout>
  );
}
