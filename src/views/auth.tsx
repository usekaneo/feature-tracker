import type { Child } from "hono/jsx";
import { Field } from "./components";
import { Layout } from "./layout";

function AuthShell(props: { title: string; children: Child }) {
  return (
    <Layout title={props.title} viewer={null} csrf={null} noindex>
      <div class="mx-auto max-w-sm pt-6">
        <h1 class="mb-5 text-base font-semibold">{props.title}</h1>
        {props.children}
      </div>
    </Layout>
  );
}

function Message(props: { error?: string; notice?: string }) {
  if (props.error) return <p class="mb-4 rounded-md border border-danger/30 px-3 py-2 text-sm text-danger" role="alert">{props.error}</p>;
  if (props.notice) return <p class="notice mb-4">{props.notice}</p>;
  return null;
}

export function LoginPage(props: { next: string; github: boolean; email?: string; error?: string; notice?: string }) {
  const nextQs = props.next !== "/" ? `?next=${encodeURIComponent(props.next)}` : "";
  return (
    <AuthShell title="Sign in">
      <Message error={props.error} notice={props.notice} />
      {props.github && (
        <>
          <form method="post" action="/login/github">
            <input type="hidden" name="next" value={props.next} />
            <button type="submit" class="btn w-full">
              <svg viewBox="0 0 16 16" class="size-4" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                />
              </svg>
              Continue with GitHub
            </button>
          </form>
          <div class="my-5 flex items-center gap-3 text-xs text-muted">
            <span class="h-px flex-1 bg-line" />
            or
            <span class="h-px flex-1 bg-line" />
          </div>
        </>
      )}
      <form method="post" action="/login" class="space-y-3">
        <input type="hidden" name="next" value={props.next} />
        <Field label="Email" name="email">
          <input id="email" name="email" type="email" class="input" value={props.email ?? ""} autocomplete="email" required />
        </Field>
        <Field label="Password" name="password">
          <input id="password" name="password" type="password" class="input" autocomplete="current-password" required />
        </Field>
        <button type="submit" class="btn btn-primary w-full">
          Sign in
        </button>
      </form>
      <div class="mt-4 flex justify-between text-xs">
        <a href={`/register${nextQs}`} class="link">
          Create account
        </a>
        <a href="/forgot-password" class="link text-muted">
          Forgot password?
        </a>
      </div>
    </AuthShell>
  );
}

export function RegisterPage(props: { next: string; name?: string; email?: string; error?: string }) {
  return (
    <AuthShell title="Create account">
      <Message error={props.error} />
      <form method="post" action="/register" class="space-y-3">
        <input type="hidden" name="next" value={props.next} />
        <Field label="Name" name="name">
          <input id="name" name="name" class="input" value={props.name ?? ""} maxlength={60} autocomplete="name" required />
        </Field>
        <Field label="Email" name="email">
          <input id="email" name="email" type="email" class="input" value={props.email ?? ""} autocomplete="email" required />
        </Field>
        <Field label="Password" name="password" hint="At least 8 characters.">
          <input id="password" name="password" type="password" class="input" minlength={8} maxlength={128} autocomplete="new-password" required />
        </Field>
        <button type="submit" class="btn btn-primary w-full">
          Create account
        </button>
      </form>
      <p class="mt-4 text-xs">
        <a href="/login" class="link">
          Already have an account?
        </a>
      </p>
    </AuthShell>
  );
}

export function CheckEmailPage(props: { email: string }) {
  return (
    <AuthShell title="Check your email">
      <p>
        We sent a verification link to <span class="font-medium">{props.email}</span>.
      </p>
      <p class="mt-4 text-xs">
        <a href="/login" class="link">
          Back to sign in
        </a>
      </p>
    </AuthShell>
  );
}

export function ForgotPasswordPage(props: { sent?: boolean; error?: string }) {
  return (
    <AuthShell title="Reset password">
      {props.sent ? (
        <p class="notice">If an account exists for that email, we sent a reset link.</p>
      ) : (
        <>
          <Message error={props.error} />
          <form method="post" action="/forgot-password" class="space-y-3">
            <Field label="Email" name="email">
              <input id="email" name="email" type="email" class="input" autocomplete="email" required />
            </Field>
            <button type="submit" class="btn btn-primary w-full">
              Send reset link
            </button>
          </form>
        </>
      )}
      <p class="mt-4 text-xs">
        <a href="/login" class="link">
          Back to sign in
        </a>
      </p>
    </AuthShell>
  );
}

export function ResetPasswordPage(props: { token: string; error?: string }) {
  if (!props.token) {
    return (
      <AuthShell title="Reset password">
        <p class="notice">This reset link is invalid or expired.</p>
        <p class="mt-4 text-xs">
          <a href="/forgot-password" class="link">
            Request a new link
          </a>
        </p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Choose a new password">
      <Message error={props.error} />
      <form method="post" action="/reset-password" class="space-y-3">
        <input type="hidden" name="token" value={props.token} />
        <Field label="New password" name="password" hint="At least 8 characters.">
          <input id="password" name="password" type="password" class="input" minlength={8} maxlength={128} autocomplete="new-password" required />
        </Field>
        <button type="submit" class="btn btn-primary w-full">
          Save password
        </button>
      </form>
    </AuthShell>
  );
}
