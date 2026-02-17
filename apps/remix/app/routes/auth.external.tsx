import { useEffect, useState } from 'react';

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { redirect, useNavigate } from 'react-router';

import { useOptionalSession } from '@documenso/lib/client-only/providers/session';
import { Button } from '@documenso/ui/primitives/button';
import { useToast } from '@documenso/ui/primitives/use-toast';

import type { Route } from './+types/auth.external';

type ExchangeTokenResponse = {
  redirectUrl?: string;
  documentsUrl?: string;
};

const parseExchangeTokenResponse = (payload: unknown): ExchangeTokenResponse => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const redirectUrl = Reflect.get(payload, 'redirectUrl');
  const documentsUrl = Reflect.get(payload, 'documentsUrl');

  return {
    redirectUrl: typeof redirectUrl === 'string' ? redirectUrl : undefined,
    documentsUrl: typeof documentsUrl === 'string' ? documentsUrl : undefined,
  };
};

export const loader = ({ request }: Route.LoaderArgs) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    throw redirect('/signin');
  }

  return { token };
};

export default function AuthExternalPage({ loaderData }: Route.ComponentProps) {
  const { token } = loaderData;
  const { refreshSession } = useOptionalSession();
  const { _ } = useLingui();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const exchangeToken = async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/auth/external/exchange-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message = payload?.message ?? _(msg`Authentication failed`);
        throw new Error(message);
      }

      const data = parseExchangeTokenResponse(await response.json());

      await refreshSession();

      const targetUrl = data.documentsUrl ?? data.redirectUrl ?? '/';

      window.location.replace(targetUrl);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : _(msg`We were unable to complete authentication.`);

      setErrorMessage(message);

      toast({
        title: _(msg`Something went wrong`),
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void exchangeToken();
  }, []);

  if (isLoading) {
    return (
      <div className="yc-auth-external mx-auto flex h-[70vh] w-full max-w-md flex-col items-center justify-center">
        <Loader className="h-8 w-8 animate-spin text-[#247aed]" />
        <p className="mt-4 text-sm text-[#595958]">
          <Trans>Signing you in...</Trans>
        </p>
      </div>
    );
  }

  return (
    <div className="yc-auth-external mx-auto flex h-[70vh] w-full max-w-md flex-col items-center justify-center">
      <h1 className="text-2xl font-semibold text-[#302f2e]">
        <Trans>Unable to sign you in</Trans>
      </h1>
      <p className="mt-2 text-sm text-[#595958]">
        {errorMessage ? errorMessage : <Trans>Please try again.</Trans>}
      </p>
      <Button
        className="mt-6 rounded-2xl"
        onClick={() => {
          void navigate('/');
        }}
      >
        <Trans>Go home</Trans>
      </Button>
    </div>
  );
}
