import type { Dispatch, SetStateAction } from 'react';
import { browserCsrfHeader, browserFetch } from '../../lib/auth/browser-auth';
import type { AccessGrant, CandidateForm } from './authentication-access-types';

type ActionsOptions = {
  candidate: CandidateForm;
  inviteEmail: string;
  inviteRole: 'administrator' | 'viewer';
  reloadAccessData: () => Promise<void>;
  setAuthorizationUrl: Dispatch<SetStateAction<string | undefined>>;
  setConfigurationMessage: Dispatch<SetStateAction<string | undefined>>;
  setError: Dispatch<SetStateAction<string | undefined>>;
  setInvitationUrl: Dispatch<SetStateAction<string | undefined>>;
  setReauthenticationRequired: Dispatch<SetStateAction<boolean>>;
  setReceipt: Dispatch<SetStateAction<string | undefined>>;
  showReceipt: (message: string) => void;
};

export function useAuthenticationAccessActions(options: ActionsOptions) {
  const {
    candidate,
    inviteEmail,
    inviteRole,
    reloadAccessData,
    setAuthorizationUrl,
    setConfigurationMessage,
    setError,
    setInvitationUrl,
    setReauthenticationRequired,
    setReceipt,
    showReceipt,
  } = options;
  const request = (path: string, init: RequestInit = {}) =>
    browserFetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...browserCsrfHeader(),
        ...init.headers,
      },
    });
  const authorizeBrowser = async () => {
    setError(undefined);
    const response = await request('/ui/api/auth/local/authorize', {
      method: 'POST',
    });
    const body = await response.json();
    if (!response.ok || typeof body.authorizationUrl !== 'string')
      return setError(
        body.error?.message ?? 'Unable to create an authorization link.',
      );
    setAuthorizationUrl(body.authorizationUrl);
  };
  const createInvitation = async () => {
    setError(undefined);
    setReceipt(undefined);
    const response = await request('/ui/api/auth/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const body = await response.json();
    if (!response.ok || typeof body.invitationUrl !== 'string')
      return setError(body.error?.message ?? 'Unable to create an invitation.');
    setInvitationUrl(body.invitationUrl);
    showReceipt(body.message);
    await reloadAccessData();
  };
  const revokeInvitation = async (id: string) => {
    setError(undefined);
    const response = await request(`/ui/api/auth/invitations/${id}`, {
      method: 'DELETE',
    });
    const body = await response.json();
    if (!response.ok)
      return setError(
        body.error?.message ?? 'Unable to revoke this invitation.',
      );
    showReceipt(body.message);
    await reloadAccessData();
  };
  const configureOidc = async (action: 'test' | 'activate') => {
    setError(undefined);
    const response = await request(`/ui/api/auth/config/${action}`, {
      method: 'POST',
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      return setError(
        body.error?.message ?? 'Unable to update sign-in configuration.',
      );
    }
    if (typeof body.redirectUrl === 'string')
      return window.location.assign(body.redirectUrl);
    setConfigurationMessage(body.message);
  };
  const saveCandidate = async () => {
    setError(undefined);
    const response = await request('/ui/api/auth/config/candidate', {
      method: 'PUT',
      body: JSON.stringify(candidate),
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      return setError(
        body.error?.message ?? 'Unable to save sign-in configuration.',
      );
    }
    setConfigurationMessage(body.message);
  };
  const updateAccess = async (
    id: string,
    change: Partial<Pick<AccessGrant, 'role' | 'status'>>,
  ) => {
    setError(undefined);
    setReauthenticationRequired(false);
    const response = await request(`/ui/api/auth/access/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(change),
    });
    const body = await response.json();
    if (!response.ok) {
      setReauthenticationRequired(
        body.error?.code === 'REAUTHENTICATION_REQUIRED',
      );
      return setError(
        body.error?.message ?? 'Unable to update console access.',
      );
    }
    showReceipt(body.message);
    await reloadAccessData();
  };
  const revokeSession = async (id: string) => {
    setError(undefined);
    const response = await request(`/ui/api/auth/sessions/${id}/revoke`, {
      method: 'POST',
    });
    const body = await response.json();
    if (!response.ok)
      return setError(
        body.error?.message ?? 'Unable to revoke this browser session.',
      );
    showReceipt(body.message);
    await reloadAccessData();
  };
  return {
    authorizeBrowser,
    configureOidc,
    createInvitation,
    revokeInvitation,
    revokeSession,
    saveCandidate,
    updateAccess,
  };
}
