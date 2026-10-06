import { Layout, type PageProps } from "./layout";

// Adapted from https://kaneo.app/privacy for the feature-request tracker.
export function PrivacyPage(props: Pick<PageProps, "viewer" | "csrf" | "canonical">) {
  return (
    <Layout {...props} title="Privacy Policy" path="/privacy" description="How Kaneo Feature Track handles account data, public requests, comments, and notifications.">
      <article class="mx-auto max-w-2xl pt-8 sm:pt-12">
        <header class="mb-8">
          <p class="mb-2 text-xs text-muted">Legal</p>
          <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">Privacy Policy</h1>
          <p class="mt-3 text-xs text-muted">Last updated: October 6, 2026</p>
        </header>
        <div class="prose-ft [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold">
          <p>
            This policy describes how Kaneo Feature Track, our public issue and feature-request tracker, handles your data.
            The service is operated by Andrej Acevski (sole proprietor, North Macedonia), referred to as “we” below.
            If you host your own copy of the tracker, its operator is responsible for how that instance handles data.
          </p>
          <h2>Data we collect</h2>
          <p>
            <strong>Account data.</strong> When you create an account we store your name, email address, and a securely hashed password.
            If GitHub sign-in is available and you choose to use it, we receive the account and basic profile information GitHub shares, such as your avatar.
            We never receive your GitHub password.
          </p>
          <p>
            <strong>Tracker activity.</strong> We store the requests and comments you submit, your votes, followed requests, notification preferences,
            and notifications. Reports and moderation records are stored to help maintain the community.
          </p>
          <p>
            <strong>Public content.</strong> Requests, comments, your display name alongside them, and vote totals are visible to other visitors,
            including people without an account. Public requests may also appear in the RSS feed and search engines.
            Your account email address is not displayed publicly. Please keep passwords, private information, and confidential details out of your posts.
          </p>
          <p>
            <strong>Technical data.</strong> We process IP addresses for abuse prevention and store session information, including IP addresses and browser
            user agents, to manage sign-in. Request and error logs help us operate the tracker and troubleshoot failures.
          </p>
          <p>
            The tracker does not use advertising or analytics trackers.
          </p>
          <h2>How we use data</h2>
          <p>
            We use your data to operate your account, publish and discuss requests, record votes, send verification and password-reset emails,
            provide support, and keep the community secure. Submitting, voting on, or commenting on a request automatically follows it.
            You can unfollow requests and manage status-update and comment emails in your notification settings.
            We do not sell your data or use it for advertising.
          </p>
          <p>
            We process account and activity data to provide the service you request, and security and moderation data for our legitimate interests
            in preventing abuse and keeping the tracker reliable. Where processing relies on consent, you can withdraw it at any time.
          </p>
          <h2>Service providers and integrations</h2>
          <ul>
            <li>Hosting and backup providers process stored tracker data; our email provider processes recipient addresses and the emails we send.</li>
            <li>
              GitHub handles optional sign-in and issue tracking. When the integration is enabled and a maintainer accepts a request,
              its title, description, and tracker link may be copied to a GitHub issue and become public there.
            </li>
            <li>
              When automated labeling is enabled, OpenRouter or TypeSafe receives the request title, up to the first 12,000 characters of its description,
              project context, and area label names to suggest categories and priorities. Account details, comments, and votes are not included in this
              submission, but personal information you put in a title or description will be included. Maintainers can review and override these labels;
              accepting or declining a request is a maintainer decision.
            </li>
          </ul>
          <p>
            Providers may process data outside North Macedonia. Applicable data-protection rules govern those transfers.
            Contact <a href="mailto:support@kaneo.app">support@kaneo.app</a> for information about our current providers, processing locations,
            and transfer safeguards.
          </p>
          <h2>Your rights</h2>
          <p>
            You can request access to, correction, deletion, or a copy of your personal data, and object to or request restriction of processing where
            applicable. Email <a href="mailto:support@kaneo.app">support@kaneo.app</a> to exercise these rights; we will respond within 30 days.
            You may lodge a complaint with North Macedonia’s <a href="https://azlp.mk/en/">Personal Data Protection Agency</a>,
            or another competent data-protection authority. Where the GDPR applies, you also have the rights it provides.
          </p>
          <h2>Retention and deletion</h2>
          <p>
            We keep account data while your account is active and retain public discussions to maintain the history of requests.
            Notifications are normally removed after 180 days, and sign-in sessions expire after 30 days unless renewed.
            Hiding a post through moderation does not delete its stored data.
          </p>
          <p>
            To request account deletion or removal of personal information from posts, email <a href="mailto:support@kaneo.app">support@kaneo.app</a>.
            We will explain any information we must retain for legal or security reasons and how backup retention affects your request.
            Copies of public posts held by GitHub, search engines, or other visitors may need to be addressed separately.
          </p>
          <h2>Cookies and browser storage</h2>
          <p>
            The tracker uses essential cookies for sign-in and authentication security. Your light or dark theme preference is stored locally in your
            browser until you change it or clear browser storage. There are no advertising or cross-site tracking cookies.
          </p>
          <h2>Changes and contact</h2>
          <p>
            We will update this page and its revision date when the policy changes. We will notify users of material changes as required by applicable law.
            Questions? Contact <a href="mailto:support@kaneo.app">support@kaneo.app</a>.
          </p>
        </div>
      </article>
    </Layout>
  );
}
