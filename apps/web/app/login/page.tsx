import { X } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';
import { auth, getConfiguredAuthProviders, signIn } from '../../auth';

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly error?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) {
    redirect('/projects');
  }
  const providers = getConfiguredAuthProviders();
  const params = await searchParams;
  const loginError =
    params?.error === 'CredentialsSignin'
      ? 'メールアドレスまたはパスワードが違います。'
      : undefined;

  return (
    <main className="login-page">
      <section className="login-panel" data-testid="login-panel">
        <Link
          aria-label="ログインを閉じる"
          className="modal-close-button"
          data-testid="login-close-button"
          href="/projects"
        >
          <X size={18} />
        </Link>
        <p className="eyebrow">Pufu Lens</p>
        <h1>ログイン</h1>
        <p>参加している project、private report、管理 UI を開くにはログインしてください。</p>
        {loginError ? (
          <p className="notice error" data-testid="credentials-login-error">
            {loginError}
          </p>
        ) : null}
        <form
          action={async (formData) => {
            'use server';
            try {
              await signIn('credentials', formData);
            } catch (error) {
              if (error instanceof AuthError && error.type === 'CredentialsSignin') {
                redirect('/login?error=CredentialsSignin');
              }
              throw error;
            }
          }}
          className="credentials-form"
          data-testid="credentials-login-form"
        >
          <input name="redirectTo" type="hidden" value="/projects" />
          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              data-testid="credentials-email-input"
              name="email"
              required
              type="email"
            />
          </label>
          <label>
            <span>Password</span>
            <input
              autoComplete="current-password"
              data-testid="credentials-password-input"
              name="password"
              required
              type="password"
            />
          </label>
          <button className="primary-button" data-testid="credentials-login-button" type="submit">
            Email でログイン
          </button>
        </form>
        <div className="login-actions">
          {providers.map((provider) => (
            <form
              action={async () => {
                'use server';
                await signIn(provider.id, { redirectTo: '/projects' });
              }}
              key={provider.id}
            >
              <button
                className="primary-button"
                data-testid={`login-${provider.id}-button`}
                type="submit"
              >
                {provider.name} でログイン
              </button>
            </form>
          ))}
        </div>
      </section>
    </main>
  );
}
