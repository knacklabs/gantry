import { googleSignInIcon } from '../../assets/auth';
import { Button } from '../../ui/primitives/button';

export function GoogleSignInButton() {
  return (
    <Button
      aria-label="Sign in with Google"
      className="auth-google-sign-in-button"
      onClick={() => window.location.assign('/auth/oidc/start')}
    >
      <img alt="" src={googleSignInIcon} />
    </Button>
  );
}
